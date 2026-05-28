import { hostname, platform, release } from 'os'
import { writeFileSync, mkdirSync, watch as fsWatch, existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { scanAll, scanRoots } from './repo-scanner'
import { cloneRepo, pullRepo, pullLocal, checkoutBranch, listBranches, isDirty } from './git-ops'
import { ProcessManager, type ProcState } from './process-manager'
import { scanAllCommands } from './commands-scanner'
import { getHandler, nativeSupervisorCommands } from './commands/index'
import { CONFIG_PATH, saveConfig, type SupervisorConfig } from './config'

// Keep in sync with supervisor/tauri/src-tauri/tauri.conf.json version
const VERSION = '0.5.5'

type OutboundMsg =
  | { type: 'auth'; api_key: string; project_dir: string; hostname: string; role: 'supervisor' }
  | { type: 'supervisor.hello'; version: string; os: string; hostname: string; roots: string[]; capabilities: string[]; allow_dangerous_skip_permissions: boolean; restrict_to_git: boolean; max_concurrent: number; audit_log_enabled: boolean }
  | { type: 'supervisor.state'; state: ProcState; run_id?: string | null; repo_path?: string | null; pid?: number | null; restart_count?: number; last_exit?: any }
  | { type: 'supervisor.log'; level: string; message: string; run_id?: string; ts?: string }
  | { type: 'repo.scan_result'; req_id: string; repos: any[] }
  | { type: 'repo.op_result'; req_id: string; op: string; ok: boolean; error?: string; data?: any }
  | { type: 'repo.clone_progress'; req_id: string; stage: string; percent?: number }
  | { type: 'supervisor.commands_sync'; commands: Array<{ kind: 'command' | 'skill'; name: string; description: string | null; source: string; path: string }> }
  | { type: 'supervisor.repo_inventory'; scanned_at: string; repos: Array<{ local_path: string; is_git_repo: boolean; is_worktree: boolean; worktree_parent_path: string | null; git_remote: string | null; git_origin_github: { owner: string; repo: string } | null; branch?: string | null; canonical?: boolean }> }
  | { type: 'run_started'; run_id: string }
  | { type: 'run_output'; run_id: string; chunk: string }
  | { type: 'run_finished'; run_id: string; exit_code?: number | null; duration_ms?: number; snippet?: string; error?: string }
  | { type: 'supervisor.set_roots_ack'; req_id: string; ok: boolean; applied_roots?: string[]; error?: string }
  | { type: 'pong' }

export class SupervisorClient {
  private ws: WebSocket | null = null
  private cfg: SupervisorConfig
  private authenticated = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pm: ProcessManager

  /** Phase 08 §15 — fs.watch handle on supervisor.json so Tauri "Rescan now"
   * (which nulls `last_scan_at`) triggers a fresh inventory emission. */
  private configWatcher: ReturnType<typeof fsWatch> | null = null

  constructor(cfg: SupervisorConfig) {
    this.cfg = cfg
    // Watch supervisor.json for external edits (Tauri Roots panel writes here
    // when the user adds/removes roots or clicks "Rescan now").
    try {
      const cfgPath = CONFIG_PATH
      if (existsSync(cfgPath)) {
        this.configWatcher = fsWatch(cfgPath, { persistent: false }, () => {
          // Coalesce rapid double-fires.
          if ((this as any)._cfgReloadTimer) return
          ;(this as any)._cfgReloadTimer = setTimeout(() => {
            ;(this as any)._cfgReloadTimer = null
            this.onConfigChanged()
          }, 250)
        })
      }
    } catch (err: any) {
      // Non-fatal — fall back to "next reconnect" cadence.
      // eslint-disable-next-line no-console
      console.warn('[hub-client] config watch failed:', err?.message ?? err)
    }
    this.pm = new ProcessManager({
      onStateChange: (state, info) => {
        this.send({
          type: 'supervisor.state',
          state,
          run_id: info.runId ?? null,
          repo_path: info.repoPath ?? null,
          pid: info.pid ?? null,
          restart_count: info.restartCount ?? 0,
          last_exit: info.lastExit,
        })
      },
      onLog: (level, message, runId) => {
        this.log(level, message, runId)
      },
    }, cfg)
  }

  /** Detach handlers + close any prior socket so reconnects don't leak listeners. */
  private detachSocket(ws: WebSocket | null) {
    if (!ws) return
    try { ws.onopen = null as any } catch {}
    try { ws.onmessage = null as any } catch {}
    try { ws.onclose = null as any } catch {}
    try { ws.onerror = null as any } catch {}
    try { if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) ws.close() } catch {}
  }

  connect() {
    // Clean up any previous socket before reassigning — otherwise the old socket's
    // event handlers keep closures (and this.cfg references) alive forever on reconnect.
    this.detachSocket(this.ws)
    this.ws = null

    const wsUrl = this.cfg.hubUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/agent'
    this.log('info', `connecting to ${wsUrl}`)
    let ws: WebSocket
    try {
      ws = new WebSocket(wsUrl)
    } catch (err: any) {
      this.log('error', `WebSocket construct failed: ${err.message}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return // stale handler from a replaced socket
      this.reconnectAttempts = 0
      this.send({
        type: 'auth',
        api_key: this.cfg.apiKey,
        project_dir: '__supervisor__',
        hostname: hostname(),
        role: 'supervisor',
      })
    }
    ws.onmessage = (event) => {
      if (this.ws !== ws) return
      let msg: any
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as any)) } catch { return }
      this.handleMessage(msg)
    }
    ws.onclose = (ev) => {
      if (this.ws !== ws) return // a newer socket has taken over
      this.authenticated = false
      const code = (ev as any)?.code as number | undefined
      const reason = (ev as any)?.reason as string | undefined
      this.log('warn', `WebSocket closed code=${code ?? '?'} reason=${reason || '(none)'}`)
      this.detachSocket(ws)
      this.ws = null
      // Hub-issued auth failures (4001 invalid key) and explicit user disconnect
      // (4002) shouldn't burn through retry budget — the credential or session
      // state won't change in seconds. Park for 5 minutes so the supervisor
      // logs loudly without flooding the hub. If the operator fixes the key
      // or re-enables the session, the next attempt picks up cleanly.
      if (code === 4001 || code === 4002) {
        this.log('error', `hub closed with terminal-ish code ${code}; parking reconnect for 5 minutes`)
        this.scheduleReconnect(5 * 60_000)
        return
      }
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      // onclose will follow
    }
  }

  // Reconnect forever. A long-running daemon must survive arbitrarily long
  // hub outages (Coolify redeploys take 60-120s, network blips happen). The
  // previous design exited after 5 attempts (~62s) and relied on the OS
  // service manager to restart the process — that proved fragile when
  // (a) NSSM throttle / Task Scheduler restart configuration wasn't explicit
  // and (b) the watchdog's "healthy ≥60s → exit on child crash" path
  // skipped self-heal for processes that had been alive for hours.
  // Exponential backoff is capped at 60s, so steady-state reconnect load on
  // the hub is bounded regardless of total duration.
  private scheduleReconnect(extraDelayMs = 0) {
    if (this.reconnectTimer) return
    const backoff = Math.min(60_000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts, 6)))
    const delay = Math.max(backoff, extraDelayMs)
    this.reconnectAttempts++
    this.log('info', `reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private send(msg: OutboundMsg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      try { this.ws.send(JSON.stringify(msg)) } catch {}
    }
  }

  private log(level: string, message: string, runId?: string) {
    console.log(`[${level}] ${message}`)
    this.send({ type: 'supervisor.log', level, message, run_id: runId, ts: new Date().toISOString() })
  }

  private async handleMessage(msg: any) {
    if (msg.type === 'ping') { this.send({ type: 'pong' }); return }
    if (msg.type === 'auth_ok') {
      this.authenticated = true
      this.log('info', 'authenticated; sending hello')
      this.send({
        type: 'supervisor.hello',
        version: VERSION,
        os: `${platform()} ${release()}`,
        hostname: hostname(),
        roots: this.cfg.roots,
        capabilities: ['supervisor', 'agent'],
        allow_dangerous_skip_permissions: this.cfg.allowDangerousSkipPermissions,
        restrict_to_git: this.cfg.requireGitRepo,
        max_concurrent: this.cfg.maxConcurrent,
        audit_log_enabled: this.cfg.auditLogEnabled,
      })
      // Sync commands + skills (best-effort, async)
      try {
        const scanned = scanAllCommands()
        const native = nativeSupervisorCommands()
        const cmds = [...native, ...scanned]
        this.send({ type: 'supervisor.commands_sync', commands: cmds })
        this.log('info', `synced ${cmds.length} commands/skills (${native.length} native)`)
      } catch (err: any) {
        this.log('warn', `commands scan failed: ${err.message}`)
      }
      // Phase 08 §15 — push full repo inventory to the hub. The hub upserts
      // sessions (github-keyed) + pending_local_repos (local-only). When roots
      // is empty, we emit a needs-roots log instead so the UI can prompt.
      void this.sendRepoInventory().catch((err) => {
        this.log('warn', `repo_inventory failed: ${err.message}`)
      })
      return
    }
    if (msg.type === 'auth_error') {
      this.log('error', `auth failed: ${msg.error}`)
      try { this.ws?.close() } catch {}
      return
    }

    if (!this.authenticated) return

    switch (msg.type) {
      case 'repo.scan': await this.onRepoScan(msg); break
      case 'repo.clone': await this.onRepoClone(msg); break
      case 'repo.pull': await this.onRepoPull(msg); break
      case 'repo.branch_checkout': await this.onBranchCheckout(msg); break
      case 'repo.list_branches': await this.onListBranches(msg); break
      case 'session.start': await this.onSessionStart(msg); break
      case 'session.stop': await this.onSessionStop(msg); break
      case 'session.status': this.onSessionStatus(msg); break
      case 'run_command': await this.onRunCommand(msg); break
      case 'key_rotated': this.onKeyRotated(msg); break
      case 'supervisor.set_roots': await this.onSetRoots(msg); break
      default:
        // unknown
        break
    }
  }

  /**
   * v0.5.4 — hub pushed a new plaintext API key (the user rotated via the
   * web Settings page, OR via the Tauri Update API Key dialog which hits the
   * same hub endpoint). Swap in-memory, persist to supervisor.json (no BOM —
   * Bun's writeFileSync with utf-8 writes no BOM natively), and reconnect
   * with the new key so subsequent /ws/agent auths succeed.
   */
  private onKeyRotated(msg: { new_api_key: string; key_id: string }) {
    const next = (msg.new_api_key ?? '').trim()
    if (!/^(remokey_|remo_)[A-Za-z0-9_-]+$/.test(next)) {
      this.log('warn', `key_rotated ignored: malformed key`)
      return
    }
    this.cfg.apiKey = next
    try {
      saveConfig({ ...this.cfg, apiKey: next })
    } catch (err: any) {
      this.log('warn', `key_rotated: saveConfig failed: ${err?.message ?? err}`)
    }
    this.log('info', `api key rotated (id=${msg.key_id}); reconnecting`)
    // Close + reconnect; ws.onclose schedules the reconnect via the existing
    // backoff path. Force the next attempt to be immediate.
    this.reconnectAttempts = 0
    try { this.ws?.close(4002, 'key_rotated') } catch {}
  }

  /**
   * Phase 12 W2 — hub pushed an updated roots list from the web UI. Validate
   * minimally (we already trust the hub, but defend against malformed payloads),
   * persist to supervisor.json (no BOM — Bun's native writeFileSync writes
   * UTF-8 without BOM), update the in-memory cfg, kick a re-scan, and ack.
   */
  private async onSetRoots(msg: { req_id: string; roots: unknown }) {
    const reqId = msg.req_id
    try {
      if (!Array.isArray(msg.roots)) {
        this.send({ type: 'supervisor.set_roots_ack', req_id: reqId, ok: false, error: 'roots_not_array' })
        return
      }
      const cleaned: string[] = []
      const seen = new Set<string>()
      for (const r of msg.roots) {
        if (typeof r !== 'string') continue
        const t = r.trim()
        if (!t) continue
        if (seen.has(t)) continue
        seen.add(t)
        cleaned.push(t)
      }
      // Swap in-memory + write to disk. saveConfig() uses writeFileSync('utf-8')
      // which emits UTF-8 with NO BOM (Node/Bun default — verified).
      this.cfg.roots = cleaned
      try {
        saveConfig({ ...this.cfg, apiKey: this.cfg.apiKey })
      } catch (err: any) {
        this.log('warn', `set_roots: saveConfig failed: ${err?.message ?? err}`)
        this.send({ type: 'supervisor.set_roots_ack', req_id: reqId, ok: false, error: `saveConfig: ${err?.message ?? err}` })
        return
      }
      this.log('info', `roots updated via hub (${cleaned.length} entries); rescanning`)
      // Fire-and-forget the re-scan so the ack returns quickly. Inventory will
      // arrive on a separate frame.
      void this.sendRepoInventory().catch((err) => {
        this.log('warn', `set_roots: rescan failed: ${err?.message ?? err}`)
      })
      this.send({ type: 'supervisor.set_roots_ack', req_id: reqId, ok: true, applied_roots: cleaned })
    } catch (err: any) {
      this.log('error', `set_roots: ${err?.message ?? err}`)
      this.send({ type: 'supervisor.set_roots_ack', req_id: reqId, ok: false, error: String(err?.message ?? err) })
    }
  }

  /**
   * Phase 08 §15 — run the new introspection-aware scanner across configured
   * roots and emit `supervisor.repo_inventory`. When `roots` is empty we emit
   * a `supervisor.needs_roots` log line so the Tauri UI can listen and prompt;
   * we still send an empty inventory so the hub clears any stale cache.
   */
  public async sendRepoInventory(): Promise<void> {
    if (!this.authenticated) return
    if (!this.cfg.roots || this.cfg.roots.length === 0) {
      this.log('warn', 'supervisor.needs_roots — no roots configured; inventory empty')
      this.send({ type: 'supervisor.repo_inventory', scanned_at: new Date().toISOString(), repos: [] })
      return
    }
    const entries = await scanRoots({ roots: this.cfg.roots, scan: this.cfg.scan })
    const scannedAt = new Date().toISOString()
    const repos = entries.map((e) => ({
      local_path: e.local_path,
      is_git_repo: e.is_git_repo,
      is_worktree: e.is_worktree,
      worktree_parent_path: e.worktree_parent_path,
      git_remote: e.git_remote,
      git_origin_github: e.git_origin_github,
      branch: e.branch,
      canonical: e.canonical,
    }))
    this.send({ type: 'supervisor.repo_inventory', scanned_at: scannedAt, repos })
    // Persist to <CONFIG_DIR>/last_inventory.json so the Tauri UI can render
    // the same data via the `get_inventory` IPC command. Best-effort.
    try {
      const dir = dirname(CONFIG_PATH)
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'last_inventory.json'),
        JSON.stringify({ scanned_at: scannedAt, repos }, null, 2),
        'utf-8',
      )
    } catch (err: any) {
      this.log('warn', `last_inventory.json write failed: ${err?.message ?? err}`)
    }
    // Stamp last_scan_at into supervisor.json so Roots panel + General page
    // see the fresh timestamp without re-watching the inventory file.
    try {
      saveConfig({ ...this.cfg, apiKey: this.cfg.apiKey, lastScanAt: scannedAt })
      this.cfg.lastScanAt = scannedAt
    } catch (err: any) {
      this.log('warn', `saveConfig(lastScanAt) failed: ${err?.message ?? err}`)
    }
    this.log('info', `repo_inventory sent: ${entries.length} entries`)
  }

  /**
   * Phase 08 §15 — react to external supervisor.json edits from the Tauri UI.
   *
   * Trigger semantics:
   *   - `last_scan_at` flipped to null → user clicked "Rescan now"; re-emit.
   *   - `roots` changed → re-emit so the hub sees the new shape.
   *   - Anything else → swallow.
   *
   * We never crash the live socket; failures fall back to next reconnect.
   */
  private onConfigChanged() {
    let raw: any
    try { raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) } catch { return }
    const newRoots: string[] = Array.isArray(raw.roots) ? raw.roots.map(String) : []
    const prevRoots = this.cfg.roots ?? []
    const rootsChanged = newRoots.length !== prevRoots.length ||
      newRoots.some((r, i) => r !== prevRoots[i])
    const lastScanCleared = raw.last_scan_at === null && this.cfg.lastScanAt !== null
    if (!rootsChanged && !lastScanCleared) return
    this.cfg.roots = newRoots
    if (raw.scan) {
      this.cfg.scan = {
        max_depth: typeof raw.scan.max_depth === 'number' ? raw.scan.max_depth : this.cfg.scan.max_depth,
        ignore_globs: Array.isArray(raw.scan.ignore_globs) ? raw.scan.ignore_globs.map(String) : this.cfg.scan.ignore_globs,
        follow_symlinks: raw.scan.follow_symlinks === true,
      }
    }
    this.log('info', `config changed (rootsChanged=${rootsChanged} rescanRequest=${lastScanCleared}); re-emitting inventory`)
    void this.sendRepoInventory().catch((err) => this.log('warn', `inventory re-emit failed: ${err?.message ?? err}`))
  }

  private async onRepoScan(msg: { req_id: string }) {
    const repos = scanAll(this.cfg.roots)
    this.send({ type: 'repo.scan_result', req_id: msg.req_id, repos })
  }

  private async onRepoClone(msg: { req_id: string; clone_url: string; target_path: string; repo_full_name: string }) {
    this.send({ type: 'repo.clone_progress', req_id: msg.req_id, stage: 'cloning' })
    const res = await cloneRepo(msg.clone_url, msg.target_path)
    this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'clone', ok: res.ok, error: res.error, data: res.data })
  }

  private async onRepoPull(msg: { req_id: string; repo_path: string; branch: string; clone_url: string }) {
    const res = await pullRepo(msg.repo_path, msg.branch, msg.clone_url)
    this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'pull', ok: res.ok, error: res.error })
  }

  private async onBranchCheckout(msg: { req_id: string; repo_path: string; branch: string; create: boolean }) {
    const res = await checkoutBranch(msg.repo_path, msg.branch, msg.create)
    this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'checkout', ok: res.ok, error: res.error })
  }

  private async onListBranches(msg: { req_id: string; repo_path: string }) {
    try {
      const data = await listBranches(msg.repo_path)
      this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'list_branches', ok: true, data })
    } catch (err: any) {
      this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'list_branches', ok: false, error: err?.message || 'failed' })
    }
  }

  private async onSessionStart(msg: { run_id: string; repo_path: string; branch?: string; pull?: boolean; initial_prompt?: string; api_key: string; hub_url: string; dangerously_skip_permissions?: boolean }) {
    // Pre-flight: bring the worktree to the latest committed state on the requested branch.
    // pull=true → checkout + git pull --ff-only against existing remote (no token needed).
    // pull=false but branch set → just checkout. Both gates refuse if dirty.
    // Failures log but don't block start — the user already opted in via the UI.
    if (msg.pull) {
      const dirtyNow = await isDirty(msg.repo_path)
      if (dirtyNow) {
        this.log('warn', `pull skipped: worktree has uncommitted changes; starting on current HEAD`, msg.run_id)
      } else {
        const r = await pullLocal(msg.repo_path, msg.branch)
        if (r.ok) this.log('info', `pre-flight: pulled latest on ${msg.branch || 'current branch'}`, msg.run_id)
        else this.log('warn', `pull failed: ${r.error}`, msg.run_id)
      }
    } else if (msg.branch) {
      const checkout = await checkoutBranch(msg.repo_path, msg.branch, false)
      if (!checkout.ok) {
        this.log('warn', `checkout failed: ${checkout.error}`, msg.run_id)
      }
    }
    await this.pm.start({
      runId: msg.run_id,
      repoPath: msg.repo_path,
      branch: msg.branch ?? null,
      initialPrompt: msg.initial_prompt ?? null,
      apiKey: this.cfg.apiKey,
      hubUrl: this.cfg.hubUrl,
      dangerouslySkipPermissions: msg.dangerously_skip_permissions === true,
    })
  }

  private async onSessionStop(msg: { run_id: string; reason: string }) {
    if (msg.run_id) await this.pm.stop(msg.run_id, msg.reason)
    else await this.pm.stopAll(msg.reason)
  }

  private async onRunCommand(msg: { run_id: string; command: string; args?: string[] }) {
    const { run_id, command } = msg
    const args = msg.args ?? []
    const handler = getHandler(command)
    if (!handler) {
      this.send({ type: 'run_finished', run_id, exit_code: 1, error: 'unknown_command' })
      return
    }
    const startedAt = Date.now()
    this.send({ type: 'run_started', run_id })
    try {
      const result = await handler(args)
      this.send({
        type: 'run_finished',
        run_id,
        exit_code: result.exit_code,
        duration_ms: Date.now() - startedAt,
        snippet: result.snippet,
        error: result.error,
      })
    } catch (err: any) {
      this.send({
        type: 'run_finished',
        run_id,
        exit_code: 1,
        duration_ms: Date.now() - startedAt,
        error: `handler_exception: ${err?.message || String(err)}`,
      })
    }
  }

  private onSessionStatus(msg: { req_id: string }) {
    this.send({
      type: 'supervisor.state',
      state: this.pm.currentState,
      run_id: this.pm.currentRunId,
      repo_path: this.pm.currentRepoPath,
    })
  }
}

import { hostname, platform, release } from 'os'
import { resolveHostname } from './hostname'
import { writeFileSync, mkdirSync, watch as fsWatch, existsSync, readFileSync } from 'fs'
import { dirname, join } from 'path'
import { scanAll, scanRoots } from './repo-scanner'
import { cloneRepo, pullRepo, pullLocal, checkoutBranch, listBranches, isDirty } from './git-ops'
import { assertWithinRoots, assertTargetWithinRoots, SandboxEscapeError } from './sandbox'
import { ProcessManager, type ProcState } from './process-manager'
import { scanAllCommands } from './commands-scanner'
import { getHandler, nativeSupervisorCommands } from './commands/index'
import { CONFIG_PATH, saveConfig, type SupervisorConfig } from './config'
import { log as obs } from './observability/logger'
import { VERSION } from './version'
import { pollUsage, USAGE_POLL_INTERVAL_MS, type UsagePayload } from './usage/oauth-poll'
import { writeForceUpdateMarker } from './runners/force-update-marker'

/** Bug A — push the live runner set to the hub every 10s after auth_ok. */
const SESSION_INVENTORY_INTERVAL_MS = 10_000

/**
 * fix/supervisor-periodic-repo-rescan — re-emit `supervisor.repo_inventory` on
 * a timer so a repo cloned AFTER the supervisor connected reaches the hub
 * without a reconnect or a hand-edit of supervisor.json. Default 5 min,
 * overridable via `REMO_REPO_INVENTORY_INTERVAL_MS`.
 */
export const REPO_INVENTORY_INTERVAL_DEFAULT_MS = 300_000

/** Non-positive / non-finite / unset ⇒ default (repo-wide knob convention). */
export function resolveRepoInventoryIntervalMs(raw?: string | null): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return REPO_INVENTORY_INTERVAL_DEFAULT_MS
  return n
}

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
  // `circuit_breakers` (fix/stop-the-bleed) makes an OPEN spawn-breaker VISIBLE to
  // the hub. Optional so an older hub simply ignores it (zod: .optional()).
  // `status_server` (fix/headless-autoupdate) makes a supervisor that failed to
  // bind its loopback status server VISIBLY degraded rather than silently so.
  | { type: 'session_inventory'; sessions: Array<{ session_id: string; cli_kind: 'claude' | 'codex'; project_dir: string; pid: number | null; started_at: string; last_activity_at: string | null; status: 'spawning' | 'running' | 'idle' | 'stopping' }>; circuit_breakers?: Array<{ repo_path: string; state: 'open' | 'half_open'; opened_at: string; failed_probes: number; exhausted: boolean; last_reason: string | null }>; status_server?: StatusServerHealth }
  | { type: 'run_started'; run_id: string }
  | { type: 'run_output'; run_id: string; chunk: string }
  | { type: 'run_finished'; run_id: string; exit_code?: number | null; duration_ms?: number; snippet?: string; error?: string }
  | { type: 'supervisor.set_roots_ack'; req_id: string; ok: boolean; applied_roots?: string[]; error?: string }
  // fix/supervisor-periodic-repo-rescan — ack for a hub-initiated rescan.
  | { type: 'supervisor.rescan_ack'; req_id: string; ok: boolean; error?: string }
  // milestone remote-update-trigger — ack for a hub-initiated forced update.
  | { type: 'supervisor.force_update_ack'; req_id: string; ok: boolean; error?: string }
  // P1 usage poll — parsed, non-secret Anthropic OAuth utilization snapshot.
  // The OAuth token is read locally in usage/oauth-poll.ts and NEVER serialized
  // here; only the four utilization windows + reset times cross the wire.
  | { type: 'usage_report'; usage: UsagePayload }
  // Phase 08 §6 — create-local-repo-and-push progress + failure.
  | { type: 'repo_create_progress'; job_id: string; stage: 'init' | 'commit' | 'remote_add' | 'pushing_locally' | 'pushed' | 'reindexing' | 'done'; percent?: number; message?: string }
  | { type: 'repo_create_failed'; job_id: string; stage: string; error: string }
  | { type: 'pong' }

/** fix/headless-autoupdate — loopback status-server health, reported to the hub. */
export interface StatusServerHealth {
  healthy: boolean
  port: number | null
  last_error: string | null
}

export class SupervisorClient {
  private ws: WebSocket | null = null
  /** Set by index.ts once the supervised status server is up. */
  private statusServerHealth: (() => StatusServerHealth) | null = null
  private cfg: SupervisorConfig
  private authenticated = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pm: ProcessManager

  /** Phase 08 §15 — fs.watch handle on supervisor.json so Tauri "Rescan now"
   * (which nulls `last_scan_at`) triggers a fresh inventory emission. */
  private configWatcher: ReturnType<typeof fsWatch> | null = null

  /** Bug A — interval handle for session_inventory pushes; null when not auth'd. */
  private sessionInventoryTimer: ReturnType<typeof setInterval> | null = null

  /** P1 — interval handle for the Anthropic OAuth usage poll; null when not
   *  auth'd. Fires once on auth_ok + every 5 min. */
  private usagePollTimer: ReturnType<typeof setInterval> | null = null

  /** fix/supervisor-periodic-repo-rescan — interval handle for the periodic
   *  repo inventory re-emit; null when not auth'd. */
  private repoInventoryTimer: ReturnType<typeof setInterval> | null = null

  /** Guards against a slow scan overlapping the next tick (or a hub-initiated
   *  rescan racing the timer). */
  private repoInventoryInFlight = false

  // ── B6: observability state ──────────────────────────────────────────────
  /** Last `auth_ok` timestamp (ms). Drives `last_reconnect_ms_ago` in
   *  /sup/status. Null until first auth. */
  private lastConnectedAt: number | null = null
  /** Most recent ws error / close event with non-clean code, captured for
   *  the tray's "last error" line. Cleared on next successful auth_ok. */
  private lastError: { message: string; at: string } | null = null
  /** Per-host sentry_key seeded by hub on first supervisor.hello. Used by
   *  the crash poster to authenticate against /api/sentry/<id>/envelope/. */
  private selfSentryKey: string | null = null
  private selfSentryProjectId: string | null = null
  /** supervisors.id assigned by hub after upsert. Surfaced in /sup/status. */
  private supervisorId: string | null = null

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
      obs.warn('hub_client.config_watch_failed', { error: err?.message ?? String(err) })
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
        // resolveHostname(), not os.hostname(): a transient empty os.hostname()
        // on RE-auth is what mints hostname-NULL ghost sessions on the hub.
        hostname: resolveHostname(),
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
      this.stopSessionInventoryPush()
      this.stopUsagePoll()
      this.stopRepoInventoryPush()
      const code = (ev as any)?.code as number | undefined
      const reason = (ev as any)?.reason as string | undefined
      this.log('warn', `WebSocket closed code=${code ?? '?'} reason=${reason || '(none)'}`)
      // B6: surface non-clean closes to the tray. 1000/1001/1005 are normal
      // shutdowns; everything else is operator-visible noise.
      if (code !== 1000 && code !== 1001 && code !== 1005) {
        this.lastError = { message: `ws_close code=${code ?? '?'} reason=${reason || '(none)'}`, at: new Date().toISOString() }
      }
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
    ws.onerror = (ev: any) => {
      if (this.ws !== ws) return // stale handler from a replaced socket
      // B1: structured log line so silent reconnect storms surface in logs.
      const msg = ev?.message ?? ev?.error?.message ?? ev?.type ?? null
      obs.error('hub_client.ws_error', {
        url: wsUrl,
        message: msg,
        reconnect_attempts: this.reconnectAttempts,
        authenticated: this.authenticated,
      })
      // B6: capture for the tray's "last error" line + /sup/status response.
      this.lastError = { message: `ws_error: ${msg ?? 'unknown'}`, at: new Date().toISOString() }
      // onclose will follow and drive the reconnect schedule.
    }
  }

  // Reconnect forever. A long-running daemon must survive arbitrarily long
  // hub outages (Coolify redeploys take 60-120s, network blips happen). The
  // previous design exited after 5 attempts (~62s) and relied on the OS
  // service manager to restart the process — that proved fragile.
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
    const lvl = (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') ? level : 'info'
    obs[lvl]('hub_client.log', { run_id: runId, hostname: hostname(), text: message })
    this.send({ type: 'supervisor.log', level, message, run_id: runId, ts: new Date().toISOString() })
  }

  private async handleMessage(msg: any) {
    if (msg.type === 'ping') { this.send({ type: 'pong' }); return }
    // B6: hub plants per-supervisor sentry creds in hello_ack. Used by the
    // crash poster to attribute uncaughtException reports to a host-scoped
    // error_projects row.
    if (msg.type === 'supervisor.hello_ack') {
      if (typeof msg.supervisor_id === 'string') this.supervisorId = msg.supervisor_id
      if (typeof msg.sentry_key === 'string') this.selfSentryKey = msg.sentry_key
      if (typeof msg.sentry_project_id === 'string') this.selfSentryProjectId = msg.sentry_project_id
      return
    }
    if (msg.type === 'auth_ok') {
      this.authenticated = true
      this.lastConnectedAt = Date.now()
      this.lastError = null
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
      // fix/supervisor-periodic-repo-rescan — fires immediately, then every
      // REMO_REPO_INVENTORY_INTERVAL_MS (default 5 min); cancels on disconnect.
      this.startRepoInventoryPush()
      // Bug A — start the session_inventory push interval. Fires once
      // immediately + every 10s; cancels on disconnect.
      this.startSessionInventoryPush()
      // P1 — start the Anthropic OAuth usage poll. Fires once immediately +
      // every 5 min; cancels on disconnect. Token stays local.
      this.startUsagePoll()
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
      case 'create_local_repo_and_push': await this.onCreateLocalRepoAndPush(msg); break
      case 'key_rotated': this.onKeyRotated(msg); break
      case 'supervisor.set_roots': await this.onSetRoots(msg); break
      case 'supervisor.rescan_repos': await this.onRescanRepos(msg); break
      case 'supervisor.force_update': this.onForceUpdate(msg); break
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
    // A root scan can outlive the tick interval on a large tree; never let two
    // scans run at once (the second would only duplicate work + IO).
    if (this.repoInventoryInFlight) {
      this.log('info', 'repo_inventory skipped: a scan is already in flight')
      return
    }
    this.repoInventoryInFlight = true
    try {
      await this.scanAndSendInventory()
    } finally {
      this.repoInventoryInFlight = false
    }
  }

  private async scanAndSendInventory(): Promise<void> {
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
   * Bug A (2026-05-28) — start the 10s session_inventory push loop. Idempotent
   * (no-op if already running). Stopped on every disconnect.
   */
  private startSessionInventoryPush() {
    if (this.sessionInventoryTimer) return
    // Fire immediately so the hub gets a snapshot on the same frame as hello.
    this.pushSessionInventory()
    this.sessionInventoryTimer = setInterval(() => {
      this.pushSessionInventory()
    }, SESSION_INVENTORY_INTERVAL_MS)
  }

  private stopSessionInventoryPush() {
    if (!this.sessionInventoryTimer) return
    clearInterval(this.sessionInventoryTimer)
    this.sessionInventoryTimer = null
  }

  /**
   * P1 — start the Anthropic OAuth usage poll loop. Idempotent (no-op if already
   * running). Fires once immediately so the hub gets a snapshot on the same
   * connect, then every 5 min. Stopped on every disconnect.
   */
  private startUsagePoll() {
    if (this.usagePollTimer) return
    void this.pollAndSendUsage()
    this.usagePollTimer = setInterval(() => {
      void this.pollAndSendUsage()
    }, USAGE_POLL_INTERVAL_MS)
  }

  private stopUsagePoll() {
    if (!this.usagePollTimer) return
    clearInterval(this.usagePollTimer)
    this.usagePollTimer = null
  }

  /**
   * fix/supervisor-periodic-repo-rescan — start the periodic repo inventory
   * re-emit loop. Idempotent (no-op if already running). The immediate first
   * emit happens here too; subsequent ticks are on the interval. Stopped on
   * every disconnect. Overlap is guarded inside sendRepoInventory
   * (repoInventoryInFlight); an empty-roots tick is a cheap no-op emit.
   */
  private startRepoInventoryPush() {
    if (this.repoInventoryTimer) return
    // Immediate first scan (replaces the old one-shot auth_ok emit).
    void this.sendRepoInventory().catch((err) => {
      this.log('warn', `repo_inventory failed: ${err?.message ?? err}`)
    })
    const intervalMs = resolveRepoInventoryIntervalMs(process.env.REMO_REPO_INVENTORY_INTERVAL_MS)
    this.repoInventoryTimer = setInterval(() => {
      void this.sendRepoInventory().catch((err) => {
        this.log('warn', `repo_inventory failed: ${err?.message ?? err}`)
      })
    }, intervalMs)
  }

  private stopRepoInventoryPush() {
    if (!this.repoInventoryTimer) return
    clearInterval(this.repoInventoryTimer)
    this.repoInventoryTimer = null
  }

  /**
   * fix/supervisor-periodic-repo-rescan — hub-initiated rescan (web "Refresh
   * repos" button). Forces a fresh full inventory emit and acks. Overlap with
   * the periodic timer is guarded by repoInventoryInFlight inside
   * sendRepoInventory. A scan failure surfaces as ok:false — never a silent
   * swap to a stale inventory.
   */
  private async onRescanRepos(msg: { req_id: string }) {
    const reqId = msg.req_id
    try {
      await this.sendRepoInventory()
      this.send({ type: 'supervisor.rescan_ack', req_id: reqId, ok: true })
    } catch (err: any) {
      this.log('warn', `rescan_repos failed: ${err?.message ?? err}`)
      this.send({ type: 'supervisor.rescan_ack', req_id: reqId, ok: false, error: String(err?.message ?? err) })
    }
  }

  /**
   * milestone remote-update-trigger — hub-initiated forced update (web
   * Settings "Update to latest" button). The SIDECAR has no updater — the
   * Rust tray owns check→download→install→relaunch (auto_update.rs). This
   * only drops a marker file the tray's own poll loop consumes; it acks as
   * soon as the marker is written, not when the update actually completes.
   */
  private onForceUpdate(msg: { req_id: string; requested_by?: string }) {
    const reqId = msg.req_id
    const path = writeForceUpdateMarker(msg.requested_by)
    if (path) {
      this.log('info', `force_update requested${msg.requested_by ? ` by ${msg.requested_by}` : ''}; marker written to ${path}`)
      this.send({ type: 'supervisor.force_update_ack', req_id: reqId, ok: true })
    } else {
      this.log('warn', 'force_update: marker write failed')
      this.send({ type: 'supervisor.force_update_ack', req_id: reqId, ok: false, error: 'marker_write_failed' })
    }
  }

  /**
   * P1 — read the local OAuth token, poll `/api/oauth/usage`, and forward the
   * parsed (non-secret) utilization windows to the hub via the existing
   * `usage_report` agent message. Never throws; missing/expired token and
   * network errors are logged at info/warn and skip the send.
   *
   * The OAuth token never leaves `usage/oauth-poll.ts` — only the four parsed
   * windows (utilization + reset times) are serialized onto the wire.
   */
  private async pollAndSendUsage() {
    if (!this.authenticated) return
    if (this.ws?.readyState !== WebSocket.OPEN) return
    let result
    try {
      result = await pollUsage()
    } catch (err: any) {
      // pollUsage is non-throwing by contract; guard anyway.
      this.log('warn', `usage poll threw: ${err?.message ?? err}`)
      return
    }
    if (!result.ok) {
      // Expected steady-state on hosts without a Claude OAuth login or with an
      // expired token — keep it to a single info line, not an error.
      this.log('info', `usage poll skipped: ${result.reason}`)
      return
    }
    this.send({ type: 'usage_report', usage: result.usage })
  }

  /**
   * fix/headless-autoupdate — wire the supervised status server's health into the
   * `session_inventory` push, the same way the spawn circuit-breaker state rides
   * it. A supervisor with no status server must be VISIBLY degraded.
   */
  setStatusServerHealthProvider(fn: () => StatusServerHealth) {
    this.statusServerHealth = fn
  }

  /**
   * Bug A — snapshot the ProcessManager's live runner set and send it to the
   * hub. Drops entries that haven't received a session_id from the hub yet
   * (those would be unaddressable on the hub side). Best-effort; ws.send
   * failures are swallowed because the next interval will retry.
   */
  private pushSessionInventory() {
    if (!this.authenticated) return
    if (this.ws?.readyState !== WebSocket.OPEN) return
    const snap = this.pm.inventorySnapshot()
    const sessions = snap
      .filter((r) => r.sessionId !== null)
      .map((r) => ({
        session_id: r.sessionId as string,
        cli_kind: r.cliKind,
        project_dir: r.projectDir,
        pid: r.pid,
        started_at: r.startedAt,
        last_activity_at: r.lastActivityAt,
        status: r.status,
      }))
    // fix/stop-the-bleed: ship the spawn circuit-breaker state alongside the
    // inventory. A latched-open breaker used to be invisible to the hub — the
    // supervisor spawned ZERO CLIs for four days while the hub looked healthy.
    // Empty array in the steady state.
    this.send({
      type: 'session_inventory',
      sessions,
      circuit_breakers: this.pm.circuitBreakerSnapshot(),
      // fix/headless-autoupdate — same idea as circuit_breakers: a supervisor
      // whose status server never bound (zombie listener on 9106) used to be
      // invisible to the hub. Undefined when no provider is wired (tests).
      status_server: this.statusServerHealth?.(),
    })
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

    /**
   * Reject a hub-issued git op when its path escapes the configured roots.
   * The sandbox gate previously lived ONLY on `session.start`; without it
   * here, a malicious / buggy hub could `repo.clone` to `C:\Windows\System32`
   * (writing privileged dirs) even though the subsequent `session.start`
   * would be blocked. Per supervisor audit 2026-05-28.
   */
  private rejectIfEscape(op: string, reqId: string, path: string, target: 'existing' | 'target'): boolean {
    try {
      const roots = this.cfg.roots ?? []
      if (target === 'target') assertTargetWithinRoots(path, roots)
      else assertWithinRoots(path, roots)
      return false
    } catch (err) {
      if (err instanceof SandboxEscapeError) {
        this.log('warn', `${op}: sandbox_escape: ${path}`)
        this.send({ type: 'repo.op_result', req_id: reqId, op, ok: false, error: 'sandbox_escape' })
        return true
      }
      this.send({ type: 'repo.op_result', req_id: reqId, op, ok: false, error: (err as any)?.message || 'sandbox_check_failed' })
      return true
    }
  }

  private async onRepoClone(msg: { req_id: string; clone_url: string; target_path: string; repo_full_name: string }) {
    if (this.rejectIfEscape('clone', msg.req_id, msg.target_path, 'target')) return
    this.send({ type: 'repo.clone_progress', req_id: msg.req_id, stage: 'cloning' })
    const res = await cloneRepo(msg.clone_url, msg.target_path)
    this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'clone', ok: res.ok, error: res.error, data: res.data })
  }

  private async onRepoPull(msg: { req_id: string; repo_path: string; branch: string; clone_url: string }) {
    if (this.rejectIfEscape('pull', msg.req_id, msg.repo_path, 'existing')) return
    const res = await pullRepo(msg.repo_path, msg.branch, msg.clone_url)
    this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'pull', ok: res.ok, error: res.error })
  }

  private async onBranchCheckout(msg: { req_id: string; repo_path: string; branch: string; create: boolean }) {
    if (this.rejectIfEscape('checkout', msg.req_id, msg.repo_path, 'existing')) return
    const res = await checkoutBranch(msg.repo_path, msg.branch, msg.create)
    this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'checkout', ok: res.ok, error: res.error })
  }

  private async onListBranches(msg: { req_id: string; repo_path: string }) {
    if (this.rejectIfEscape('list_branches', msg.req_id, msg.repo_path, 'existing')) return
    try {
      const data = await listBranches(msg.repo_path)
      this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'list_branches', ok: true, data })
    } catch (err: any) {
      this.send({ type: 'repo.op_result', req_id: msg.req_id, op: 'list_branches', ok: false, error: err?.message || 'failed' })
    }
  }

  private async onSessionStart(msg: { run_id: string; repo_path: string; branch?: string; pull?: boolean; initial_prompt?: string; api_key: string; hub_url: string; dangerously_skip_permissions?: boolean; orchestrator?: { session_id: string; name: string; cwd: string; system_prompt: string; hub_api_key: string; hub_url: string } }) {
    // Orchestrator-session path: skip git pre-flight (cwd is a repos parent
    // folder, not a repo), use the supplied cwd verbatim, and plumb the
    // orchestrator-specific env + system prompt through ProcessManager.
    if (msg.orchestrator) {
      const orch = msg.orchestrator
      this.log('info', `orchestrator session.start cwd=${orch.cwd} name=${orch.name}`, msg.run_id)
      await this.pm.start({
        runId: msg.run_id,
        repoPath: orch.cwd,
        branch: null,
        initialPrompt: msg.initial_prompt ?? null,
        apiKey: this.cfg.apiKey,
        hubUrl: this.cfg.hubUrl,
        dangerouslySkipPermissions: msg.dangerously_skip_permissions === true,
        orchestrator: {
          systemPrompt: orch.system_prompt,
          hubApiKey: orch.hub_api_key,
          hubUrl: orch.hub_url,
        },
      })
      return
    }

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

  /**
   * Phase 08 §6 — hub created the empty GitHub remote and asks us to push the
   * local folder. Sandbox-gate `local_path` against configured roots BEFORE any
   * git runs (mirrors rejectIfEscape for the repo.* ops), then drive
   * init→commit→remote_add→push→done via git-push-driver, forwarding each stage
   * as repo_create_progress. On escape or git failure emit repo_create_failed.
   */
  private async onCreateLocalRepoAndPush(msg: {
    job_id: string
    session_id: string
    owner: string
    name: string
    visibility: 'private' | 'public'
    remote_url: string
    local_path: string
  }) {
    const jobId = msg.job_id
    // Sandbox enforcement: local_path must resolve inside a configured root.
    // The folder already exists (it's an unpushed local repo), so use the
    // existing-path assertion. No git runs if this throws.
    try {
      assertWithinRoots(msg.local_path, this.cfg.roots ?? [])
    } catch (err) {
      if (err instanceof SandboxEscapeError) {
        this.log('warn', `create_local_repo_and_push: sandbox_escape: ${msg.local_path}`)
        this.send({ type: 'repo_create_failed', job_id: jobId, stage: 'validating_scope', error: 'sandbox_escape' })
        return
      }
      this.send({ type: 'repo_create_failed', job_id: jobId, stage: 'validating_scope', error: (err as any)?.message || 'sandbox_check_failed' })
      return
    }

    const { pushLocalRepo } = await import('./git-push-driver')
    const res = await pushLocalRepo({
      localPath: msg.local_path,
      remoteUrl: msg.remote_url,
      onProgress: (stage) => {
        this.send({ type: 'repo_create_progress', job_id: jobId, stage })
      },
    })
    if (!res.ok) {
      this.log('warn', `create_local_repo_and_push failed at ${res.failedStage}: ${res.error}`)
      this.send({ type: 'repo_create_failed', job_id: jobId, stage: res.failedStage ?? 'pushing_locally', error: res.error ?? 'push_failed' })
      return
    }
    this.log('info', `create_local_repo_and_push: pushed ${msg.owner}/${msg.name}`)
  }

  private onSessionStatus(msg: { req_id: string }) {
    this.send({
      type: 'supervisor.state',
      state: this.pm.currentState,
      run_id: this.pm.currentRunId,
      repo_path: this.pm.currentRepoPath,
    })
  }

  // ── B6: observability accessors (drive /sup/status) ─────────────────────
  /** Snapshot of live runners (one per active run in the ProcessManager). */
  getRunnersSnapshot(): Array<{ session_id: string | null; run_id: string; cli_kind: 'claude' | 'codex'; project_dir: string; pid: number | null; state: string; restart_count: number }> {
    const inv = this.pm.inventorySnapshot()
    return inv.map((e) => ({
      session_id: e.sessionId,
      run_id: e.runId,
      cli_kind: e.cliKind,
      project_dir: e.projectDir,
      pid: e.pid,
      state: e.status,
      restart_count: 0,
    }))
  }

  isHubConnected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN
  }

  getHubState(): 'connecting' | 'authenticating' | 'connected' | 'reconnecting' | 'stopped' {
    if (this.authenticated) return 'connected'
    if (this.ws?.readyState === WebSocket.OPEN) return 'authenticating'
    if (this.reconnectTimer) return 'reconnecting'
    if (this.ws?.readyState === WebSocket.CONNECTING) return 'connecting'
    return 'reconnecting'
  }

  getLastReconnectMsAgo(): number | null {
    if (this.lastConnectedAt === null) return null
    return Date.now() - this.lastConnectedAt
  }

  getLastError(): { message: string; at: string } | null {
    return this.lastError
  }

  getSupervisorId(): string | null {
    return this.supervisorId
  }

  /** B6: post an `uncaughtException` as a Sentry-style envelope to the hub's
   *  intake. Fire-and-forget — failures are log-only because we're already
   *  inside a fatal handler. Skips when sentry creds haven't been planted
   *  yet (first-boot before supervisor.hello_ack). */
  async postCrashEnvelope(err: { name?: string; message: string; stack?: string }): Promise<void> {
    if (!this.selfSentryKey || !this.selfSentryProjectId) {
      console.warn('[crash] no sentry creds yet; skipping post')
      return
    }
    const hubUrl = this.cfg.hubUrl.replace(/\/$/, '')
    const url = `${hubUrl}/api/sentry/${this.selfSentryProjectId}/envelope/`
    const eventId = randomEventId()
    const headerLine = JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() })
    const itemHeader = JSON.stringify({ type: 'event' })
    const payload = {
      event_id: eventId,
      platform: 'node',
      release: VERSION,
      level: 'error',
      exception: {
        values: [{
          type: err.name || 'Error',
          value: err.message,
          stacktrace: err.stack ? { frames: parseStackFrames(err.stack) } : undefined,
        }],
      },
      tags: { source: 'supervisor', hostname: hostname() },
    }
    const body = `${headerLine}\n${itemHeader}\n${JSON.stringify(payload)}\n`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_key=${this.selfSentryKey}, sentry_version=7, sentry_client=remo-supervisor/${VERSION}`,
        },
        body,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) console.warn(`[crash] hub intake returned ${res.status}`)
    } catch (e: any) {
      // Per B6 spec — crash-post failures must be log-only, never throw.
      console.warn(`[crash] intake post failed: ${e?.message || String(e)}`)
    }
  }
}

function randomEventId(): string {
  // 32 hex chars, Sentry's expected event_id shape.
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function parseStackFrames(stack: string): Array<{ filename?: string; function?: string; lineno?: number; colno?: number }> {
  // Best-effort V8 stack parse. Top 10 frames only.
  const lines = stack.split('\n').slice(1, 11)
  return lines.map((line) => {
    const m = line.match(/^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/)
    if (!m) return { function: line.trim() }
    return {
      function: m[1] || undefined,
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    }
  })
}

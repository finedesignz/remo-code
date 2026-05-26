import { hostname, platform, release } from 'os'
import { scanAll } from './repo-scanner'
import { cloneRepo, pullRepo, pullLocal, checkoutBranch, listBranches, isDirty } from './git-ops'
import { ProcessManager, type ProcState } from './process-manager'
import { scanAllCommands } from './commands-scanner'
import { getHandler, nativeSupervisorCommands } from './commands/index'
import type { SupervisorConfig } from './config'

const VERSION = '0.3.1'

type OutboundMsg =
  | { type: 'auth'; api_key: string; project_dir: string; hostname: string; role: 'supervisor' }
  | { type: 'supervisor.hello'; version: string; os: string; hostname: string; roots: string[]; capabilities: string[]; allow_dangerous_skip_permissions: boolean; restrict_to_git: boolean; max_concurrent: number; audit_log_enabled: boolean }
  | { type: 'supervisor.state'; state: ProcState; run_id?: string | null; repo_path?: string | null; pid?: number | null; restart_count?: number; last_exit?: any }
  | { type: 'supervisor.log'; level: string; message: string; run_id?: string; ts?: string }
  | { type: 'repo.scan_result'; req_id: string; repos: any[] }
  | { type: 'repo.op_result'; req_id: string; op: string; ok: boolean; error?: string; data?: any }
  | { type: 'repo.clone_progress'; req_id: string; stage: string; percent?: number }
  | { type: 'supervisor.commands_sync'; commands: Array<{ kind: 'command' | 'skill'; name: string; description: string | null; source: string; path: string }> }
  | { type: 'run_started'; run_id: string }
  | { type: 'run_output'; run_id: string; chunk: string }
  | { type: 'run_finished'; run_id: string; exit_code?: number | null; duration_ms?: number; snippet?: string; error?: string }
  | { type: 'pong' }

export class SupervisorClient {
  private ws: WebSocket | null = null
  private cfg: SupervisorConfig
  private authenticated = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pm: ProcessManager

  constructor(cfg: SupervisorConfig) {
    this.cfg = cfg
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
      default:
        // unknown
        break
    }
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

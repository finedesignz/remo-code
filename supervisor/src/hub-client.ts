import { hostname, platform, release } from 'os'
import { scanAll } from './repo-scanner'
import { cloneRepo, pullRepo, checkoutBranch, listBranches } from './git-ops'
import { ProcessManager, type ProcState } from './process-manager'
import { scanAllCommands } from './commands-scanner'
import type { SupervisorConfig } from './config'

const VERSION = '0.2.0'

type OutboundMsg =
  | { type: 'auth'; api_key: string; project_dir: string; hostname: string; role: 'supervisor' }
  | { type: 'supervisor.hello'; version: string; os: string; hostname: string; roots: string[]; capabilities: string[] }
  | { type: 'supervisor.state'; state: ProcState; run_id?: string | null; repo_path?: string | null; pid?: number | null; restart_count?: number; last_exit?: any }
  | { type: 'supervisor.log'; level: string; message: string; run_id?: string; ts?: string }
  | { type: 'repo.scan_result'; req_id: string; repos: any[] }
  | { type: 'repo.op_result'; req_id: string; op: string; ok: boolean; error?: string; data?: any }
  | { type: 'repo.clone_progress'; req_id: string; stage: string; percent?: number }
  | { type: 'supervisor.commands_sync'; commands: Array<{ kind: 'command' | 'skill'; name: string; description: string | null; source: string; path: string }> }
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
    })
  }

  connect() {
    const wsUrl = this.cfg.hubUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/agent'
    this.log('info', `connecting to ${wsUrl}`)
    try {
      this.ws = new WebSocket(wsUrl)
    } catch (err: any) {
      this.log('error', `WebSocket construct failed: ${err.message}`)
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = () => {
      this.reconnectAttempts = 0
      this.send({
        type: 'auth',
        api_key: this.cfg.apiKey,
        project_dir: '__supervisor__',
        hostname: hostname(),
        role: 'supervisor',
      })
    }
    this.ws.onmessage = (event) => {
      let msg: any
      try { msg = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as any)) } catch { return }
      this.handleMessage(msg)
    }
    this.ws.onclose = () => {
      this.authenticated = false
      this.log('warn', 'WebSocket closed')
      this.scheduleReconnect()
    }
    this.ws.onerror = () => {
      // onclose will follow
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return
    const delay = Math.min(60_000, 1000 * Math.pow(2, Math.min(this.reconnectAttempts, 6)))
    this.reconnectAttempts++
    this.log('info', `reconnecting in ${delay}ms`)
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
      })
      // Sync commands + skills (best-effort, async)
      try {
        const cmds = scanAllCommands()
        this.send({ type: 'supervisor.commands_sync', commands: cmds })
        this.log('info', `synced ${cmds.length} commands/skills`)
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

  private async onSessionStart(msg: { run_id: string; repo_path: string; branch?: string; pull?: boolean; initial_prompt?: string; api_key: string; hub_url: string }) {
    // pull/checkout pre-flight (best-effort)
    if (msg.pull && msg.branch) {
      this.log('info', `pre-flight: checkout+pull not implemented w/o tokenized url; skipping`, msg.run_id)
    }
    if (msg.branch) {
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
    })
  }

  private async onSessionStop(msg: { run_id: string; reason: string }) {
    if (msg.run_id) await this.pm.stop(msg.run_id, msg.reason)
    else await this.pm.stopAll(msg.reason)
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

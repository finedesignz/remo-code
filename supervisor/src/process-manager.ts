import { existsSync } from 'fs'
import { join } from 'path'
import type { SupervisorConfig } from './config'
import { assertWithinRoots, SandboxEscapeError } from './sandbox'
import { appendAudit, hashPrompt, type AuditEntry } from './audit'
import { SessionBridge, type SessionBridgeCallbacks, type SessionBridgeOptions } from './runners/session-bridge'

export type ProcState = 'idle' | 'starting' | 'running' | 'stopping' | 'crashed' | 'stopped'

export interface RunSpec {
  runId: string
  repoPath: string
  branch: string | null
  initialPrompt: string | null
  apiKey: string
  hubUrl: string
  /** Hub-requested flag. Honored only when `cfg.allowDangerousSkipPermissions === true`; otherwise stripped + logged. */
  dangerouslySkipPermissions?: boolean
  /**
   * When set, this run is the user's orchestrator session: a Claude process
   * spawned in a repos-parent cwd, taught how to coordinate other sessions.
   * Carries the full-power hub API key the orchestrator needs to call the
   * hub REST API at runtime + the seed system prompt.
   */
  orchestrator?: {
    systemPrompt: string
    hubApiKey: string
    hubUrl: string
  }
}

export interface StartRejection {
  reason: 'sandbox_escape' | 'not_git_repo' | 'concurrency_cap' | 'duplicate_run' | 'legacy_agent_spawn_disabled'
  detail?: Record<string, unknown>
}

export interface ProcessManagerCallbacks {
  onStateChange: (state: ProcState, info: { runId?: string; repoPath?: string; pid?: number; restartCount?: number; lastExit?: { code: number | null; reason: string; stderrTail?: string } }) => void
  onLog: (level: 'info' | 'warn' | 'error', message: string, runId?: string) => void
}

const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000]
const CIRCUIT_WINDOW_MS = 10 * 60_000
const CIRCUIT_THRESHOLD = 5
/** Hard cap on restart attempts (from PR #86). After this, the run is
 *  finalized as `max_restarts_exceeded` and the supervisor stops respawning. */
const MAX_RESTART_COUNT = 10

/** Test hook for the new in-process bridge path. When set, `start()` uses
 *  this factory instead of `new SessionBridge(...)`. Lets the unit test
 *  verify "session.start → bridge constructed with correct options" without
 *  actually spawning `claude` or opening a real WS. */
export type BridgeFactory = (opts: SessionBridgeOptions, cb: SessionBridgeCallbacks) => SessionBridge

interface RunInstance {
  spec: RunSpec
  bridge: SessionBridge | null
  pid: number | null
  state: ProcState
  restartCount: number
  recentCrashes: number[]
  restartTimer: ReturnType<typeof setTimeout> | null
  userStop: boolean
}

/** Manages N concurrent in-process Claude runners (one SessionBridge per run_id).
 *
 *  Restored 2026-05-27 to replace the gutted Phase 09 stub that refused every
 *  `session.start` with `legacy_agent_spawn_disabled`. The replacement:
 *    - spawns `claude --input-format stream-json --output-format stream-json
 *      --verbose` directly via a `SessionBridge` (NEVER via the retired
 *      external npm CLI);
 *    - opens an independent /ws/agent connection per run, authenticated with
 *      `project_dir = repoPath` so the hub binds it to the right session;
 *    - keeps all security gates (sandbox-escape, not-git-repo, concurrency,
 *      dangerously-skip-permissions cap), restart caps, and audit log writes
 *      from the PR #86 hardening.
 */
export class ProcessManager {
  private runs = new Map<string, RunInstance>()
  private cb: ProcessManagerCallbacks
  private cfg: SupervisorConfig
  /** Test hook: when set, used instead of `new SessionBridge(...)`. */
  bridgeFactory: BridgeFactory | null = null

  constructor(cb: ProcessManagerCallbacks, cfg: SupervisorConfig) {
    this.cb = cb
    this.cfg = cfg
  }

  /** Swap config (called by the config watcher); affects next `start()`. */
  updateConfig(cfg: SupervisorConfig) {
    this.cfg = cfg
  }

  /** Count of runs occupying a concurrency slot (starting / running / crashed-pending-restart). */
  private activeSlotCount(): number {
    let n = 0
    for (const r of this.runs.values()) {
      if (r.state === 'starting' || r.state === 'running' || r.state === 'crashed') n++
    }
    return n
  }

  private writeAudit(spec: RunSpec, allowed: boolean, reason?: string): void {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      run_id: spec.runId,
      repo_path: spec.repoPath,
      branch: spec.branch ?? null,
      prompt_hash: hashPrompt(spec.initialPrompt),
      flags: {
        dangerously_skip_permissions_requested: spec.dangerouslySkipPermissions === true,
        dangerously_skip_permissions_applied:
          spec.dangerouslySkipPermissions === true && this.cfg.allowDangerousSkipPermissions === true,
      },
      allowed,
      ...(reason ? { reason } : {}),
    }
    appendAudit(entry, this.cfg)
  }

  /** Aggregate supervisor state — 'running' if any run is active, else 'idle'. */
  get currentState(): ProcState {
    for (const r of this.runs.values()) {
      if (r.state === 'running' || r.state === 'starting' || r.state === 'crashed') return 'running'
    }
    return 'idle'
  }
  get currentRunId(): string | null {
    for (const r of this.runs.values()) {
      if (r.state !== 'idle' && r.state !== 'stopped') return r.spec.runId
    }
    return null
  }
  get currentRepoPath(): string | null {
    const id = this.currentRunId
    return id ? this.runs.get(id)!.spec.repoPath : null
  }
  get activeRuns(): Array<{ runId: string; repoPath: string; state: ProcState; pid: number | null }> {
    return Array.from(this.runs.values())
      .filter((r) => r.state !== 'idle' && r.state !== 'stopped')
      .map((r) => ({ runId: r.spec.runId, repoPath: r.spec.repoPath, state: r.state, pid: r.pid }))
  }

  /**
   * Bug A (2026-05-28) — snapshot for the supervisor's `session_inventory`
   * push. One entry per live runner. The hub keys these by `session_id` which,
   * for in-process bridges, equals the run id (the SessionBridge auths against
   * the hub with `project_dir = repoPath` and the hub returns a session row).
   * For pre-0.5.7 callers the session_id is unknown until the bridge gets
   * `auth_ok`; we surface the run id and let the hub correlate via the
   * SessionBridge layer (see hub-client `pushSessionInventory`).
   */
  inventorySnapshot(): Array<{
    runId: string
    sessionId: string | null
    cliKind: 'claude' | 'codex'
    projectDir: string
    pid: number | null
    startedAt: string
    lastActivityAt: string | null
    status: 'spawning' | 'running' | 'idle' | 'stopping'
  }> {
    const out: Array<{
      runId: string
      sessionId: string | null
      cliKind: 'claude' | 'codex'
      projectDir: string
      pid: number | null
      startedAt: string
      lastActivityAt: string | null
      status: 'spawning' | 'running' | 'idle' | 'stopping'
    }> = []
    for (const r of this.runs.values()) {
      if (r.state === 'stopped' || r.state === 'idle') continue
      const status: 'spawning' | 'running' | 'idle' | 'stopping' =
        r.state === 'starting' || r.state === 'crashed' ? 'spawning'
        : r.state === 'running' ? 'running'
        : 'stopping'
      out.push({
        runId: r.spec.runId,
        sessionId: (r as any).sessionId ?? null,
        cliKind: 'claude',
        projectDir: r.spec.repoPath,
        pid: r.pid,
        startedAt: (r as any).startedAt ?? new Date().toISOString(),
        lastActivityAt: (r as any).lastActivityAt ?? null,
        status,
      })
    }
    return out
  }

  /**
   * Bug A — let the bridge report the session_id (received from the hub on
   * auth_ok) back so future inventory pushes carry it.
   */
  noteSessionIdForRun(runId: string, sessionId: string) {
    const r = this.runs.get(runId)
    if (!r) return
    ;(r as any).sessionId = sessionId
  }

  /**
   * Bug A — bump last_activity_at when the bridge sees an outbound event.
   */
  noteActivityForRun(runId: string) {
    const r = this.runs.get(runId)
    if (!r) return
    ;(r as any).lastActivityAt = new Date().toISOString()
  }

  async start(spec: RunSpec): Promise<StartRejection | null> {
    if (this.runs.has(spec.runId)) {
      this.cb.onLog('warn', `Refusing duplicate start for run_id`, spec.runId)
      this.writeAudit(spec, false, 'duplicate_run')
      return { reason: 'duplicate_run' }
    }

    try {
      assertWithinRoots(spec.repoPath, this.cfg.roots)
    } catch (err) {
      const e = err as SandboxEscapeError
      const detail = { repo_path: spec.repoPath, real_path: e.realPath, allowed_roots: e.allowedRoots }
      this.cb.onLog('error', `[security] sandbox_escape: ${spec.repoPath} not within allowed roots ${JSON.stringify(e.allowedRoots)}`, spec.runId)
      this.cb.onStateChange('stopped', {
        runId: spec.runId,
        repoPath: spec.repoPath,
        lastExit: { code: null, reason: 'sandbox_escape' },
      })
      this.writeAudit(spec, false, 'sandbox_escape')
      return { reason: 'sandbox_escape', detail }
    }

    if (this.cfg.requireGitRepo && !spec.orchestrator) {
      if (!existsSync(join(spec.repoPath, '.git'))) {
        this.cb.onLog('error', `[security] not_git_repo: ${spec.repoPath} has no .git`, spec.runId)
        this.cb.onStateChange('stopped', {
          runId: spec.runId,
          repoPath: spec.repoPath,
          lastExit: { code: null, reason: 'not_git_repo' },
        })
        this.writeAudit(spec, false, 'not_git_repo')
        return { reason: 'not_git_repo', detail: { repo_path: spec.repoPath } }
      }
    }

    const slots = this.activeSlotCount()
    if (slots >= this.cfg.maxConcurrent) {
      this.cb.onLog('warn', `[security] concurrency_cap: ${slots}/${this.cfg.maxConcurrent} slots in use`, spec.runId)
      this.cb.onStateChange('stopped', {
        runId: spec.runId,
        repoPath: spec.repoPath,
        lastExit: { code: null, reason: 'concurrency_cap' },
      })
      this.writeAudit(spec, false, 'concurrency_cap')
      return { reason: 'concurrency_cap', detail: { limit: this.cfg.maxConcurrent } }
    }

    if (spec.dangerouslySkipPermissions && !this.cfg.allowDangerousSkipPermissions) {
      this.cb.onLog(
        'warn',
        `[security] hub requested dangerous-skip flag but supervisor cap is OFF; flag stripped`,
        spec.runId,
      )
    }

    this.writeAudit(spec, true)

    const run: RunInstance = {
      spec,
      bridge: null,
      pid: null,
      state: 'idle',
      restartCount: 0,
      recentCrashes: [],
      restartTimer: null,
      userStop: false,
    }
    ;(run as any).startedAt = new Date().toISOString()
    ;(run as any).lastActivityAt = null
    ;(run as any).sessionId = null
    this.runs.set(spec.runId, run)
    this.spawn(run)
    return null
  }

  private spawn(run: RunInstance) {
    const spec = run.spec
    this.setState(run, 'starting', { runId: spec.runId, repoPath: spec.repoPath })

    const allowDangerous = spec.dangerouslySkipPermissions === true && this.cfg.allowDangerousSkipPermissions === true
    const opts: SessionBridgeOptions = {
      runId: spec.runId,
      repoPath: spec.repoPath,
      apiKey: spec.apiKey,
      hubUrl: spec.hubUrl,
      allowDangerousSkipPermissions: allowDangerous,
      orchestrator: spec.orchestrator,
    }
    const cb: SessionBridgeCallbacks = {
      onLog: (level, message) => this.cb.onLog(level, message, spec.runId),
      onSpawned: (info) => {
        run.pid = info.pid || null
        this.setState(run, 'running', { runId: spec.runId, repoPath: spec.repoPath, pid: run.pid ?? undefined })
      },
      onSessionId: (sessionId) => this.noteSessionIdForRun(spec.runId, sessionId),
      onActivity: () => this.noteActivityForRun(spec.runId),
      onExit: ({ code, reason }) => {
        if (!this.runs.has(spec.runId)) return // already finalized
        this.cb.onLog(code === 0 ? 'info' : 'error', `bridge exited code=${code} reason=${reason}`, spec.runId)
        if (run.userStop) {
          this.setState(run, 'idle', { runId: spec.runId, lastExit: { code, reason } })
          this.runs.delete(spec.runId)
          return
        }
        if (reason === 'hub_shutdown' || code === 0) {
          this.setState(run, 'idle', { runId: spec.runId, lastExit: { code, reason } })
          this.runs.delete(spec.runId)
          return
        }
        // Crash path — apply circuit-breaker + restart cap.
        run.recentCrashes.push(Date.now())
        run.recentCrashes = run.recentCrashes.filter((t) => Date.now() - t < CIRCUIT_WINDOW_MS)
        if (run.recentCrashes.length >= CIRCUIT_THRESHOLD) {
          this.cb.onLog('error', `circuit breaker open — stopping`, spec.runId)
          this.setState(run, 'stopped', { runId: spec.runId, lastExit: { code, reason: 'circuit_open' } })
          this.runs.delete(spec.runId)
          return
        }
        this.scheduleRestart(run, code, reason)
      },
    }

    try {
      const bridge = this.bridgeFactory
        ? this.bridgeFactory(opts, cb)
        : new SessionBridge(opts, cb)
      run.bridge = bridge
      bridge.start()
    } catch (err: any) {
      this.cb.onLog('error', `failed to start bridge: ${err?.message ?? err}`, spec.runId)
      this.setState(run, 'crashed', { runId: spec.runId, repoPath: spec.repoPath, lastExit: { code: null, reason: `bridge_start_error: ${err?.message ?? err}` } })
      this.scheduleRestart(run, null, 'bridge_start_error')
      return
    }
  }

  private scheduleRestart(run: RunInstance, exitCode: number | null, reason: string) {
    if (run.restartCount >= MAX_RESTART_COUNT) {
      this.cb.onLog(
        'error',
        `max_restarts_exceeded — giving up after ${run.restartCount} restart attempts`,
        run.spec.runId,
      )
      this.setState(run, 'stopped', {
        runId: run.spec.runId,
        lastExit: { code: exitCode, reason: 'max_restarts_exceeded' },
      })
      this.runs.delete(run.spec.runId)
      return
    }
    const delay = BACKOFF_SCHEDULE[Math.min(run.restartCount, BACKOFF_SCHEDULE.length - 1)]
    run.restartCount++
    this.cb.onLog('warn', `restarting in ${delay}ms (attempt ${run.restartCount})`, run.spec.runId)
    this.setState(run, 'crashed', { runId: run.spec.runId, lastExit: { code: exitCode, reason } })
    run.restartTimer = setTimeout(() => {
      run.restartTimer = null
      if (!this.runs.has(run.spec.runId)) return
      // Tear down stale bridge before respawning.
      if (run.bridge) { void run.bridge.stop().catch(() => {}); run.bridge = null }
      this.spawn(run)
    }, delay)
  }

  async stop(runId: string, _reason: string) {
    const run = this.runs.get(runId)
    if (!run) return
    run.userStop = true
    if (run.restartTimer) { clearTimeout(run.restartTimer); run.restartTimer = null }
    this.setState(run, 'stopping', { runId })
    if (run.bridge) {
      try { await run.bridge.stop() } catch {}
    }
    // If onExit didn't fire (already stopped or bridge null), finalize here.
    if (this.runs.has(runId)) {
      this.setState(run, 'idle', { runId, lastExit: { code: 0, reason: 'user_stop' } })
      this.runs.delete(runId)
    }
  }

  /** Stop all active runs. */
  async stopAll(reason: string) {
    for (const runId of this.runs.keys()) {
      await this.stop(runId, reason)
    }
  }

  private setState(run: RunInstance, state: ProcState, info: any = {}) {
    run.state = state
    this.cb.onStateChange(state, { restartCount: run.restartCount, ...info })
  }
}

import type { Subprocess } from 'bun'
import { existsSync } from 'fs'
import { join } from 'path'
import type { SupervisorConfig } from './config'
import { assertWithinRoots, SandboxEscapeError } from './sandbox'
import { appendAudit, hashPrompt, type AuditEntry } from './audit'

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
/** Phase 09 follow-up — hard cap on restart attempts. After this, the run is
 *  finalized as `max_restarts_exceeded` and the supervisor stops respawning it.
 *  Prevents runaway loops when the same broken spawn keeps crashing. */
const MAX_RESTART_COUNT = 10

interface RunInstance {
  spec: RunSpec
  proc: Subprocess | null
  state: ProcState
  restartCount: number
  recentCrashes: number[]
  restartTimer: ReturnType<typeof setTimeout> | null
  userStop: boolean
  stderrTail: string[]
}

/** Manages N concurrent claude-agent child processes, one per run_id. */
export class ProcessManager {
  private runs = new Map<string, RunInstance>()
  private cb: ProcessManagerCallbacks
  private cfg: SupervisorConfig
  /** Test hook: when set, used instead of `Bun.spawn`. Receives (argv, opts) and returns a Subprocess-like object. */
  spawnImpl: ((cmd: string[], opts: any) => Subprocess) | null = null

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
  /** First active run_id, if any. */
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
      .map((r) => ({ runId: r.spec.runId, repoPath: r.spec.repoPath, state: r.state, pid: r.proc?.pid ?? null }))
  }

  async start(spec: RunSpec): Promise<StartRejection | null> {
    if (this.runs.has(spec.runId)) {
      this.cb.onLog('warn', `Refusing duplicate start for run_id`, spec.runId)
      this.writeAudit(spec, false, 'duplicate_run')
      return { reason: 'duplicate_run' }
    }

    // Sandbox-escape gate: repoPath must resolve inside at least one configured root.
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

    // Git-only gate (opt-in).
    if (this.cfg.requireGitRepo) {
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

    // Concurrency cap.
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

    // --dangerously-skip-permissions HARD CAP — strip silently when cap is off.
    if (spec.dangerouslySkipPermissions && !this.cfg.allowDangerousSkipPermissions) {
      this.cb.onLog(
        'warn',
        `[security] hub requested --dangerously-skip-permissions but supervisor cap is OFF; flag stripped`,
        spec.runId,
      )
    }

    this.writeAudit(spec, true)

    const run: RunInstance = {
      spec,
      proc: null,
      state: 'idle',
      restartCount: 0,
      recentCrashes: [],
      restartTimer: null,
      userStop: false,
      stderrTail: [],
    }
    this.runs.set(spec.runId, run)
    this.spawn(run)
    return null
  }

  private spawn(run: RunInstance) {
    const spec = run.spec
    this.setState(run, 'starting', { runId: spec.runId, repoPath: spec.repoPath })

    run.stderrTail = []
    // Phase 09 retired the user-facing legacy CLI agent on 2026-05-26. The
    // cached v0.4.1 of that retired package contained the "Always delegate"
    // autonomous-loop bug. Until the in-process claude-runner (stream-json
    // over stdin/stdout, bridged to the hub WS) is built as its own follow-up
    // phase, this spawn path is DISABLED. The supervisor refuses the run and
    // emits a structured stopped state so the hub finalizes the run row
    // cleanly instead of trapping it in an indefinite respawn loop.
    //
    // Test canary: supervisor/test/no-legacy-agent-spawn.test.ts greps the
    // tree for the retired package name and forbidden flags; if any reappear
    // in supervisor source, that test FAILS the build.
    this.cb.onLog(
      'error',
      `[security] legacy_agent_spawn_disabled: the retired CLI spawn path is disabled in Phase 09; session.start cannot proceed until the in-process claude-runner lands. Run will be finalized as stopped.`,
      spec.runId,
    )
    this.setState(run, 'stopped', {
      runId: spec.runId,
      repoPath: spec.repoPath,
      lastExit: { code: null, reason: 'legacy_agent_spawn_disabled' },
    })
    this.runs.delete(spec.runId)
    return
  }

  private scheduleRestart(run: RunInstance, exitCode: number | null, reason: string, stderrTail = '') {
    // Hard cap on restart attempts. After MAX_RESTART_COUNT consecutive
    // restarts the supervisor stops respawning the run and finalizes it
    // as `max_restarts_exceeded`. Prevents runaway loops (e.g. the cached
    // buggy v0.4.1 agent that triggered this fix in the first place).
    if (run.restartCount >= MAX_RESTART_COUNT) {
      this.cb.onLog(
        'error',
        `max_restarts_exceeded — giving up after ${run.restartCount} restart attempts`,
        run.spec.runId,
      )
      this.setState(run, 'stopped', {
        runId: run.spec.runId,
        lastExit: { code: exitCode, reason: 'max_restarts_exceeded', stderrTail },
      })
      this.runs.delete(run.spec.runId)
      return
    }
    const delay = BACKOFF_SCHEDULE[Math.min(run.restartCount, BACKOFF_SCHEDULE.length - 1)]
    run.restartCount++
    this.cb.onLog('warn', `restarting in ${delay}ms (attempt ${run.restartCount})`, run.spec.runId)
    this.setState(run, 'crashed', { runId: run.spec.runId, lastExit: { code: exitCode, reason, stderrTail } })
    run.restartTimer = setTimeout(() => {
      run.restartTimer = null
      if (!this.runs.has(run.spec.runId)) return
      this.spawn(run)
    }, delay)
  }

  async stop(runId: string, _reason: string) {
    const run = this.runs.get(runId)
    if (!run) return
    run.userStop = true
    if (run.restartTimer) { clearTimeout(run.restartTimer); run.restartTimer = null }
    this.setState(run, 'stopping', { runId })
    if (run.proc) {
      try { run.proc.kill('SIGINT') } catch {}
      setTimeout(() => {
        if (run.proc) {
          try { run.proc.kill('SIGKILL') } catch {}
        }
      }, 10_000)
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

  private async consumeStdout(run: RunInstance) {
    if (!run.proc?.stdout) return
    try {
      const reader = run.proc.stdout.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (line.trim()) {
            this.cb.onLog('info', `[agent] ${line.slice(0, 500)}`, run.spec.runId)
          }
        }
      }
    } catch {}
  }

  private async consumeStderr(run: RunInstance) {
    if (!run.proc?.stderr) return
    try {
      const reader = run.proc.stderr.getReader()
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (line.trim()) {
            run.stderrTail.push(line)
            if (run.stderrTail.length > 200) run.stderrTail.shift()
          }
        }
      }
    } catch {}
  }
}

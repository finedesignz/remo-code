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
  reason: 'sandbox_escape' | 'not_git_repo' | 'concurrency_cap' | 'duplicate_run' | 'legacy_agent_spawn_disabled' | 'circuit_open'
  detail?: Record<string, unknown>
}

/** Circuit-breaker state for one repo. See {@link ProcessManager.circuitBreakerSnapshot}. */
export type BreakerState = 'open' | 'half_open'

export interface BreakerSnapshotEntry {
  repo_path: string
  state: BreakerState
  /** ISO timestamp the breaker last opened. */
  opened_at: string
  /** Consecutive half-open probes that have failed. */
  failed_probes: number
  /** true once failed_probes hit the probe cap — no further self-heal attempts. */
  exhausted: boolean
  /** Crash reason that tripped it. */
  last_reason: string | null
}

interface Breaker {
  state: BreakerState
  openedAt: number
  failedProbes: number
  /** Cooldown timer (open) or probe-survival timer (half_open). */
  timer: ReturnType<typeof setTimeout> | null
  lastReason: string | null
  /**
   * The runId admitted as the probe while half_open. The breaker stays half_open
   * (i.e. an exit is still attributed to the PROBE) until this run has SURVIVED
   * the health window — spawning is not health.
   */
  probeRunId: string | null
}

export interface ProcessManagerCallbacks {
  onStateChange: (state: ProcState, info: { runId?: string; repoPath?: string; pid?: number; restartCount?: number; lastExit?: { code: number | null; reason: string; stderrTail?: string } }) => void
  onLog: (level: 'info' | 'warn' | 'error', message: string, runId?: string) => void
}

const BACKOFF_SCHEDULE = [1000, 2000, 4000, 8000, 16000, 30000]
const CIRCUIT_WINDOW_MS = 10 * 60_000
const CIRCUIT_THRESHOLD = 5
/**
 * Circuit-breaker COOLDOWN before a half-open probe (fix/stop-the-bleed).
 *
 * BUG (prod 2026-07-07 → 2026-07-11): once the breaker tripped it latched OPEN
 * with no cooldown, no probe, and no hub-visible signal. The TitaniumTower
 * supervisor spawned ZERO CLIs for four days while the hub reported perfectly
 * healthy — scheduled tasks, orchestrator and Telegram all silently no-opped,
 * and recovery needed a human to notice and restart the supervisor by hand.
 *
 * The breaker now self-heals: after the cooldown it goes HALF-OPEN, which ADMITS
 * the next GENUINE hub-dispatched start for that repo as the probe. It NEVER
 * spawns synthetic work — a supervisor-manufactured probe carrying the tripped
 * run's `initialPrompt` would replay a user/scheduler prompt with no hub dispatch
 * and no cost/token gate (an un-gated spend path AND a loop generator). The
 * admitted probe is gated by construction. It CLOSES the breaker if the CLI
 * reaches `running`; it RE-OPENS it if it crashes (cooldown doubles up to the
 * cap). After `CIRCUIT_MAX_PROBES` consecutive failed probes it stays open and is
 * marked `exhausted` — but it is REPORTED to the hub either way
 * (`circuitBreakerSnapshot` rides the session_inventory push), so an open breaker
 * can never again fail silently.
 */
const CIRCUIT_COOLDOWN_MS = 5 * 60_000
const CIRCUIT_MAX_COOLDOWN_MS = 30 * 60_000
const CIRCUIT_MAX_PROBES = 5
/**
 * How long the admitted probe must STAY UP before the breaker closes.
 *
 * Closing on `onSpawned` was a second instance of the same bug: a CLI that
 * crash-loops ON STARTUP — precisely what the breaker exists for — "succeeds" at
 * spawning every time, so the breaker would close, the process would die a moment
 * later, `onExit` would no longer see `half_open`, `failedProbes` would never
 * increment, and the repo would escape the probe budget and retry forever.
 *
 * Health = SURVIVAL, not spawn. We reuse the file's existing liveness grace
 * (`SLOT_STALE_GRACE_MS`, 30s — the same bound the slot reconciler already uses to
 * decide a runner is real) rather than inventing a second notion of "healthy".
 */
const CIRCUIT_PROBE_HEALTHY_MS = 30_000
/** Hard cap on restart attempts (from PR #86). After this, the run is
 *  finalized as `max_restarts_exceeded` and the supervisor stops respawning. */
const MAX_RESTART_COUNT = 10

/**
 * Self-heal grace for the slot reconciler. A counted slot ('starting'/'running')
 * whose bridge reports `isAlive() === false` is only reclaimed once it has been
 * stranded longer than this. The bound sits comfortably above the bridge's own
 * reconnect backoff ceiling (RECONNECT_BACKOFF_MS max 15s) so a healthy session
 * that is momentarily mid-reconnect — which in any case still has a live runner,
 * so reports alive — is never falsely reclaimed. */
const SLOT_STALE_GRACE_MS = 30_000

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
  /** Circuit breakers, keyed by repoPath. Absent = closed (the healthy default). */
  private breakers = new Map<string, Breaker>()
  private cb: ProcessManagerCallbacks
  private cfg: SupervisorConfig
  /** Test hook: when set, used instead of `new SessionBridge(...)`. */
  bridgeFactory: BridgeFactory | null = null
  /** Test hook: overrides the cooldown before the half-open transition. */
  circuitCooldownMs: number | null = null
  /** Test hook: overrides how long an admitted probe must survive to close the breaker. */
  circuitProbeHealthyMs: number | null = null

  constructor(cb: ProcessManagerCallbacks, cfg: SupervisorConfig) {
    this.cb = cb
    this.cfg = cfg
  }

  /** Swap config (called by the config watcher); affects next `start()`. */
  updateConfig(cfg: SupervisorConfig) {
    this.cfg = cfg
  }

  /**
   * Count of runs currently occupying a concurrency slot.
   *
   * Bug fix 2026-05-29: `crashed` is EXCLUDED. A crashed entry sits in a
   * `setTimeout` backoff window with no live process — counting it strands the
   * slot whenever the restart timer is stalled, the supervisor was restarted
   * mid-cycle, or the bridge errored out before reattaching. Real-prod symptom:
   * `maxConcurrent=1` users seeing every `session.start` rejected with
   * `concurrency_cap` despite no Claude CLI running.
   *
   * The crashed → restart path either evicts (max_restarts / circuit_open /
   * userStop / clean exit, see `spawn()` onExit + `scheduleRestart`) or
   * transitions back to `starting` → `running`. Since the slot check runs on
   * every fresh `start()` and a respawning crashed entry will re-enter
   * `starting` shortly after, the only window for N+1 concurrency is the
   * backoff delay — bounded by `BACKOFF_SCHEDULE` (≤30s) and guarded below by
   * the same-repoPath duplicate check.
   */
  private activeSlotCount(): number {
    this.reconcileSlots()
    let n = 0
    for (const r of this.runs.values()) {
      if (r.state === 'starting' || r.state === 'running') n++
    }
    return n
  }

  /**
   * Self-healing slot reconciler (2026-05-30). Root cause of the prod lockout:
   * a slot is counted purely from a run's stored state ('starting'/'running'),
   * but a run can be stranded in such a state with NO live child process and NO
   * code path that ever evicts it. The bridge surfaces termination only via
   * `onExit`; when the bridge instead spins forever in its WS reconnect-backoff
   * loop (hub down / auth bounce → never authenticates → runner never spawns →
   * never reaches 'running', and non-terminal WS close codes never call
   * `onExit`), the entry pins a slot indefinitely. After enough churn every slot
   * is pinned and `start()` rejects everything with `concurrency_cap` while the
   * hub DB shows zero live runs — exactly the observed outage.
   *
   * Rather than chase every missing-decrement path (each a new leak waiting to
   * happen), we derive occupancy from REALITY on every cap evaluation: a counted
   * entry whose bridge is gone or not alive, and that has been stranded past
   * SLOT_STALE_GRACE_MS, is evicted. This can only ever drop a slot whose bridge
   * has no open WS and no live runner, so a healthy (or briefly reconnecting)
   * session is never reclaimed. Eviction here is the same terminal cleanup the
   * normal exit paths perform: clear any restart timer and drop from `runs`.
   */
  private reconcileSlots(): void {
    const now = Date.now()
    for (const [runId, r] of this.runs) {
      if (r.state !== 'starting' && r.state !== 'running') continue
      const bridgeAlive = typeof r.bridge?.isAlive === 'function' ? r.bridge.isAlive() : r.bridge != null
      // Leak fix B (2026-06-01, corrected 2026-06-02): the real
      // SessionBridge.isAlive() returns true whenever its hub WS is OPEN — even
      // if the `claude` child NEVER spawned. A bridge that authenticated but
      // never spawned a runner pins its slot forever; isAlive() alone never frees
      // it. The ORIGINAL fix keyed this on `r.pid != null`, but the stream-json
      // runner reports spawn with a best-effort `pid: 0` (it never surfaces a
      // real OS pid), which onSpawned stores as `null` via `info.pid || null`.
      // So `r.pid != null` is false for EVERY healthy runner, and aliveness
      // collapsed to "had activity in the last grace window" — reaping idle but
      // healthy sessions (the auto-launched orchestrator: green→gray, #237
      // regression; live evidence: a `running` runner with pid:null).
      // The truthful signal is whether the bridge actually SPAWNED a runner, not
      // the lie-valued pid: `hasSpawnedRunner()` is true once onSpawned fired and
      // false for a never-spawned bridge — so genuinely-alive sessions (incl.
      // idle orchestrator) are never reclaimed, while authenticated-but-never-
      // spawned stranded bridges still are.
      const hasSpawnedRunner = typeof r.bridge?.hasSpawnedRunner === 'function'
        ? r.bridge.hasSpawnedRunner()
        : r.pid != null
      const alive = bridgeAlive && hasSpawnedRunner
      if (alive) continue
      const lastSeen = Date.parse(
        (r as any).lastActivityAt ?? (r as any).startedAt ?? '',
      )
      const strandedFor = Number.isFinite(lastSeen) ? now - lastSeen : Infinity
      if (strandedFor < SLOT_STALE_GRACE_MS) continue
      this.cb.onLog(
        'warn',
        `[reconcile] reclaiming stranded ${r.state} slot — bridge not alive for ${Math.round(strandedFor / 1000)}s`,
        runId,
      )
      if (r.restartTimer) { clearTimeout(r.restartTimer); r.restartTimer = null }
      if (r.bridge) { void r.bridge.stop().catch(() => {}); r.bridge = null }
      this.setState(r, 'stopped', { runId, lastExit: { code: null, reason: 'reconciled_stranded_slot' } })
      this.runs.delete(runId)
    }
  }

  /** True if a crashed-pending-restart entry already targets this repoPath.
   *  Prevents the N+1 race during the backoff window — the pending restart
   *  will reclaim the slot on its own. */
  private hasCrashedPendingForRepo(repoPath: string): boolean {
    for (const r of this.runs.values()) {
      if (r.state === 'crashed' && r.spec.repoPath === repoPath) return true
    }
    return false
  }

  /** True if an ACTIVE ('starting'/'running') entry already targets this
   *  repoPath. Primary leak fix (2026-06-01): the scheduler/continue-dev
   *  rotation re-fires `session.start` for an already-active project every
   *  ~15-30 min with a FRESH run_id. Keyed only on run_id, each repeat minted a
   *  SECOND counted runner for the same project_dir (live evidence: kh-hub x2,
   *  ottolax x2 ...), pinning the cap. A repeated start for an already-active
   *  project is a duplicate — reuse the live runner, don't mint another. */
  private activeRunIdForRepo(repoPath: string): string | null {
    for (const r of this.runs.values()) {
      if ((r.state === 'starting' || r.state === 'running') && r.spec.repoPath === repoPath) {
        return r.spec.runId
      }
    }
    return null
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

  // ── Circuit breaker (fix/stop-the-bleed) ───────────────────────────────────
  /**
   * Hub-visible breaker state. Rides the existing 10s `session_inventory` push
   * (hub-client.pushSessionInventory) so an OPEN breaker is never again invisible
   * to the hub. Empty array = all repos healthy (the steady state).
   */
  circuitBreakerSnapshot(): BreakerSnapshotEntry[] {
    const out: BreakerSnapshotEntry[] = []
    for (const [repoPath, b] of this.breakers) {
      out.push({
        repo_path: repoPath,
        state: b.state,
        opened_at: new Date(b.openedAt).toISOString(),
        failed_probes: b.failedProbes,
        exhausted: b.failedProbes >= CIRCUIT_MAX_PROBES,
        last_reason: b.lastReason,
      })
    }
    return out
  }

  /** Cooldown before the next half-open probe: exponential, capped. */
  private cooldownFor(failedProbes: number): number {
    const base = this.circuitCooldownMs ?? CIRCUIT_COOLDOWN_MS
    return Math.min(base * Math.pow(2, failedProbes), CIRCUIT_MAX_COOLDOWN_MS)
  }

  /**
   * Trip (or re-trip) the breaker for a repo: stop the run and — unless the probe
   * budget is exhausted — schedule the half-open transition after the cooldown, so
   * the supervisor self-heals without a human restart. The transition ADMITS the
   * next genuine hub-dispatched start; it never spawns anything itself.
   */
  private tripBreaker(run: RunInstance, code: number | null, reason: string) {
    const spec = run.spec
    const prev = this.breakers.get(spec.repoPath)
    const failedProbes = prev?.state === 'half_open' ? prev.failedProbes + 1 : (prev?.failedProbes ?? 0)
    const breaker: Breaker = {
      state: 'open',
      openedAt: Date.now(),
      failedProbes,
      timer: null,
      lastReason: reason,
      probeRunId: null,
    }
    this.breakers.set(spec.repoPath, breaker)

    if (prev?.timer) clearTimeout(prev.timer)
    this.setState(run, 'stopped', { runId: spec.runId, lastExit: { code, reason: 'circuit_open' } })
    this.runs.delete(spec.runId)

    if (failedProbes >= CIRCUIT_MAX_PROBES) {
      this.cb.onLog(
        'error',
        `circuit breaker open — probe budget exhausted after ${failedProbes} failed probes; no further auto-recovery for ${spec.repoPath} (reported to hub)`,
        spec.runId,
      )
      return
    }
    const cooldown = this.cooldownFor(failedProbes)
    this.cb.onLog(
      'error',
      `circuit breaker open — stopping; half-open in ${cooldown}ms (probe ${failedProbes + 1}/${CIRCUIT_MAX_PROBES})`,
      spec.runId,
    )
    breaker.timer = setTimeout(() => this.halfOpen(spec.repoPath), cooldown)
    ;(breaker.timer as any)?.unref?.()
  }

  /**
   * Cooldown elapsed → go HALF-OPEN. **No synthetic spawn.**
   *
   * The supervisor NEVER manufactures its own run to probe with. An earlier draft
   * re-spawned the tripped `RunSpec` (prompt and all) under a synthetic run id —
   * which would REPLAY a user/scheduler prompt with no hub dispatch, no cost/token
   * gate, no dedupe and no session_run row: a seventh un-gated spend path, and a
   * loop generator (the prompt that crashed the CLI gets re-run forever). Exactly
   * the failure class this branch exists to kill.
   *
   * Instead half-open simply ADMITS the next GENUINE hub-dispatched start for this
   * repo. That start is gated by construction (it came through `dispatch()`), so
   * the probe can never spend outside the gate chain. It closes the breaker if the
   * CLI spawns, and re-opens it (longer cooldown, +1 failed probe) if it crashes.
   */
  private halfOpen(repoPath: string) {
    const breaker = this.breakers.get(repoPath)
    if (!breaker) return
    breaker.timer = null
    breaker.state = 'half_open'
    breaker.probeRunId = null
    // Deliberately UNBOUNDED: if no genuine start ever arrives for this repo, the
    // breaker just sits in half_open. That is the correct resting state — nothing is
    // being refused (the next start is admitted), nothing is running, and the state
    // is reported to the hub every 10s. A repo nobody dispatches to needs no
    // recovery; adding a timeout would only decide, arbitrarily, whether to forget a
    // crash history that costs nothing to keep.
    this.cb.onLog(
      'warn',
      `circuit breaker half-open for ${repoPath} — the next hub-dispatched start is admitted as the probe (no synthetic spawn, no prompt replay)`,
    )
  }

  /**
   * The admitted probe's CLI spawned. That is NOT yet health — a startup
   * crash-looper spawns fine and dies a second later. Start the survival timer;
   * the breaker stays `half_open` (so a crash before the timer fires is still
   * attributed to the probe by `onExit` → `tripBreaker` → `failedProbes + 1`) and
   * only CLOSES once the probe has stayed up for CIRCUIT_PROBE_HEALTHY_MS.
   */
  private noteProbeSpawned(repoPath: string, runId: string) {
    const breaker = this.breakers.get(repoPath)
    if (!breaker || breaker.state !== 'half_open') return
    if (breaker.probeRunId !== runId) return
    if (breaker.timer) clearTimeout(breaker.timer)
    const healthyMs = this.circuitProbeHealthyMs ?? CIRCUIT_PROBE_HEALTHY_MS
    breaker.timer = setTimeout(() => {
      // Still the same probe, still half_open, still alive → genuinely healthy.
      const b = this.breakers.get(repoPath)
      if (!b || b.state !== 'half_open' || b.probeRunId !== runId) return
      const run = this.runs.get(runId)
      if (!run || (run.state !== 'running' && run.state !== 'starting')) return
      this.closeBreaker(repoPath, `probe run ${runId} survived ${healthyMs}ms`)
    }, healthyMs)
    ;(breaker.timer as any)?.unref?.()
  }

  /** Close + forget the breaker for a repo (probe survived the health window). */
  private closeBreaker(repoPath: string, why: string) {
    const breaker = this.breakers.get(repoPath)
    if (!breaker) return
    if (breaker.timer) clearTimeout(breaker.timer)
    this.breakers.delete(repoPath)
    this.cb.onLog('info', `circuit breaker closed — ${repoPath}: ${why}`)
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

    // Circuit breaker: an OPEN breaker refuses the spawn (the repo is crash-
    // looping). A HALF-OPEN breaker lets exactly this probe through. The breaker
    // self-heals on its own cooldown timer, and its state is pushed to the hub in
    // the session_inventory frame — it can no longer fail silently.
    const breaker = this.breakers.get(spec.repoPath)
    if (breaker && breaker.state === 'open') {
      this.cb.onLog('warn', `Refusing start — circuit breaker open for ${spec.repoPath}`, spec.runId)
      this.cb.onStateChange('stopped', {
        runId: spec.runId,
        repoPath: spec.repoPath,
        lastExit: { code: null, reason: 'circuit_open' },
      })
      this.writeAudit(spec, false, 'circuit_open')
      return {
        reason: 'circuit_open',
        detail: {
          repo_path: spec.repoPath,
          opened_at: new Date(breaker.openedAt).toISOString(),
          failed_probes: breaker.failedProbes,
          exhausted: breaker.failedProbes >= CIRCUIT_MAX_PROBES,
        },
      }
    }
    // Half-open admits EXACTLY ONE probe. While that probe is in flight the breaker
    // itself refuses every other start for the repo — it does not lean on the
    // duplicate-run check below to hold the invariant. Half-open means "one gated
    // trial run, nothing else", so a second concurrent CLI can never slip through
    // and re-enter the crash-loop/spend path the breaker exists to contain.
    if (breaker && breaker.state === 'half_open' && breaker.probeRunId != null && breaker.probeRunId !== spec.runId) {
      this.cb.onLog('warn', `Refusing start — circuit breaker half-open, probe ${breaker.probeRunId} already in flight for ${spec.repoPath}`, spec.runId)
      this.cb.onStateChange('stopped', {
        runId: spec.runId,
        repoPath: spec.repoPath,
        lastExit: { code: null, reason: 'circuit_open' },
      })
      this.writeAudit(spec, false, 'circuit_open')
      return {
        reason: 'circuit_open',
        detail: {
          repo_path: spec.repoPath,
          opened_at: new Date(breaker.openedAt).toISOString(),
          failed_probes: breaker.failedProbes,
          probe_in_flight: breaker.probeRunId,
        },
      }
    }
    // Don't race a crashed-pending-restart entry for the same repo — its
    // backoff timer will reclaim the slot. Treat as duplicate to keep the
    // N+1 window during backoff closed.
    if (this.hasCrashedPendingForRepo(spec.repoPath)) {
      this.cb.onLog('warn', `Refusing start for repo with crashed-pending restart: ${spec.repoPath}`, spec.runId)
      this.writeAudit(spec, false, 'duplicate_run')
      return { reason: 'duplicate_run', detail: { repo_path: spec.repoPath, pending_restart: true } }
    }

    // Reconcile stranded slots BEFORE the duplicate-by-repo check so a leaked
    // entry (bridge gone / never spawned) is evicted and does not falsely
    // dedupe a legitimate fresh start for that repo.
    const slots = this.activeSlotCount()

    // Primary leak fix: a repeated start for an already-active project (fresh
    // run_id, same project_dir) is a duplicate — reject instead of minting a
    // second counted runner. The live runner already serves that project.
    const activeForRepo = this.activeRunIdForRepo(spec.repoPath)
    if (activeForRepo && activeForRepo !== spec.runId) {
      this.cb.onLog('warn', `Refusing duplicate start for already-active repo: ${spec.repoPath} (active run ${activeForRepo})`, spec.runId)
      this.writeAudit(spec, false, 'duplicate_run')
      return { reason: 'duplicate_run', detail: { repo_path: spec.repoPath, active_run_id: activeForRepo } }
    }

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

    // Claim the half-open probe slot only once the start has cleared EVERY
    // rejection check above. Claiming it earlier pins probeRunId to a run that
    // never spawns (duplicate_run / concurrency_cap), and since the slot is only
    // released by a probe exit, the breaker would sit half-open forever and no
    // later genuine start could ever be admitted as the probe.
    if (breaker && breaker.state === 'half_open' && breaker.probeRunId == null) {
      breaker.probeRunId = spec.runId
      this.cb.onLog('warn', `circuit breaker half-open — admitting run as the probe for ${spec.repoPath}`, spec.runId)
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
        // Spawning is NOT health (a startup crash-looper spawns every time). Start
        // the probe's survival timer; the breaker only closes if it stays up.
        this.noteProbeSpawned(spec.repoPath, spec.runId)
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
        // A crashing HALF-OPEN probe re-opens the breaker immediately (the whole
        // point of the probe is one attempt), without re-earning the threshold.
        const probing = this.breakers.get(spec.repoPath)?.state === 'half_open'
        if (probing || run.recentCrashes.length >= CIRCUIT_THRESHOLD) {
          this.tripBreaker(run, code, reason)
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
    try {
      this.setState(run, 'stopping', { runId })
      if (run.bridge) {
        try { await run.bridge.stop() } catch {}
      }
      // If onExit didn't fire (already stopped or bridge null), set final state.
      if (this.runs.has(runId)) {
        this.setState(run, 'idle', { runId, lastExit: { code: 0, reason: 'user_stop' } })
      }
    } catch {
      // A setState→onLog write may throw (e.g. broken stdout pipe). Swallow —
      // logging must never abort stop(); the slot is freed in `finally`.
    } finally {
      // Slot release MUST happen even if a setState→onLog write threw (e.g. a
      // broken stdout pipe). Otherwise the slot leaks and eventually every
      // launch is denied `concurrency_cap`. This is the belt to logging's
      // suspenders (logging is now EPIPE-safe, but never depend on that here).
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

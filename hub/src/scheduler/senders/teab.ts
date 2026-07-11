/**
 * TEAB sender (Milestone TEAB / Phase TEAB-04).
 *
 * Routes a due `task_type: 'teab'` task to the supervisor host that owns the
 * target repo and issues the allowlisted `run_command teab_run` (the TEAB-01
 * wire contract). TEAB runs on the supervisor host where `teab`/`claude`/the
 * repos live; the containerized hub cannot see them.
 *
 * SCOPE — Phase TEAB-04 is DISPATCH ONLY:
 *   1. resolve the online supervisor that hosts `teab_repo_ident`,
 *   2. record the run as in-flight (run row → in_flight; task.teab_last_status →
 *      'started'),
 *   3. emit `run_command teab_run` with `args: [teab_repo_ident]`.
 *
 * The cost/token-cap + Claude-usage-threshold gates are enforced by the
 * dispatcher's pre-check (`fireTask` runs `checkUserThreshold` → `isOverCostCap`
 * BEFORE this sender is ever reached — see dispatcher.ts), exactly as the triage
 * and supervisor senders rely on. The cap therefore stays non-bypassable for
 * TEAB tasks without this sender re-implementing the gate.
 *
 * The background poll-to-terminal loop (poll `teab_status` → update
 * `teab_last_status` → `finalizeRun` → post-run action pipeline) is Phase
 * TEAB-05 and hooks the clearly-marked seam at the end of `sendTeabTask`.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { updateRunStatus } from '../../db/scheduled-tasks-dal.ts'
import { sql } from '../../db/postgres.ts'
import {
  getSupervisor,
  getUserInventory,
  listOnlineSupervisorIdsForUser,
  type UserInventory,
} from '../../ws/supervisor-registry.ts'
import { finalizeRun } from '../dispatcher.ts'
import { log } from '../../observability/logger'

interface RunCtxLike {
  runId: string
  taskId: string
  userId: string
  target?: { supervisorId?: string | null }
  isManual?: boolean
}

/**
 * Resolve which ONLINE supervisor should run a TEAB build for `repoIdent`
 * (`github://owner/repo` or `path://<abs>`). Prefers the supervisor whose most
 * recent inventory upload actually contains the repo; otherwise defaults to the
 * user's (sole / first) online supervisor. Returns null when none is online.
 */
export function resolveTeabSupervisorId(userId: string, repoIdent: string): string | null {
  const online = listOnlineSupervisorIdsForUser(userId)
  if (online.length === 0) return null
  if (online.length === 1) return online[0]

  // Multiple online supervisors: prefer the one whose inventory hosts the repo.
  const inv = getUserInventory(userId)
  if (inv && online.includes(inv.supervisor_id) && inventoryHasRepo(inv, repoIdent)) {
    return inv.supervisor_id
  }
  // Ambiguous — default to the first online supervisor. TEAB-05 may refine this
  // once per-supervisor inventory matching lands.
  return online[0]
}

function inventoryHasRepo(inv: UserInventory, repoIdent: string): boolean {
  const id = repoIdent.toLowerCase()
  if (id.startsWith('path://')) {
    const p = id.slice('path://'.length)
    return inv.repos.some((r) => (r.local_path ?? '').toLowerCase() === p)
  }
  if (id.startsWith('github://')) {
    return inv.repos.some((r) => {
      if (!r.git_origin_github) return false
      const k = `github://${r.git_origin_github.owner.toLowerCase()}/${r.git_origin_github.repo.toLowerCase()}`
      return k === id
    })
  }
  return false
}

/**
 * Supervisor-targeted TEAB dispatch. The dispatcher has already inserted the
 * `scheduled_task_runs` row (status='pending') and tracked the RunContext after
 * the cost/threshold gate pre-check, so this threads `ctx.runId` as the run +
 * finalize key.
 */
export async function sendTeabTask(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
  const repoIdent = task.teab_repo_ident
  if (!repoIdent) { await finalizeRun(ctx.runId, 'failed', 'no_teab_repo_ident'); return }

  // Resolve the online supervisor that hosts the repo. A pre-resolved id on the
  // ctx target wins (dispatcher may set it); otherwise resolve from the repo.
  const supervisorId = ctx.target?.supervisorId || resolveTeabSupervisorId(ctx.userId, repoIdent)
  if (!supervisorId) {
    // Mirror the agent sender's offline handling: finalize with a clear reason
    // rather than leaving the run pending forever.
    await finalizeRun(ctx.runId, 'skipped', 'no_online_supervisor')
    return
  }
  const entry = getSupervisor(supervisorId)
  if (!entry) {
    await finalizeRun(ctx.runId, 'skipped', 'no_online_supervisor')
    return
  }

  // Record the run as in-flight + mirror the last poll status onto the task row.
  // Best-effort: a persistence hiccup must not drop the dispatch.
  try { await updateRunStatus(ctx.runId, { status: 'in_flight' }) } catch {}
  try {
    await sql`UPDATE scheduled_tasks SET teab_last_status = 'started' WHERE id = ${task.id}`
  } catch {}

  // Issue the allowlisted run_command. Wire contract (TEAB-01): the supervisor
  // replies `run_started {run_id}` then `run_finished {run_id, exit_code,
  // snippet, error}`; TEAB-05 also polls `teab_status` to drive the (hours-long)
  // run to terminal independent of any subscriber.
  try {
    entry.ws.send(JSON.stringify({
      type: 'run_command',
      run_id: ctx.runId,
      command: 'teab_run',
      args: [repoIdent],
    }))
  } catch (err: any) {
    await finalizeRun(ctx.runId, 'failed', `supervisor_send_failed: ${err?.message}`)
    return
  }

  log.info('scheduler.teab.dispatched', {
    run_id: ctx.runId, task_id: task.id, supervisor_id: supervisorId, repo_ident: repoIdent,
  })

  // ─── TEAB-05 — background poll-to-terminal + finalize ───────────────────────
  // The run is now in-flight on the supervisor. Start a HUB-DRIVEN background
  // poll loop (no subscriber dependency → survives idle-teardown): on an
  // interval it issues `run_command teab_status`; replies + the supervisor's
  // `run_finished` terminal event are correlated in `handleTeabRunEvent`, which
  // updates `teab_last_status` from each poll and calls `finalizeRun` on the
  // terminal state (firing the post-run action pipeline). See `startTeabPoll`.
  startTeabPoll({ runId: ctx.runId, taskId: task.id, userId: ctx.userId, supervisorId })
}

// ─── TEAB-05: hub-driven poll-to-terminal loop ────────────────────────────────
//
// A long TEAB roadmap runs for HOURS on the supervisor host. The hub cannot
// hold a blocking turn open that long (idle-teardown reaps subscriber-less
// sessions), so completion is tracked by a hub-owned background poll that has
// NO subscriber dependency. The supervisor's `teab_run` handler returns an
// immediate started-ack (carrying its INTERNAL teab run id in the snippet); the
// actual build then runs detached. We capture that internal id from the ack,
// then poll `teab_status` on an interval until the build reports `exited` (or a
// max-duration ceiling lapses), updating `scheduled_tasks.teab_last_status` from
// each poll and finalizing the `scheduled_task_runs` row (which fires the
// post-run action pipeline: email/telegram/webhook).
//
// Env knobs (defaults are sane; documented for TEAB-07 docs):
//   • REMO_TEAB_POLL_INTERVAL_MS  — poll cadence, default 30000 (30s).
//   • REMO_TEAB_MAX_RUN_MS        — hard ceiling before a run is finalized as a
//                                   timeout failure, default 21600000 (6h).
//                                   COUPLED to the stale-run reaper: it reaps
//                                   `teab` rows only past
//                                   max(REMO_RUN_MAX_MS, REMO_TEAB_MAX_RUN_MS),
//                                   so a TEAB build is never reaped inside its
//                                   own poll window (run-reaper.ts).
//
// Read at poll-start (not module-load) so tests/operators can tune per run.

interface TeabPoll {
  /** Scheduled-run id (ctx.runId) — the finalize key + the run_command run_id. */
  runId: string
  taskId: string
  userId: string
  supervisorId: string
  /** The supervisor's INTERNAL teab run id, parsed from the started-ack. Null
   *  until the ack arrives; ticks no-op (except the deadline check) until set. */
  teabRunId: string | null
  startedAt: number
  /** Wall-clock ms after which the run is force-finalized as a timeout. */
  deadline: number
  interval: ReturnType<typeof setInterval> | null
  /** Terminal-once guard — finalize fires exactly once per run. */
  terminal: boolean
}

/** Active TEAB polls, keyed by scheduled-run id (ctx.runId). */
const teabPolls = new Map<string, TeabPoll>()

function teabPollIntervalMs(): number {
  const v = Number(process.env.REMO_TEAB_POLL_INTERVAL_MS)
  return Number.isFinite(v) && v > 0 ? v : 30_000
}
function teabMaxRunMs(): number {
  const v = Number(process.env.REMO_TEAB_MAX_RUN_MS)
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60 * 1000
}

async function setTeabLastStatus(taskId: string, status: string): Promise<void> {
  try {
    await sql`UPDATE scheduled_tasks SET teab_last_status = ${status} WHERE id = ${taskId}`
  } catch {
    // Best-effort mirror — a persistence hiccup must not break the poll loop.
  }
}

/** Clear the interval + drop the registry entry. Idempotent. No leaked timers. */
function clearTeabPoll(rec: TeabPoll): void {
  if (rec.interval) {
    clearInterval(rec.interval)
    rec.interval = null
  }
  teabPolls.delete(rec.runId)
}

/** Terminal-once finalize: guard, stop polling, finalize the run (→ post-run). */
async function finalizeTeabPoll(
  rec: TeabPoll,
  status: 'success' | 'failed',
  error: string | null,
  snippet?: string | null,
): Promise<void> {
  if (rec.terminal) return
  rec.terminal = true
  clearTeabPoll(rec)
  // Claim-then-finalize (`only_if_active`): the stale-run reaper can race this
  // poller on a long run. Whoever writes second finds the row already terminal,
  // gets no row back, and no-ops — no clobbered row, no re-fired post-run chain.
  await finalizeRun(rec.runId, status, error, {
    duration_ms: Date.now() - rec.startedAt,
    output_snippet: snippet ?? null,
    only_if_active: true,
  })
  log.info('scheduler.teab.finalized', {
    run_id: rec.runId, task_id: rec.taskId, status, error,
  })
}

function tailToSnippet(eventsTail: unknown): string | null {
  if (!Array.isArray(eventsTail) || eventsTail.length === 0) return null
  const joined = eventsTail.map((l) => String(l)).join('\n')
  return joined.length > 500 ? joined.slice(-500) : joined
}

/**
 * One poll tick: enforce the max-duration ceiling, then (once the internal teab
 * run id is known) emit `run_command teab_status`. The reply lands back in
 * `handleTeabRunEvent`. Exported under a test-prefixed alias below.
 */
async function teabPollTick(rec: TeabPoll): Promise<void> {
  if (rec.terminal) return
  if (Date.now() >= rec.deadline) {
    await setTeabLastStatus(rec.taskId, 'timeout')
    await finalizeTeabPoll(rec, 'failed', 'teab_run_timeout')
    return
  }
  if (!rec.teabRunId) return // still waiting for the started-ack
  const entry = getSupervisor(rec.supervisorId)
  if (!entry) return // supervisor offline — keep waiting until the deadline
  try {
    entry.ws.send(JSON.stringify({
      type: 'run_command',
      run_id: rec.runId,
      command: 'teab_status',
      args: [rec.teabRunId],
    }))
  } catch {
    // Transient send failure — the next tick retries.
  }
}

/**
 * Register + start the background poll for an in-flight TEAB run. Idempotent per
 * runId. The interval is `unref`'d so it never holds the process open on its
 * own. Exported so the dispatcher seam (and tests) can drive it.
 */
export function startTeabPoll(args: {
  runId: string
  taskId: string
  userId: string
  supervisorId: string
}): TeabPoll {
  const existing = teabPolls.get(args.runId)
  if (existing) return existing
  const now = Date.now()
  const rec: TeabPoll = {
    runId: args.runId,
    taskId: args.taskId,
    userId: args.userId,
    supervisorId: args.supervisorId,
    teabRunId: null,
    startedAt: now,
    deadline: now + teabMaxRunMs(),
    interval: null,
    terminal: false,
  }
  teabPolls.set(rec.runId, rec)
  const t = setInterval(() => { void teabPollTick(rec) }, teabPollIntervalMs())
  ;(t as any).unref?.()
  rec.interval = t
  return rec
}

/**
 * Correlate a supervisor `run_started`/`run_finished` event against an in-flight
 * TEAB poll. Returns true when the event belonged to a TEAB run (so the caller
 * knows it was handled). Three terminal/transition shapes are recognized via the
 * snippet payload:
 *
 *   1. started-ack          `{ run_id, started:true, pid }`  → capture the
 *      internal teab run id + kick an immediate status poll.
 *   2. teab_status reply     `{ state, exit_code, events_tail }` → mirror
 *      `teab_last_status`; on `state:'exited'` finalize success/failed by code.
 *   3. terminal `run_finished` (build-exit push or a failed/preflight ack) →
 *      finalize from `exit_code`/`error`. A 0-exit frame BEFORE the ack is
 *      ignored (defensive — never finalize success on a garbled ack).
 *
 * Terminal-once is enforced in `finalizeTeabPoll`, so a late duplicate event
 * (e.g. a poll reply racing a build-exit push) never double-finalizes.
 */
export async function handleTeabRunEvent(
  supervisorId: string,
  userId: string,
  msg: any,
): Promise<boolean> {
  const rec = teabPolls.get(msg?.run_id)
  if (!rec) return false
  if (rec.supervisorId !== supervisorId || rec.userId !== userId) return false
  if (msg.type === 'run_started') return true
  if (msg.type !== 'run_finished') return true

  let parsed: any = null
  if (typeof msg.snippet === 'string' && msg.snippet.length > 0) {
    try { parsed = JSON.parse(msg.snippet) } catch { /* not JSON — fall through */ }
  }

  // (1) started-ack — capture the internal teab run id, begin status polling.
  if (parsed && parsed.started === true && typeof parsed.run_id === 'string') {
    rec.teabRunId = parsed.run_id
    await setTeabLastStatus(rec.taskId, 'running')
    void teabPollTick(rec) // don't wait a full interval for the first status
    return true
  }

  // (2) teab_status reply — mirror state; finalize on exited.
  if (parsed && (parsed.state === 'running' || parsed.state === 'exited')) {
    await setTeabLastStatus(rec.taskId, parsed.state)
    if (parsed.state === 'exited') {
      const code = typeof parsed.exit_code === 'number' ? parsed.exit_code : null
      const ok = code === 0
      await finalizeTeabPoll(
        rec,
        ok ? 'success' : 'failed',
        ok ? null : `teab_exit_${code ?? 'unknown'}`,
        tailToSnippet(parsed.events_tail),
      )
    }
    return true
  }

  // (3) terminal run_finished (build-exit push / failed or preflight-failed ack).
  const err: string | null = msg.error ?? null
  const code: number | null = typeof msg.exit_code === 'number' ? msg.exit_code : null
  if (err || (code !== null && code !== 0)) {
    await setTeabLastStatus(rec.taskId, 'failed')
    await finalizeTeabPoll(
      rec,
      'failed',
      err ?? `teab_exit_${code ?? 'unknown'}`,
      typeof msg.snippet === 'string' ? msg.snippet.slice(-500) : null,
    )
    return true
  }
  if (rec.teabRunId) {
    // A clean run_finished AFTER the ack = the build's own terminal push.
    await setTeabLastStatus(rec.taskId, 'exited')
    await finalizeTeabPoll(rec, 'success', null,
      typeof msg.snippet === 'string' ? msg.snippet.slice(-500) : null)
    return true
  }
  // Unrecognized 0-exit frame before the ack — ignore (don't finalize success).
  return true
}

// ── Test-only helpers (drive ticks deterministically; inspect/reset state) ────
export function _teabPollTick(runId: string): Promise<void> {
  const rec = teabPolls.get(runId)
  if (!rec) return Promise.resolve()
  return teabPollTick(rec)
}
export function _getTeabPoll(runId: string): TeabPoll | undefined {
  return teabPolls.get(runId)
}
export function _resetTeabPolls(): void {
  for (const rec of teabPolls.values()) {
    if (rec.interval) clearInterval(rec.interval)
  }
  teabPolls.clear()
}

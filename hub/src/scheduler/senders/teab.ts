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

  // ─── TEAB-05 SEAM — background poll-to-terminal + finalize ──────────────────
  // The run is now in-flight on the supervisor. TEAB-05 hooks the poll loop
  // HERE: on an interval, send `run_command teab_status` (args:[runId]) to
  // `supervisorId`, update `teab_last_status` from each `{state, exit_code,
  // events_tail}` reply, and on a terminal state call
  // `finalizeRun(success|failed, …)` (which fires the post-run action pipeline:
  // email/telegram/webhook). The supervisor's `run_finished` event is the other
  // terminal seam. Until TEAB-05 lands the run stays in_flight by design.
}

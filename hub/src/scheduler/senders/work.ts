/**
 * Scheduler sender for one-time `task_type='work'` tasks (milestone once).
 *
 * WHAT THIS IS NOT: a re-implementation of the work verify/publish machinery.
 * `/api/ext/work` now enqueues each inbound work item as a `schedule_kind='once'`
 * scheduled_tasks row — the UNIFIED queue entry / Tasks-list + audit anchor — but
 * the actual run is still driven by the EXISTING `hub/src/work/dispatch.ts`
 * (`dispatchWork`), whose non-negotiable gate list (repo allowlist · work rate ·
 * cost/token cap · humanOnlyPty) and agent-proposes/hub-disposes publish flow are
 * left untouched. This sender is a thin adapter: reconstruct `DispatchWorkInput`
 * from the work_run row + payload, call `dispatchWork`, and finalize the
 * scheduled_task_run on the DISPATCH OUTCOME.
 *
 * TWO-LIFECYCLE MODEL (deliberate — see docs/scheduled-tasks.md §one-time):
 *   • scheduled_task_run  → "was the work item ACCEPTED into the pipeline?"
 *                           (finalized here, on dispatch acceptance).
 *   • work_runs           → the TYPED TERMINAL result (branch, hub_qc, published,
 *                           …), finalized by dispatchWork's poll-to-terminal flow.
 * The two are intentionally NOT bridged into one finalize — that would fork the
 * proven #368 verify/publish path. `GET /api/ext/work/:id` reads work_runs, which
 * remains the source of truth for the outcome.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { getWorkRun, findWorkSite } from '../../db/work-dal.ts'
import { dispatchWork } from '../../work/dispatch.ts'
import { finalizeRun } from '../dispatcher.ts'

interface RunCtxLike {
  runId: string
  userId: string
}

export async function sendWorkTask(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
  // only_if_active on every finalize: the scheduled_task_run is only written while
  // still non-terminal (pending/in_flight), so a raced finalizer (e.g. the
  // stale-run reaper) can never double-fire this run's post-run actions.
  const p = (task.payload ?? {}) as Record<string, any>
  const workId = p.work_id as string | undefined
  if (!workId) {
    await finalizeRun(ctx.runId, 'failed', 'work_payload_missing_work_id', { only_if_active: true })
    return
  }

  const work = await getWorkRun(workId, ctx.userId)
  if (!work) {
    await finalizeRun(ctx.runId, 'failed', 'work_run_not_found', { only_if_active: true })
    return
  }

  const site = await findWorkSite(ctx.userId, work.repo_ident, work.site_key)
  if (!site) {
    await finalizeRun(ctx.runId, 'failed', 'work_site_not_found', { only_if_active: true })
    return
  }

  const outcome = await dispatchWork({
    workId: work.id,
    userId: ctx.userId,
    apiKeyId: (p.api_key_id as string | null) ?? work.api_key_id ?? null,
    sessionId: work.session_id,
    repoIdent: work.repo_ident,
    nonce: work.nonce,
    prompt: work.prompt,
    site,
    projectDir: (p.project_dir as string) ?? site.site_dir,
    supervisorId: (p.supervisor_id as string | null) ?? null,
    branch: work.branch ?? `work/${work.nonce}`,
  })

  // Map the dispatch outcome to a terminal scheduled_task_run status. The work's
  // real result lands on work_runs (read by GET /api/ext/work/:id).
  const note = `work ${work.id} ${outcome.kind}; terminal result on work_runs`
  switch (outcome.kind) {
    case 'dispatched':
    case 'queued':
      await finalizeRun(ctx.runId, 'success', null, { output_snippet: note, only_if_active: true })
      return
    case 'skipped':
      await finalizeRun(ctx.runId, 'skipped', outcome.reason, { output_snippet: note, only_if_active: true })
      return
    case 'failed':
      await finalizeRun(ctx.runId, 'failed', outcome.reason, { output_snippet: note, only_if_active: true })
      return
  }
}

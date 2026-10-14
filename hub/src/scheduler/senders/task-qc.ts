/**
 * PTYCAP-08 task_qc sender: lifetime counter, deterministic engine pass, digest email, finalize.
 * Imports no dispatch pipeline, inject helper, macro module or agent sender
 * (FORK-1: zero model tokens). The only email path is the direct E4A helper.
 *
 * Order (D-19..D-22): read recipient -> reserve ONE lifetime-counter slot (key taskqc:<userId>,
 * token = run id, no rate enforcement; an exhausted counter skips the run before the engine) ->
 * engine pass with an injected kill-switch check anchored on the user only -> one digest when
 * there is something to report -> finalize. A thrown pass releases its reservation and is never
 * silent: one plain failure email per user per UTC day, a typed code, never the raw message.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { sql } from '../../db/postgres.ts'
import { sendEmail } from '../../lib/email.ts'
import { haltBeforeMachineSend, releaseInject, reserveInject } from '../../dispatch/automation-controls.ts'
import { runTaskQcPass } from '../../task-qc/engine.ts'
import { deliverDigest } from '../../task-qc/digest.ts'
import { boundedBegin, claimEngineFailure, isDeadlineError, makeDeadlineArmer, raceDeadline } from '../../task-qc/findings.ts'
import { clampBounds } from '../../task-qc/flags.ts'
import { safeText, type TaskQcResult } from '../../task-qc/types.ts'
import { finalizeRun } from '../dispatcher.ts'
import { log } from '../../observability/logger'

type EngineErrorCode = 'statement_timeout' | 'halt_check_required' | 'db_unavailable' | 'engine_error'

/** Fixed mapping from a thrown value to a typed code. The message is inspected, never emitted. */
function engineErrorCode(err: unknown): EngineErrorCode {
  const msg = err instanceof Error ? err.message : ''
  if (isDeadlineError(err)) return 'statement_timeout'
  if (msg === 'halt_check_required') return 'halt_check_required'
  if (/statement timeout|57014/i.test(msg)) return 'statement_timeout'
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|connection (terminated|closed|refused)|terminating connection|too many clients|CONNECTION_/i.test(msg)) {
    return 'db_unavailable'
  }
  return 'engine_error'
}

/** One plain failure email per user per UTC day (ENGINE claim row). Never throws. */
async function notifyEngineFailure(
  task: ScheduledTask,
  ctx: { runId: string; userId: string },
  to: string | undefined,
  code: EngineErrorCode,
): Promise<void> {
  try {
    const utcDay = new Date().toISOString().slice(0, 10)
    const first = await claimEngineFailure(sql as any, { userId: ctx.userId, taskId: task.id, utcDay })
    if (!first) return
    if (!to) {
      log.warn('scheduler.task_qc.no_recipient', { task_id: task.id, run_id: ctx.runId })
      return
    }
    const lines = [
      'The task quality audit failed and did not complete.',
      `run: ${safeText(ctx.runId, 64)}`,
      `task: ${safeText(task.id, 64)}`,
      `code: ${code}`,
      'Further failures today will not send another email.',
    ]
    await sendEmail({
      to,
      subject: 'Task quality audit failed',
      text: lines.join('\n') + '\n',
      html: lines.map((l) => `<p>${l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join(''),
    })
  } catch (err: any) {
    log.error('scheduler.task_qc.failure_notice_failed', { task_id: task.id, run_id: ctx.runId, error: err?.message })
  }
}

/** Only a DELIVERED digest marks its rows mailed; a failed send leaves them to be reported again. Never throws. */
async function markDelivered(userId: string, ids: string[], taskId: string, runId: string, deadline: number): Promise<void> {
  if (ids.length === 0) return
  try {
    // the database cancels the UPDATE at the run deadline; past it nothing is marked and the rows are
    // simply reported again by the next run (a duplicate mail, never a lost finding). The wait for a
    // pooled connection is raced against the deadline and the remaining time is recomputed INSIDE the
    // acquired callback (arm throws, so no statement is issued, once the deadline has passed).
    const arm = makeDeadlineArmer(deadline)
    await boundedBegin(
      (cb) => (sql as any).begin(cb),
      arm,
      async (tx: any) => {
        await arm(tx)
        await tx`UPDATE task_qc_findings SET digest_sent_at = now() WHERE user_id = ${userId} AND id = ANY(${ids}::text[])`
      },
    )
  } catch (err: any) {
    if (isDeadlineError(err)) return void log.warn('scheduler.task_qc.mark_delivered_deadline', { task_id: taskId, run_id: runId })
    log.error('scheduler.task_qc.mark_delivered_failed', { task_id: taskId, run_id: runId, error: err?.message })
  }
}

export async function sendTaskQcTask(
  task: ScheduledTask,
  ctx: { runId: string; userId: string; isManual?: boolean },
): Promise<void> {
  // ONE wall-clock bound for the whole run, started at claim: the recipient read, the counter
  // reservation, the engine pass and the digest send/mark all share it, and the run is always
  // finalized (never left open) when it expires.
  const deadline = Date.now() + clampBounds().passTimeoutMs
  const counterKey = `taskqc:${ctx.userId}`
  const expire = async (where: string): Promise<void> => {
    log.error('scheduler.task_qc.run_deadline', { task_id: task.id, run_id: ctx.runId, where })
    await finalizeRun(ctx.runId, 'failed', 'task_qc_engine_error:statement_timeout', { only_if_active: true })
  }

  let to: string | undefined
  try {
    const rows = (await raceDeadline(sql`SELECT email FROM users WHERE id = ${ctx.userId} LIMIT 1`, deadline)) as Array<{ email?: string }>
    to = rows[0]?.email
  } catch (err) {
    if (!isDeadlineError(err)) throw err
    return expire('recipient')
  }

  // D-22: one lifetime slot per run, after the caller's kill-switch gate and before the engine.
  const reservation = (async () => await reserveInject({
    userId: ctx.userId,
    sessionId: counterKey,
    token: ctx.runId,
    counterKey,
    actor: 'task-qc',
  }))()
  let reserved: Awaited<typeof reservation>
  try {
    reserved = await raceDeadline(reservation, deadline)
  } catch (err) {
    if (!isDeadlineError(err)) throw err
    // a reservation that lands after the deadline must not leak its slot
    void reservation.then((r) => (r.ok ? releaseInject({ counterKey, token: ctx.runId }) : undefined)).catch(() => {})
    return expire('reserve')
  }
  if (!reserved.ok) {
    await finalizeRun(ctx.runId, 'skipped', reserved.reason, { only_if_active: true })
    return
  }

  let result: TaskQcResult
  try {
    result = await runTaskQcPass({
      userId: ctx.userId,
      origin: ctx.isManual ? 'run_now' : 'schedule',
      // D-21: fresh read, user anchor only (no session), fail closed inside haltBeforeMachineSend
      deps: { deadline, haltCheck: async () => ({ halted: !(await haltBeforeMachineSend({ userId: ctx.userId })).ok }) },
    })
  } catch (err: any) {
    await releaseInject({ counterKey, token: ctx.runId })
    const code = engineErrorCode(err)
    log.error('scheduler.task_qc.engine_failed', { task_id: task.id, run_id: ctx.runId, code, error: err?.message ?? String(err) })
    await notifyEngineFailure(task, ctx, to, code)
    await finalizeRun(ctx.runId, 'failed', `task_qc_engine_error:${code}`, { only_if_active: true })
    return
  }

  // Report applied fixes plus every finding not yet mailed (see recordProposal: a row is reported
  // until a digest containing it was DELIVERED). The dedupe key includes the owner-local day, so a
  // still-true condition is re-recorded and re-mailed on a later day. Known window: the engine
  // gates only its WRITES on the kill switch; if it flips mid-pass the digest (read-only) is still
  // sent, and the next fire's own pre-pass check stops everything after.
  const report = {
    findings: [...result.applied.map((a) => a.finding), ...result.proposals],
    applied: result.applied,
    truncated: result.truncated,
  }
  let delivered = false
  if (report.findings.length > 0) {
    const left = Math.floor(deadline - Date.now())
    if (to && left <= 0) {
      // out of time: no email starts past the deadline; the rows stay unmailed and are reported next run
      log.warn('scheduler.task_qc.digest_deadline', { task_id: task.id, run_id: ctx.runId })
    } else if (to) {
      const sent = await deliverDigest(report, { email: to }, { sendTimeoutMs: left })
      delivered = sent.delivered
      if (!delivered) log.warn('scheduler.task_qc.digest_not_delivered', { task_id: task.id, run_id: ctx.runId })
      else {
        // only the findings the digest RENDERED were delivered; a size or count cut leaves the rest unmarked
        const shown = new Set<unknown>(sent.shown)
        const ids = (result.recorded ?? []).filter((r) => shown.has(r.finding)).map((r) => r.id)
        await markDelivered(ctx.userId, ids, task.id, ctx.runId, deadline)
      }
    } else {
      log.warn('scheduler.task_qc.no_recipient', { task_id: task.id, run_id: ctx.runId })
    }
  }

  const snippet = JSON.stringify({
    findings: result.findings.length,
    proposals: result.proposals.length,
    digest_delivered: delivered,
  })
  await finalizeRun(ctx.runId, 'success', null, { output_snippet: snippet, only_if_active: true })
}

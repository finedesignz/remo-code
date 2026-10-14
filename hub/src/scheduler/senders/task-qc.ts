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
import { sendDigest } from '../../task-qc/digest.ts'
import { claimEngineFailure } from '../../task-qc/findings.ts'
import { safeText, type TaskQcResult } from '../../task-qc/types.ts'
import { finalizeRun } from '../dispatcher.ts'
import { log } from '../../observability/logger'

type EngineErrorCode = 'statement_timeout' | 'halt_check_required' | 'db_unavailable' | 'engine_error'

/** Fixed mapping from a thrown value to a typed code. The message is inspected, never emitted. */
function engineErrorCode(err: unknown): EngineErrorCode {
  const msg = err instanceof Error ? err.message : ''
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

export async function sendTaskQcTask(
  task: ScheduledTask,
  ctx: { runId: string; userId: string; isManual?: boolean },
): Promise<void> {
  const rows = (await sql`SELECT email FROM users WHERE id = ${ctx.userId} LIMIT 1`) as Array<{ email?: string }>
  const to = rows[0]?.email

  // D-22: one lifetime slot per run, after the caller's kill-switch gate and before the engine.
  const counterKey = `taskqc:${ctx.userId}`
  const reserved = await reserveInject({
    userId: ctx.userId,
    sessionId: counterKey,
    token: ctx.runId,
    counterKey,
    actor: 'task-qc',
  })
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
      deps: { haltCheck: async () => ({ halted: !(await haltBeforeMachineSend({ userId: ctx.userId })).ok }) },
    })
  } catch (err: any) {
    await releaseInject({ counterKey, token: ctx.runId })
    const code = engineErrorCode(err)
    log.error('scheduler.task_qc.engine_failed', { task_id: task.id, run_id: ctx.runId, code, error: err?.message ?? String(err) })
    await notifyEngineFailure(task, ctx, to, code)
    await finalizeRun(ctx.runId, 'failed', `task_qc_engine_error:${code}`, { only_if_active: true })
    return
  }

  // Report what is new: applied fixes plus findings newly recorded this run (an unchanged,
  // already-reported condition is not re-mailed every day).
  const report = {
    findings: [...result.applied.map((a) => a.finding), ...result.proposals],
    applied: result.applied,
    truncated: result.truncated,
  }
  let delivered = false
  if (report.findings.length > 0) {
    if (to) {
      delivered = await sendDigest(report, { email: to })
      if (!delivered) log.warn('scheduler.task_qc.digest_not_delivered', { task_id: task.id, run_id: ctx.runId })
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

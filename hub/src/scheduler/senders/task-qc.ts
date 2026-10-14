/**
 * PTYCAP-08 task_qc sender: deterministic engine pass, digest email, finalize.
 * Imports no dispatch pipeline, inject helper, macro module or agent sender
 * (FORK-1: zero model tokens). The only email path is the direct E4A helper.
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { sql } from '../../db/postgres.ts'
import { sendEmail } from '../../lib/email.ts'
import { runTaskQcPass } from '../../task-qc/engine.ts'
import { buildDigest } from '../../task-qc/digest.ts'
import { finalizeRun } from '../dispatcher.ts'
import { log } from '../../observability/logger'

export async function sendTaskQcTask(
  task: ScheduledTask,
  ctx: { runId: string; userId: string; isManual?: boolean },
): Promise<void> {
  const result = await runTaskQcPass({ userId: ctx.userId, origin: ctx.isManual ? 'run_now' : 'schedule' })

  let delivered = false
  const digest = buildDigest({ findings: result.proposals, applied: result.applied, truncated: result.truncated }, {})
  if (digest) {
    const rows = (await sql`SELECT email FROM users WHERE id = ${ctx.userId} LIMIT 1`) as Array<{ email?: string }>
    const to = rows[0]?.email
    if (to) delivered = await sendEmail({ to, subject: digest.subject, html: digest.html, text: digest.text })
    else log.warn('scheduler.task_qc.no_recipient', { task_id: task.id, run_id: ctx.runId })
  }

  const snippet = JSON.stringify({
    findings: result.findings.length,
    proposals: result.proposals.length,
    digest_delivered: delivered,
  })
  await finalizeRun(ctx.runId, 'success', null, { output_snippet: snippet, only_if_active: true })
}

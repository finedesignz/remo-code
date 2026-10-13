/**
 * Supervisor sender (W2/T10).
 *
 * Sends a `run_command` WS message to a supervisor, then awaits the
 * run_started → run_output* → run_finished lifecycle and finalizes the
 * scheduled run with duration/snippet from the supervisor.
 *
 * Pre-flight: check `supervisor_commands` for (supervisor_id, kind='command', name=command).
 * Missing commands finalize as failed(command_not_available) immediately.
 */
import type { ServerWebSocket } from 'bun'
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { rearmOnceTask } from '../../db/scheduled-tasks-dal.ts'
import { sql } from '../../db/postgres.ts'
import { broadcastToUser } from '../../ws/registry.ts'
import { finalizeRun } from '../dispatcher.ts'
import { haltBeforeMachineSend } from '../../dispatch/automation-controls.ts'

interface PendingRun {
  runId: string
  taskId: string
  userId: string
  supervisorId: string
  startedAt: number
  buffer: string[]
}
const pending = new Map<string, PendingRun>()

interface RunCtxLike {
  runId: string
  taskId: string
  userId: string
  target: { supervisorId?: string | null; supervisorSocket?: ServerWebSocket<any> | null }
  onceClaimed?: boolean
}

async function commandExists(supervisorId: string, command: string): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM supervisor_commands
    WHERE supervisor_id = ${supervisorId} AND kind = 'command' AND name = ${command}
    LIMIT 1
  `
  return rows.length > 0
}

export async function sendSupervisorTask(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
  const supervisorId = ctx.target.supervisorId
  const sock = ctx.target.supervisorSocket
  if (!supervisorId || !sock) {
    await finalizeRun(ctx.runId, 'failed', 'supervisor_offline')
    return
  }
  const command = (task.payload as any)?.command || (task.payload as any)?.skill || ''
  if (!command) { await finalizeRun(ctx.runId, 'failed', 'no_command'); return }
  const args = ((task.payload as any)?.args ?? []) as string[]

  if (!(await commandExists(supervisorId, command))) {
    await finalizeRun(ctx.runId, 'failed', 'command_not_available')
    return
  }

  // QC B1: the dispatcher's halt check predates the pre-gates, the target resolution and
  // commandExists. A scheduled run_command is machine-initiated automation, so re-read the
  // kill switch fresh immediately before the transmission and finalize the run skipped.
  const pre = await haltBeforeMachineSend({ userId: ctx.userId })
  if (!pre.ok) {
    // R3: a CLAIMED one-time task must not be burned by the refusal; restore the claim so
    // the once-due sweep re-fires it after release. The skipped run below is the visible
    // record of this attempt even if the re-arm itself fails.
    if (task.schedule_kind === 'once' && ctx.onceClaimed === true) {
      try { await rearmOnceTask(task.id) } catch (err: any) {
        console.error(`[scheduler.supervisor] once re-arm failed task=${task.id}: ${err?.message ?? err}`)
      }
    }
    await finalizeRun(ctx.runId, 'skipped', pre.reason)
    return
  }

  pending.set(ctx.runId, {
    runId: ctx.runId, taskId: ctx.taskId, userId: ctx.userId,
    supervisorId, startedAt: Date.now(), buffer: [],
  })

  try {
    sock.send(JSON.stringify({
      type: 'run_command', run_id: ctx.runId, command, args,
    }))
  } catch (err: any) {
    pending.delete(ctx.runId)
    await finalizeRun(ctx.runId, 'failed', `supervisor_send_failed: ${err?.message}`)
  }
}

export async function handleSupervisorRunEvent(
  supervisorId: string, userId: string, msg: any,
): Promise<void> {
  const p = pending.get(msg.run_id)
  if (!p) return
  if (p.supervisorId !== supervisorId || p.userId !== userId) return

  if (msg.type === 'run_started') {
    broadcastToUser(userId, {
      type: 'scheduled_run_progress',
      run_id: p.runId, task_id: p.taskId, phase: 'started',
    })
    return
  }
  if (msg.type === 'run_output') {
    p.buffer.push(String(msg.chunk ?? ''))
    broadcastToUser(userId, {
      type: 'scheduled_run_progress',
      run_id: p.runId, task_id: p.taskId, phase: 'output', chunk: msg.chunk,
    })
    return
  }
  if (msg.type === 'run_finished') {
    pending.delete(p.runId)
    const ok = msg.error ? false : msg.exit_code === 0 || msg.exit_code == null
    const status = ok ? 'success' : 'failed'
    const snippetSrc = msg.snippet ?? p.buffer.join('').slice(-2000)
    const snippet = snippetSrc && snippetSrc.length > 500 ? snippetSrc.slice(-500) : snippetSrc
    await finalizeRun(p.runId, status, msg.error ?? null, {
      duration_ms: msg.duration_ms ?? Date.now() - p.startedAt,
      output_snippet: snippet || null,
    })
    return
  }
}

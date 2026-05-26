/**
 * Scheduler dispatcher (W2/T8).
 *
 * Cron callback → fire(task.id). Resolves targets, applies the daily cost
 * cap, inserts a pending run per target, and routes by task_type to the
 * appropriate sender (agent/supervisor/coolify). Offline targets are held
 * in the grace map for up to 10 min (T12).
 *
 * No retries by design — the only safety net is the offline-grace replay.
 */
import type { ScheduledTask, RunStatus } from '../db/scheduled-tasks-dal.ts'
import {
  getTaskById,
  insertRunV2,
  updateRunStatus,
  setTaskFireTimestamps,
  sumTodayCostForUser,
} from '../db/scheduled-tasks-dal.ts'
import { sql } from '../db/postgres.ts'
import { resolveTargets, type ResolvedTarget } from './targets.ts'
import * as registry from './registry.ts'
import * as queue from './session-queue.ts'
import { broadcastScheduledRun, broadcastToUser } from '../ws/registry.ts'
import { reserveSessionSlot, getCapacitySnapshot } from '../sessions/budget.ts'
import { checkUserThreshold } from '../usage/threshold.ts'

const MAX_CHAIN_DEPTH = 5

interface RunContext {
  runId: string
  taskId: string
  userId: string
  target: ResolvedTarget
  startedAt: number
  parentFireId?: string | null
  chainDepth: number
  triggeredByRunId?: string | null
}
const inFlightByRun = new Map<string, RunContext>()

export function getRunContext(runId: string): RunContext | null {
  return inFlightByRun.get(runId) ?? null
}
export function removeRunContext(runId: string): void { inFlightByRun.delete(runId) }
export function trackRun(ctx: RunContext): void { inFlightByRun.set(ctx.runId, ctx) }

async function isOverCostCap(userId: string, timezone: string): Promise<boolean> {
  const rows = await sql<{ cap: string }[]>`
    SELECT daily_cost_cap_usd::text AS cap FROM users WHERE id = ${userId} LIMIT 1
  `
  const cap = Number(rows[0]?.cap ?? 10)
  if (!Number.isFinite(cap) || cap <= 0) return false
  const spent = await sumTodayCostForUser(userId, timezone)
  return spent >= cap
}

export async function fire(taskId: string): Promise<void> {
  const task = await getTaskById(taskId)
  if (!task || !task.enabled) return
  await fireTask(task, { chainDepth: 0 })
}

export async function runNow(
  taskId: string,
  userId: string,
  opts: {
    triggeredByRunId?: string | null
    chainDepth?: number
    payloadOverride?: Record<string, unknown>
  } = {},
): Promise<void> {
  const task = await getTaskById(taskId)
  if (!task) return
  if (task.user_id !== userId) return
  // Phase 06 plan 008 — webhook-triggered triage passes per-event payload.
  if (opts.payloadOverride) {
    ;(task as any).payload = { ...(task.payload ?? {}), ...opts.payloadOverride }
  }
  const chainDepth = opts.chainDepth ?? 0
  if (chainDepth > MAX_CHAIN_DEPTH) {
    await insertRunV2({
      task_id: task.id,
      user_id: userId,
      status: 'failed',
      scheduled_for: new Date(),
      target_kind: task.target_kind,
      target_id: task.target_id,
      triggered_by_run_id: opts.triggeredByRunId ?? null,
      error: 'chain_depth_exceeded',
    })
    return
  }
  await fireTask(task, {
    chainDepth,
    triggeredByRunId: opts.triggeredByRunId ?? null,
    skipCronUpdate: true,
  })
}

interface FireOpts {
  chainDepth: number
  triggeredByRunId?: string | null
  skipCronUpdate?: boolean
}

async function fireTask(task: ScheduledTask, opts: FireOpts): Promise<void> {
  const now = new Date()
  const userId = task.user_id

  // Claude usage threshold gate — sits in front of the cost-cap gate.
  // Same shape, distinct status ('skipped_quota'). Persisting the run row
  // (rather than silently dropping) is required for the run-history drawer
  // and matches the cost-cap audit pattern.
  const threshold = await checkUserThreshold(userId)
  if (!threshold.allowed) {
    const errMsg = `quota_threshold_reached:${threshold.reason}:${threshold.utilization_pct}>=${threshold.threshold_pct}`
    const run = await insertRunV2({
      task_id: task.id,
      user_id: userId,
      status: 'skipped_quota',
      scheduled_for: now,
      target_kind: task.target_kind,
      target_id: task.target_id,
      triggered_by_run_id: opts.triggeredByRunId ?? null,
      error: errMsg,
    })
    broadcastScheduledRun(userId, {
      type: 'scheduled_run_finished',
      run_id: run.id, task_id: task.id, status: 'skipped_quota', error: errMsg,
    })
    void onRunFinalized(task, run.id, 'skipped_quota', errMsg)
    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
    return
  }

  if (await isOverCostCap(userId, task.timezone)) {
    const run = await insertRunV2({
      task_id: task.id,
      user_id: userId,
      status: 'skipped',
      scheduled_for: now,
      target_kind: task.target_kind,
      target_id: task.target_id,
      triggered_by_run_id: opts.triggeredByRunId ?? null,
      error: 'daily_cost_cap',
    })
    broadcastScheduledRun(userId, {
      type: 'scheduled_run_finished',
      run_id: run.id, task_id: task.id, status: 'skipped', error: 'daily_cost_cap',
    })
    void onRunFinalized(task, run.id, 'skipped', 'daily_cost_cap')
    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
    return
  }

  // Phase 06 plan 008 — triage tasks route through pickSessionTarget instead
  // of resolveTargets. They have no fixed target_kind/target_id; the sender
  // picks a supervisor (with capacity) or local agent at dispatch time.
  if (task.task_type === 'triage') {
    const run = await insertRunV2({
      task_id: task.id,
      user_id: userId,
      status: 'pending',
      scheduled_for: now,
      target_kind: 'session',
      target_id: null,
      triggered_by_run_id: opts.triggeredByRunId ?? null,
    })
    const ctx: RunContext = {
      runId: run.id,
      taskId: task.id,
      userId,
      target: { kind: 'session', sessionId: null, online: true },
      startedAt: now.getTime(),
      parentFireId: null,
      chainDepth: opts.chainDepth,
      triggeredByRunId: opts.triggeredByRunId ?? null,
    }
    trackRun(ctx)
    broadcastScheduledRun(userId, {
      type: 'scheduled_run_started',
      run_id: run.id,
      task_id: task.id,
      scheduled_for: now.toISOString(),
      target_kind: 'session',
      target_id: null,
    })
    try {
      const { sendTriage } = await import('./senders/triage.ts')
      void sendTriage(task, ctx, (task.payload ?? {}) as any).catch((err: any) => {
        console.error(
          `[scheduler.dispatcher] triage sender failed run=${run.id}: ${err?.message}`,
        )
        void finalizeRun(run.id, 'failed', err?.message || 'triage_threw')
      })
    } catch (err: any) {
      void finalizeRun(run.id, 'failed', err?.message || 'triage_import_failed')
    }
    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
    return
  }

  const targets = await resolveTargets(task, userId)
  if (targets.length === 0) {
    const run = await insertRunV2({
      task_id: task.id,
      user_id: userId,
      status: 'failed',
      scheduled_for: now,
      target_kind: task.target_kind,
      target_id: task.target_id,
      triggered_by_run_id: opts.triggeredByRunId ?? null,
      error: 'no_targets',
    })
    void onRunFinalized(task, run.id, 'failed', 'no_targets')
    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
    return
  }

  const isFanOut = task.target_kind === 'all_agents' || task.target_kind === 'all_supervisors'
  const parentFireId = isFanOut ? `fanout_${task.id}_${now.getTime()}` : null

  if (isFanOut) {
    try {
      const { register: aggRegister } = await import('./post-run/aggregator.ts')
      aggRegister(parentFireId!, task.id, userId, targets.length)
    } catch (err: any) {
      console.error(`[scheduler.dispatcher] aggregator register failed: ${err?.message}`)
    }
  }

  for (const target of targets) {
    const run = await insertRunV2({
      task_id: task.id,
      user_id: userId,
      status: 'pending',
      scheduled_for: now,
      target_kind: target.kind,
      target_id: target.sessionId ?? target.supervisorId ?? null,
      session_id: target.sessionId ?? null,
      triggered_by_run_id: opts.triggeredByRunId ?? null,
    })

    const ctx: RunContext = {
      runId: run.id,
      taskId: task.id,
      userId,
      target,
      startedAt: now.getTime(),
      parentFireId,
      chainDepth: opts.chainDepth,
      triggeredByRunId: opts.triggeredByRunId ?? null,
    }
    trackRun(ctx)

    broadcastScheduledRun(userId, {
      type: 'scheduled_run_started',
      run_id: run.id,
      task_id: task.id,
      scheduled_for: now.toISOString(),
      target_kind: target.kind,
      target_id: target.sessionId ?? target.supervisorId ?? null,
    })

    if (!target.online) {
      const key = target.sessionId ?? target.supervisorId
      if (key) {
        try {
          const grace = await import('./grace.ts')
          grace.registerPending(key, run.id)
        } catch {}
      }
      continue
    }

    // Plan 04-003: hub-authoritative concurrency gate. For supervisor-targeted
    // runs, reserve a session slot before dispatch. At-capacity skips the run
    // (mirrors the cost-cap skip pattern above — same shape, different reason).
    if (target.kind === 'supervisor' && target.supervisorId) {
      const reservation = await reserveSessionSlot(userId, target.supervisorId)
      if (!reservation.ok) {
        const reason = reservation.reason === 'at_capacity' ? 'at_capacity' : reservation.reason
        await updateRunStatus(run.id, {
          status: 'skipped',
          error: reason,
          finished_at: new Date(),
        })
        broadcastScheduledRun(userId, {
          type: 'scheduled_run_finished',
          run_id: run.id,
          task_id: task.id,
          status: 'skipped',
          error: reason,
        })
        inFlightByRun.delete(run.id)
        void onRunFinalized(task, run.id, 'skipped', reason)
        continue
      }
      // Broadcast capacity change so the UI re-renders without polling.
      try {
        const snap = await getCapacitySnapshot(userId, target.supervisorId)
        if (snap) {
          broadcastToUser(userId, {
            type: 'supervisor_capacity_changed',
            supervisor_id: target.supervisorId,
            running: snap.running,
            cap: snap.cap,
          })
        }
      } catch {}
    }

    void routeToSender(task, ctx).catch((err) => {
      console.error(
        `[scheduler.dispatcher] sender failed task=${task.id} run=${run.id}: ${err?.message ?? err}`,
      )
      void finalizeRun(run.id, 'failed', err?.message || 'sender_threw')
    })
  }

  if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
}

function updateFireTimestamps(taskId: string, fired: Date): void {
  const next = registry.nextRunFor(taskId)
  void setTaskFireTimestamps(taskId, fired, next)
}

export async function routeToSender(task: ScheduledTask, ctx: RunContext): Promise<void> {
  switch (task.task_type) {
    case 'prompt':
    case 'skill':
    case 'security_scan':
    case 'continue_dev': {
      const { sendAgentTask } = await import('./senders/agent.ts')
      await sendAgentTask(task, ctx)
      return
    }
    case 'log_check': {
      const { sendLogCheck } = await import('./senders/coolify.ts')
      await sendLogCheck(task, ctx)
      return
    }
    default: {
      if (ctx.target.kind === 'session' || ctx.target.kind === 'all_agents') {
        const { sendAgentTask } = await import('./senders/agent.ts')
        await sendAgentTask(task, ctx)
        return
      }
      const { sendSupervisorTask } = await import('./senders/supervisor.ts')
      await sendSupervisorTask(task, ctx)
    }
  }
}

export async function finalizeRun(
  runId: string,
  status: RunStatus,
  error?: string | null,
  fields: {
    cost_usd?: number | null
    duration_ms?: number | null
    output_snippet?: string | null
  } = {},
): Promise<void> {
  const ctx = inFlightByRun.get(runId)
  const finishedAt = new Date()
  const dur = fields.duration_ms !== undefined && fields.duration_ms !== null
    ? fields.duration_ms
    : ctx ? finishedAt.getTime() - ctx.startedAt : null

  const updated = await updateRunStatus(runId, {
    status,
    error: error ?? null,
    cost_usd: fields.cost_usd ?? null,
    duration_ms: dur,
    output_snippet: fields.output_snippet ?? null,
    finished_at: finishedAt,
  })

  if (ctx) {
    if (ctx.target.kind === 'session' && ctx.target.sessionId) {
      try { queue.markFinished(ctx.target.sessionId) } catch {}
    }
    inFlightByRun.delete(runId)
  }

  broadcastScheduledRun(updated?.user_id ?? ctx?.userId ?? '', {
    type: 'scheduled_run_finished',
    run_id: runId,
    task_id: ctx?.taskId ?? updated?.task_id ?? null,
    status,
    error: error ?? null,
    cost_usd: fields.cost_usd ?? null,
    duration_ms: dur,
    output_snippet: fields.output_snippet ?? null,
  })

  const task = ctx?.taskId
    ? await getTaskById(ctx.taskId)
    : updated?.task_id ? await getTaskById(updated.task_id) : null
  if (task) {
    await onRunFinalized(task, runId, status, error ?? null, {
      cost_usd: fields.cost_usd ?? null,
      duration_ms: dur,
      output_snippet: fields.output_snippet ?? null,
      parentFireId: ctx?.parentFireId ?? null,
      chainDepth: ctx?.chainDepth ?? 0,
    })
  }
}

interface PostRunPayload {
  cost_usd: number | null
  duration_ms: number | null
  output_snippet: string | null
  parentFireId?: string | null
  chainDepth: number
}

async function onRunFinalized(
  task: ScheduledTask,
  runId: string,
  status: RunStatus,
  error: string | null,
  extra: PostRunPayload = { cost_usd: null, duration_ms: null, output_snippet: null, chainDepth: 0 },
): Promise<void> {
  try {
    const { afterRun } = await import('./post-run/dispatcher.ts')
    await afterRun({
      task,
      runId,
      status,
      error,
      cost_usd: extra.cost_usd,
      duration_ms: extra.duration_ms,
      output_snippet: extra.output_snippet,
      parentFireId: extra.parentFireId ?? null,
      chainDepth: extra.chainDepth,
    })
  } catch (err: any) {
    console.error(
      `[scheduler.dispatcher] post-run dispatch failed task=${task.id} run=${runId}: ${err?.message}`,
    )
  }
}

export async function cancelRun(runId: string, userId: string): Promise<boolean> {
  const ctx = inFlightByRun.get(runId)
  if (ctx && ctx.userId !== userId) return false
  if (ctx?.target?.agentSocket) {
    try { ctx.target.agentSocket.send(JSON.stringify({ type: 'cancel', run_id: runId })) } catch {}
  }
  if (ctx?.target?.supervisorSocket) {
    try { ctx.target.supervisorSocket.send(JSON.stringify({ type: 'run_cancel', run_id: runId })) } catch {}
  }
  await finalizeRun(runId, 'cancelled', 'cancelled_by_user')
  return true
}

export function init(): void {
  queue.setOnPromote(async (sessionId, runId) => {
    const ctx = inFlightByRun.get(runId)
    if (!ctx) return
    const task = await getTaskById(ctx.taskId)
    if (!task) return
    // Re-evaluate the threshold gate at waiter promotion — the user may have
    // crossed the cap while the run was queued. Drop with skipped_quota.
    const t = await checkUserThreshold(ctx.userId)
    if (!t.allowed) {
      const errMsg = `quota_threshold_reached:${t.reason}:${t.utilization_pct}>=${t.threshold_pct}`
      await finalizeRun(runId, 'skipped_quota', errMsg)
      return
    }
    void routeToSender(task, ctx).catch((err) =>
      console.error(
        `[scheduler.dispatcher] promoted send failed run=${runId} session=${sessionId}: ${err?.message}`,
      ),
    )
  })
}

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
  countFiresForTask,
  disableTaskWithReason,
} from '../db/scheduled-tasks-dal.ts'
import { boundReason, type ScheduleRule } from './schedule-rules.ts'
import { isOverCostCap } from '../dispatch/gates.ts'
import { resolveTargets, type ResolvedTarget } from './targets.ts'
import * as registry from './registry.ts'
import { broadcastScheduledRun, broadcastToUser } from '../ws/registry.ts'
import { reserveSessionSlot, getCapacitySnapshot } from '../sessions/budget.ts'
import { checkUserThreshold } from '../usage/threshold.ts'
import { log } from '../observability/logger'

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
  /** Manual ("run now") dispatch — the agent sender fails fast on offline. */
  isManual?: boolean
}
const inFlightByRun = new Map<string, RunContext>()

// B4: keep the queue-depth gauge in sync. Dynamic require avoids a top-of-file
// dep tangle with the metrics module. Try/catch so a registry hiccup never
// breaks the scheduler hot path.
function syncQueueDepthGauge(): void {
  try {
    const { scheduledQueueDepth } = require('../observability/metrics')
    scheduledQueueDepth.set(inFlightByRun.size)
  } catch {}
}

export function getRunContext(runId: string): RunContext | null {
  return inFlightByRun.get(runId) ?? null
}
export function removeRunContext(runId: string): void {
  inFlightByRun.delete(runId)
  syncQueueDepthGauge()
}
export function trackRun(ctx: RunContext): void {
  inFlightByRun.set(ctx.runId, ctx)
  syncQueueDepthGauge()
}

export async function fire(taskId: string): Promise<void> {
  const task = await getTaskById(taskId)
  if (!task || !task.enabled) return
  // P1 end-bounds: scheduled (cron) fires honor `until`/`max_runs`. When a
  // bound is reached we auto-disable the task (so it stops cleanly + surfaces
  // a "completed" reason) and skip this fire. Manual run-now / chained runs go
  // through `runNow`, which intentionally bypasses bounds.
  const rules: ScheduleRule[] = Array.isArray(task.schedule_rules) ? task.schedule_rules : []
  if (rules.length > 0) {
    const hasBound = rules.some(r => r.until || typeof r.max_runs === 'number')
    if (hasBound) {
      const totalFires = await countFiresForTask(taskId)
      const reason = boundReason(rules, new Date(), totalFires)
      if (reason) {
        log.info('scheduler.dispatcher.bound_reached', { task_id: taskId, reason, total_fires: totalFires })
        try { await disableTaskWithReason(taskId, reason) } catch (err: any) {
          log.error('scheduler.dispatcher.auto_disable_failed', { task_id: taskId, error: err?.message })
        }
        try {
          const reg = await import('./registry.ts')
          reg.unregister(taskId)
        } catch {}
        return
      }
    }
  }
  await fireTask(task, { chainDepth: 0 })
}

export async function runNow(
  taskId: string,
  userId: string,
  opts: {
    triggeredByRunId?: string | null
    chainDepth?: number
    payloadOverride?: Record<string, unknown>
    isManual?: boolean
  } = {},
): Promise<{ runIds: string[] }> {
  const task = await getTaskById(taskId)
  if (!task) return { runIds: [] }
  if (task.user_id !== userId) return { runIds: [] }
  // Phase 06 plan 008 — webhook-triggered triage passes per-event payload.
  if (opts.payloadOverride) {
    ;(task as any).payload = { ...(task.payload ?? {}), ...opts.payloadOverride }
  }
  const chainDepth = opts.chainDepth ?? 0
  if (chainDepth > MAX_CHAIN_DEPTH) {
    const r = await insertRunV2({
      task_id: task.id,
      user_id: userId,
      status: 'failed',
      scheduled_for: new Date(),
      target_kind: task.target_kind,
      target_id: task.target_id,
      triggered_by_run_id: opts.triggeredByRunId ?? null,
      error: 'chain_depth_exceeded',
    })
    return { runIds: [r.id] }
  }
  return await fireTask(task, {
    chainDepth,
    triggeredByRunId: opts.triggeredByRunId ?? null,
    skipCronUpdate: true,
    isManual: opts.isManual === true,
  })
}

interface FireOpts {
  chainDepth: number
  triggeredByRunId?: string | null
  skipCronUpdate?: boolean
  isManual?: boolean
}

async function fireTask(task: ScheduledTask, opts: FireOpts): Promise<{ runIds: string[] }> {
  const now = new Date()
  const userId = task.user_id
  const runIds: string[] = []
  const isManual = opts.isManual === true

  // Claude usage threshold gate — sits in front of the cost-cap gate.
  // Same shape, distinct status ('skipped_quota'). Persisting the run row
  // (rather than silently dropping) is required for the run-history drawer
  // and matches the cost-cap audit pattern.
  const threshold = await checkUserThreshold(userId)
  if (!threshold.allowed) {
    const errMsg = `quota_threshold_reached:${threshold.reason}:${threshold.utilization_pct}>=${threshold.threshold_pct}`
    log.warn('scheduler.dispatcher.skipped_quota', {
      task_id: task.id, user_id: userId,
      reason: threshold.reason, utilization_pct: threshold.utilization_pct, threshold_pct: threshold.threshold_pct,
    })
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
    log.warn('scheduler.dispatcher.cost_cap_hit', { task_id: task.id, user_id: userId })
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
    runIds.push(run.id)
    return { runIds }
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
        log.error('scheduler.dispatcher.triage_sender_failed', { run_id: run.id, task_id: task.id, error: err?.message })
        void finalizeRun(run.id, 'failed', err?.message || 'triage_threw')
      })
    } catch (err: any) {
      void finalizeRun(run.id, 'failed', err?.message || 'triage_import_failed')
    }
    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
    runIds.push(run.id)
    return { runIds }
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
      error: isManual ? 'target_offline' : 'no_targets',
    })
    broadcastScheduledRun(userId, {
      type: 'scheduled_run_finished',
      run_id: run.id, task_id: task.id, status: 'failed',
      error: isManual ? 'target_offline' : 'no_targets',
    })
    void onRunFinalized(task, run.id, 'failed', isManual ? 'target_offline' : 'no_targets')
    if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
    runIds.push(run.id)
    return { runIds }
  }

  const isFanOut = task.target_kind === 'all_agents' || task.target_kind === 'all_supervisors'
  const parentFireId = isFanOut ? `fanout_${task.id}_${now.getTime()}` : null

  if (isFanOut) {
    try {
      const { register: aggRegister } = await import('./post-run/aggregator.ts')
      aggRegister(parentFireId!, task.id, userId, targets.length)
    } catch (err: any) {
      log.error('scheduler.dispatcher.aggregator_register_failed', { task_id: task.id, error: err?.message })
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
      isManual,
    }
    trackRun(ctx)
    runIds.push(run.id)

    broadcastScheduledRun(userId, {
      type: 'scheduled_run_started',
      run_id: run.id,
      task_id: task.id,
      scheduled_for: now.toISOString(),
      target_kind: target.kind,
      target_id: target.sessionId ?? target.supervisorId ?? null,
    })

    // Round-2 migration: SESSION-targeted runs (session / all_agents) no longer
    // pre-check offline here — the agent sender routes online-check → per-session
    // queue → grace park → send through the shared `dispatch()` pipeline, which
    // parks offline targets in the shared grace buffer (keyed by sessionId,
    // drained on agent reconnect) and fails manual runs fast. So fall through to
    // routeToSender for online AND offline session targets.
    //
    // SUPERVISOR-targeted runs (supervisor / all_supervisors) keep the
    // dispatcher's offline pre-check + concurrency gate; only their grace
    // mechanism moved to the shared buffer (scheduler/grace.ts deleted).
    const isSessionTarget = target.sessionId != null

    if (!isSessionTarget && !target.online) {
      if (isManual) {
        // Manual run: fail fast with target_offline so the UI gets immediate
        // feedback instead of a row that lingers pending until grace expires.
        await updateRunStatus(run.id, {
          status: 'failed', error: 'target_offline', finished_at: new Date(),
        })
        broadcastScheduledRun(userId, {
          type: 'scheduled_run_finished',
          run_id: run.id, task_id: task.id, status: 'failed', error: 'target_offline',
        })
        inFlightByRun.delete(run.id); syncQueueDepthGauge()
        void onRunFinalized(task, run.id, 'failed', 'target_offline')
        continue
      }
      const key = target.supervisorId
      if (key) {
        // Shared grace buffer: park a replay thunk keyed by supervisorId; the
        // supervisor reconnect drain re-runs it (mark old row replayed +
        // runNow), TTL lapse marks the run skipped/target_offline. Replaces the
        // deleted scheduler/grace.ts registerPending/drainForTarget pair.
        try {
          const { getGraceBuffer } = await import('../dispatch/grace.ts')
          const runId = run.id
          const taskId = task.id
          getGraceBuffer().register(
            key,
            async () => {
              await updateRunStatus(runId, {
                status: 'skipped', error: 'replayed_on_reconnect', finished_at: new Date(),
              })
              await runNow(taskId, userId, {})
            },
            {
              onExpire: async () => {
                await updateRunStatus(runId, {
                  status: 'skipped', error: 'target_offline', finished_at: new Date(),
                })
              },
            },
          )
        } catch {}
      }
      continue
    }

    // Manual session runs that are offline: fail fast (the sender also guards
    // this, but doing it here avoids inserting a pipeline grace entry path).
    // Non-manual offline session runs fall through to the sender, which parks.

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
        inFlightByRun.delete(run.id); syncQueueDepthGauge()
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
      log.error('scheduler.dispatcher.sender_failed', { task_id: task.id, run_id: run.id, error: err?.message ?? String(err) })
      void finalizeRun(run.id, 'failed', err?.message || 'sender_threw')
    })
  }

  if (!opts.skipCronUpdate) updateFireTimestamps(task.id, now)
  return { runIds }
}

function updateFireTimestamps(taskId: string, fired: Date): void {
  const next = registry.nextRunFor(taskId)
  void setTaskFireTimestamps(taskId, fired, next)
}

export async function routeToSender(task: ScheduledTask, ctx: RunContext): Promise<void> {
  switch (task.task_type) {
    // Phase 11: user-pickable workflow roots + chained step kinds route to
    // the agent sender. `log_check` (root) still routes to coolify log-pull
    // until the `log_pull` chained step is wired in Wave 2.
    case 'dev':
    case 'security':
    case 'dev_plan':
    case 'dev_execute':
    case 'dev_ship':
    case 'security_scan':
    case 'security_triage':
    case 'security_fix_or_issue':
    case 'log_classify':
    case 'log_triage': {
      const { sendAgentTask } = await import('./senders/agent.ts')
      await sendAgentTask(task, ctx)
      return
    }
    case 'log_check':
    case 'log_pull': {
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
    // Round-2 migration: the per-session queue slot is released by the shared
    // pipeline (`dispatch.onSessionReply` → `queue.markFinished` on its own
    // queue) when the agent reply lands. The scheduler no longer owns a queue
    // slot here, so there is nothing to release on this side.
    inFlightByRun.delete(runId); syncQueueDepthGauge()
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
    log.error('scheduler.dispatcher.post_run_failed', { task_id: task.id, run_id: runId, error: err?.message })
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

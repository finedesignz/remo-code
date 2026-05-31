/**
 * Post-run action dispatcher (W2/T8.5).
 *
 * Called by scheduler/dispatcher.ts after a run finalizes. For each
 * matching post_run_action on the task:
 *   - check the `on` condition against the run status (incl. cost_exceeded
 *     when error === 'daily_cost_cap')
 *   - apply delay_seconds via setTimeout (timers tracked for shutdown)
 *   - route to the right executor under ./
 *
 * For fan-out parent fires (target_kind === 'all_*'): instead of firing
 * actions per child finalize, route through the aggregator (T8.7) which
 * collects all child results and fires actions ONCE with an aggregate.
 */
import type { ScheduledTask, RunStatus } from '../../db/scheduled-tasks-dal.ts'
import { listActionsForTask } from '../../db/scheduled-tasks-dal.ts'
import { validatePostRunActions, type PostRunAction } from './schema.ts'
import { executeChain } from './chain.ts'
import { getTaskById } from '../../db/scheduled-tasks-dal.ts'
import { parseControllerDecision, nextStepForAction } from '../controller-schema.ts'
import { executeEmail } from './email.ts'
import { executeTelegram } from './telegram.ts'
import { executeWebPush } from './webpush.ts'
import { executeWebhook } from './webhook.ts'
import { executeGithubIssue } from './github-issue.ts'
import { report as aggregatorReport } from './aggregator.ts'

const MAX_CHAIN_DEPTH = 5
const RUN_URL_PREFIX = process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com'

const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

export function clearPendingTimers(): void {
  for (const t of pendingTimers) clearTimeout(t)
  pendingTimers.clear()
}

interface AfterRunArgs {
  task: ScheduledTask
  runId: string
  status: RunStatus
  error: string | null
  cost_usd: number | null
  duration_ms: number | null
  output_snippet: string | null
  parentFireId: string | null
  chainDepth: number
}

export async function afterRun(args: AfterRunArgs): Promise<void> {
  if (args.parentFireId) {
    await aggregatorReport(
      args.parentFireId,
      args.task,
      { status: args.status, error: args.error },
      {
        cost_usd: args.cost_usd,
        duration_ms: args.duration_ms,
        output_snippet: args.output_snippet,
      },
    )
    return
  }
  await fireWithContext(args)
}

interface FireCtxArgs extends AfterRunArgs {
  aggregate?: { total: number; successes: number; failures: number }
}

export async function fireWithContext(args: FireCtxArgs): Promise<void> {
  const actionsRaw = await listActionsForTask(args.task.id)
  const parsed = validatePostRunActions(actionsRaw)
  if (!parsed.ok) {
    console.warn(
      `[post-run.dispatcher] task=${args.task.id} actions invalid: ${parsed.errors.join('; ')}`,
    )
    return
  }
  const actions = parsed.value
  if (actions.length === 0) return

  if (args.chainDepth >= MAX_CHAIN_DEPTH) {
    console.warn(
      `[post-run.dispatcher] task=${args.task.id} chain_depth_exceeded depth=${args.chainDepth}`,
    )
    return
  }

  const ctx = buildContext(args)

  // auto-dev P2: controller routing. A bare `dev` root or an explicit
  // `dev_controller` step emits a `<<DECISION>>` block; we chain ONLY the step
  // its action selects (`propose` → no chain) and SUPPRESS the generic
  // `chain_task` fan-out for this run so we never double-fire or fire the wrong
  // sibling. Non-chain actions (notify/webhook/…) still fire normally below.
  const isController =
    (args.task.task_type === 'dev' || args.task.task_type === 'dev_controller') &&
    args.status === 'success'
  let controllerHandled = false
  if (isController) {
    controllerHandled = await routeControllerDecision(args, actions)
  }

  for (const action of actions) {
    // Suppress generic chain_task for a controller run — its routing already
    // fired (or intentionally skipped, e.g. `propose`).
    if (controllerHandled && action.type === 'chain_task') continue
    if (!conditionMatches(action, args)) continue
    const delay = (action.delay_seconds ?? 0) * 1000
    if (delay > 0) {
      const timer = setTimeout(() => {
        pendingTimers.delete(timer)
        void executeAction(action, args, ctx)
      }, delay)
      pendingTimers.add(timer)
    } else {
      void executeAction(action, args, ctx)
    }
  }
}

/**
 * auto-dev P2 — controller decision router.
 *
 * Parses the run's `<<DECISION>>` block and chains the single workflow step the
 * action selects, by matching the decision's target step kind against the
 * child task_type of the task's existing `chain_task` edges. `propose` chains
 * nothing (human-in-the-loop; surfaced to chat in P3). A missing/malformed block
 * falls back to `continue` so a bare dev still resumes.
 *
 * Returns true to signal the caller to SUPPRESS the generic `chain_task` loop
 * for this run (controller owns the chain decision).
 */
export async function routeControllerDecision(
  args: FireCtxArgs,
  actions: PostRunAction[],
): Promise<boolean> {
  const parsed = parseControllerDecision(args.output_snippet ?? '')
  const decision = parsed.ok ? parsed.value : parsed.fallback
  const nextStep = nextStepForAction(decision.action)

  if (nextStep === null) {
    // propose → no chain. The roadmap is already persisted in the assistant
    // message + Summary line; P3 wires chat/notify surfacing.
    console.log(
      `[post-run.controller] task=${args.task.id} action=propose no_chain reason="${decision.reason}"`,
    )
    return true
  }

  // Resolve which chain_task edge points at the selected step kind.
  const chainEdges = actions.filter((a) => a.type === 'chain_task' && a.config?.task_id)
  let matched: PostRunAction | null = null
  for (const edge of chainEdges) {
    const child = await getTaskById(edge.config.task_id)
    if (child && child.task_type === nextStep) {
      matched = edge
      break
    }
  }

  if (!matched) {
    // No wired step for this action (e.g. a bare `dev` row with no workflow
    // chain configured). Nothing to chain — safe no-op, do not invent rows.
    console.log(
      `[post-run.controller] task=${args.task.id} action=${decision.action} ` +
        `no_chain_edge_for=${nextStep}`,
    )
    return true
  }

  console.log(
    `[post-run.controller] task=${args.task.id} action=${decision.action} chain=${nextStep} child=${matched.config.task_id}`,
  )
  await executeChain(matched, {
    parentRunId: args.runId,
    userId: args.task.user_id,
    chainDepth: args.chainDepth,
    parentTaskKind: args.task.task_type,
  })
  return true
}

function conditionMatches(action: PostRunAction, args: FireCtxArgs): boolean {
  switch (action.on) {
    case 'always': return true
    case 'success': return args.status === 'success'
    case 'failure':
      return args.status === 'failed' || args.status === 'skipped' || args.status === 'cancelled'
    case 'cost_exceeded': return args.error === 'daily_cost_cap'
    default: return false
  }
}

function buildContext(args: FireCtxArgs): Record<string, unknown> {
  return {
    task_name: args.task.name,
    task_id: args.task.id,
    status: args.status,
    error: args.error ?? '',
    output_snippet: args.output_snippet ?? '',
    cost_usd: args.cost_usd ?? 0,
    duration_ms: args.duration_ms ?? 0,
    run_url: `${RUN_URL_PREFIX}/schedules/runs/${args.runId}`,
    user_id: args.task.user_id,
    chain_depth: args.chainDepth,
    aggregate_total: args.aggregate?.total ?? null,
    aggregate_successes: args.aggregate?.successes ?? null,
    aggregate_failures: args.aggregate?.failures ?? null,
  }
}

async function executeAction(
  action: PostRunAction,
  args: FireCtxArgs,
  templateVars: Record<string, unknown>,
): Promise<void> {
  try {
    switch (action.type) {
      case 'chain_task':
        await executeChain(action, {
          parentRunId: args.runId,
          userId: args.task.user_id,
          chainDepth: args.chainDepth,
        })
        return
      case 'notify_email':
        await executeEmail(action, { userId: args.task.user_id, templateVars })
        return
      case 'notify_telegram':
        await executeTelegram(action, { userId: args.task.user_id, templateVars })
        return
      case 'notify_web_push':
        await executeWebPush(action, { userId: args.task.user_id, templateVars })
        return
      case 'webhook':
        await executeWebhook(action, {
          userId: args.task.user_id,
          payload: { ...templateVars, run_id: args.runId, event: 'scheduled_task.run.finished' },
        })
        return
      case 'github_issue':
        await executeGithubIssue(action, {
          userId: args.task.user_id,
          templateVars,
          runId: args.runId,
        })
        return
    }
  } catch (err: any) {
    console.error(
      `[post-run.dispatcher] action ${action.type} failed task=${args.task.id}: ${err?.message}`,
    )
  }
}

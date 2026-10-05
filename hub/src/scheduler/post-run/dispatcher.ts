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
import { parseQcFindings, findingHash } from '../qc-schema.ts'
import { isTerminalSummary } from '../summary-line.ts'
import { hasVerifiedFinding, recordVerifiedFinding } from '../../db/dal.ts'
import { findQcReviewSnippetForRun, getRun } from '../../db/scheduled-tasks-dal.ts'
import { executeEmail } from './email.ts'
import { executeTelegram } from './telegram.ts'
import { executeWebPush } from './webpush.ts'
import { executeWebhook } from './webhook.ts'
import { executeGithubIssue } from './github-issue.ts'
import { executeDeployVerify } from './deploy-verify.ts'
import { report as aggregatorReport } from './aggregator.ts'
import { surfaceProposal } from './propose-notify.ts'
import { reportSelfErrorToAgentautofix, reportTriageFindingToAgentautofix, scrub } from '../../agentautofix/reporter.ts'
import { INTERNAL_TRIAGE_TASK_NAME, claimTriageFindingForward } from '../../db/dal.ts'
import { parseTriageOutput, type TriageResult } from '../triage-schema.ts'

const MAX_CHAIN_DEPTH = 5
const RUN_URL_PREFIX = process.env.REMO_PUBLIC_URL || 'https://app.remo-code.com'

const pendingTimers = new Set<ReturnType<typeof setTimeout>>()

/**
 * feat/scheduled-default-email-summary — synthesize a default run-summary email.
 *
 * Every ROOT scheduled-task run (chainDepth===0) emails the task owner a summary
 * BY DEFAULT unless: the task opted out (`email_summary === false`), OR it already
 * configures its own `notify_email` action (respect the user's config; don't
 * double-send). Internal chain/controller/qc steps (chainDepth>0) never synthesize.
 *
 * CHAINED steps (chainDepth>0) stay silent on success — one email per chain step
 * would be spam — but a chained step that FAILED or self-reported `BLOCKED` must
 * still reach the owner. Prod: a `dev_ship` step emitting `Summary: BLOCKED: ...`
 * produced ZERO notification, so an unattended chain could wedge invisibly.
 *
 * `to` is omitted so executeEmail resolves it to the owner's account email. The
 * template uses only plain `{{var}}` substitutions (template.render supports no
 * conditionals/sections). Pure helper — unit-tested in isolation.
 *
 * Internal-plumbing exception: `__internal_*` tasks (`__internal_coolify_deployment`,
 * `__internal_triage` — see db/dal.ts INTERNAL_DEPLOY_TASK_NAME/INTERNAL_TRIAGE_TASK_NAME)
 * are machine-created anchors the owner never scheduled, never sees in the tasks UI,
 * and cannot set `email_summary: false` on. They ALSO never get a default success
 * email — success is the routine, expected outcome of a machine-scheduled internal
 * task and mailing the owner on every run (see the `__internal_triage` Coolify-token
 * incident, 2026-09-30 — the owner was emailed from support@remo-code.com on every
 * run, including success) is exactly the noise this default-email feature exists to
 * avoid for user tasks too. An internal task only emails the owner when the run
 * genuinely failed or self-reported BLOCKED (`isFailedOrBlocked`) — `success` and
 * `skipped` are both silent BY DEFAULT. A genuine `failed`/blocked run on an
 * internal task still emails (belt-and-suspenders alongside the best-effort
 * AgentAutofix forward in `handleInternalTriageRun` below), and none of this
 * touches user-created tasks. A `success` triage run carrying an actionable
 * finding is forwarded to AgentAutofix by `handleInternalTriageRun`. A `success`
 * internal-task run still reaches the owner's inbox in exactly two cases: the
 * triage finding is `high`/`critical` (`isHighSeverityTriageFinding` — it is about
 * the owner's own failing app, and the AAF forward lands in the hub's self-capture
 * inbox, not the user's repo), or a low/medium finding's AAF forward itself fails
 * (see `handleInternalTriageRun`).
 */
export function buildDefaultEmailActions(
  task: ScheduledTask,
  chainDepth: number,
  actions: PostRunAction[],
  outcome?: { status: RunStatus; output_snippet: string | null },
): PostRunAction[] {
  if (chainDepth !== 0 && !isFailedOrBlocked(outcome)) return []
  if ((task as any).email_summary === false) return []
  if (actions.some((a) => a.type === 'notify_email')) return []
  if (
    task.name?.startsWith('__internal_') &&
    !isFailedOrBlocked(outcome) &&
    !isHighSeverityTriageFinding(task, outcome)
  ) return []
  return [
    {
      type: 'notify_email',
      on: 'always',
      config: {
        subject: 'Remo task "{{task_name}}" — {{status}}',
        body: [
          'Task: {{task_name}}',
          'Status: {{status}}',
          'Cost: ${{cost_usd}}   Duration: {{duration_ms}}ms',
          '{{error}}',
          '---',
          '{{output_snippet}}',
          '---',
          'View run: {{run_url}}',
        ].join('\n'),
      },
    } as PostRunAction,
  ]
}

/**
 * A `__internal_triage` run that finalized `success` but whose JSON finding is
 * `high`/`critical`. That finding is about the OWNER'S own failing deployment, and
 * the AgentAutofix forward in `handleInternalTriageRun` lands in the hub's own
 * (remo-code) self-capture inbox, not the user's repo — so a serious finding must
 * still reach the owner by email. low/medium stay silent (noise reduction).
 */
export function isHighSeverityTriageFinding(
  task: ScheduledTask,
  outcome?: { status: RunStatus; output_snippet: string | null },
): boolean {
  if (task.name !== INTERNAL_TRIAGE_TASK_NAME) return false
  if (outcome?.status !== 'success') return false
  const parsed = parseTriageOutput(outcome.output_snippet ?? '')
  return parsed.ok && (parsed.value.severity === 'high' || parsed.value.severity === 'critical')
}

/**
 * A run the owner must hear about even mid-chain: a hard failure, or a step whose
 * output carries a terminal `Summary:` verdict — BLOCKED / FAILED / SKIPPED /
 * DEPLOY UNHEALTHY (the workflow prompts' convention for "I stopped without
 * finishing"). All of those wedge a chain identically while the run itself
 * finalizes `success`.
 */
export function isFailedOrBlocked(
  outcome?: { status: RunStatus; output_snippet: string | null },
): boolean {
  if (!outcome) return false
  if (outcome.status === 'failed') return true
  return isTerminalSummary(outcome.output_snippet)
}

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

/**
 * Resolve the REAL Coolify `deployment_uuid` a `__internal_triage` run was
 * dispatched for. The webhook (api/coolify-webhook.ts) dispatches triage with
 * `triggeredByRunId` = the deployment metadata run, which `insertDeploymentRun`
 * stamps with `deployment_uuid`; the triage run row itself normally carries none.
 * (The per-event `payloadOverride` lives only on the in-memory task and is gone
 * by finalize — `finalizeRun` reloads the task from the DB.) Returns null when no
 * uuid is recoverable; the caller then skips dedup and delivers. Never derived
 * from model prose: a regex over free text matches ordinary words and would
 * collide unrelated deployments, silently suppressing findings for 7 days.
 */
export async function resolveTriageDeploymentUuid(runId: string, userId: string): Promise<string | null> {
  try {
    const run: any = await getRun(runId, userId)
    if (!run) return null
    if (typeof run.deployment_uuid === 'string' && run.deployment_uuid) return run.deployment_uuid
    if (!run.triggered_by_run_id) return null
    const parent: any = await getRun(run.triggered_by_run_id, userId)
    if (typeof parent?.deployment_uuid === 'string' && parent.deployment_uuid) return parent.deployment_uuid
    return null
  } catch (err: any) {
    console.warn('[post-run.dispatcher] triage deployment_uuid lookup failed', err?.message ?? err)
    return null
  }
}

/**
 * `__internal_triage` run handling (fix/triage-task-email-noise). The FINDING
 * must reach AgentAutofix regardless of run status (low/medium never the owner's inbox)
 * — a triage run that finalizes `success` can still describe a real failed
 * deployment (the model's own JSON `error_type`/`severity` is independent of
 * the scheduler's run status), and the previous cut (PR #496) only forwarded
 * on run FAILURE, silently dropping every such success-status finding.
 *
 * FAILURE/BLOCKED: unchanged from the prior cut — best-effort forward through
 * the hub's existing aggregated self-error reporter (dedup/throttle/aggregation
 * built in; this task's failures ARE hub self-errors — the hub's own scheduled
 * triage against its own Coolify config) plus the owner email `buildDefaultEmailActions`
 * still fires for a failed/blocked internal task.
 *
 * SUCCESS with a parseable finding: forward it to AAF, deduped per REAL
 * Coolify `deployment_uuid` (`resolveTriageDeploymentUuid` → `claimTriageFindingForward`).
 * When no uuid is recoverable there is no dedup — the finding is delivered.
 * A low-severity finding is tagged in the title so it's visibly deprioritized
 * without being dropped. low/medium findings get NO owner email
 * (`buildDefaultEmailActions` suppresses them); high/critical findings ARE
 * emailed by `buildDefaultEmailActions` (`isHighSeverityTriageFinding`), so this
 * function never double-sends them. Only a FAILED AAF forward of a low/medium
 * finding falls back to a (scrubbed) owner email, once per deployment — the
 * dedup claim is consumed up front, so a repeat after a failed forward does not
 * retry the email; this is a best-effort escape hatch, not the primary path.
 */
export async function handleInternalTriageRun(args: AfterRunArgs): Promise<void> {
  if (args.chainDepth !== 0) return
  if (args.task.name !== INTERNAL_TRIAGE_TASK_NAME) return

  if (isFailedOrBlocked({ status: args.status, output_snippet: args.output_snippet })) {
    void reportSelfErrorToAgentautofix({
      fingerprint: `internal-triage:${args.error ?? 'unknown'}`,
      errorType: 'internal_triage_failed',
      errorValue: args.error ?? args.output_snippet ?? 'internal triage run failed',
      source: 'scheduler/post-run/dispatcher:__internal_triage',
    })
    return
  }

  if (args.status !== 'success') return
  const parsed = parseTriageOutput(args.output_snippet ?? '')
  if (!parsed.ok) return // no actionable JSON finding to forward

  const finding = parsed.value
  const deploymentUuid = await resolveTriageDeploymentUuid(args.runId, args.task.user_id)
  if (deploymentUuid) {
    const claimed = await claimTriageFindingForward(args.task.user_id, deploymentUuid)
    if (!claimed) return // already forwarded (or emailed) for this deployment
  }
  // No uuid → no dedup: deliver rather than risk suppressing a distinct finding.
  const deploymentKey = deploymentUuid ?? `run:${args.runId}`

  const severityTag = finding.severity === 'low' ? '[triage low] ' : ''
  const runUrl = `${RUN_URL_PREFIX}/schedules/runs/${args.runId}`
  const body =
    `${severityTag}${finding.error_type}: ${finding.root_cause}\n\n` +
    `Suggested fix: ${finding.suggested_fix}\n` +
    `Severity: ${finding.severity}   Confidence: ${finding.confidence}\n` +
    `Deployment: ${deploymentUuid ?? '(unknown)'}\n` +
    `Run: ${runUrl}`

  const sent = await reportTriageFindingToAgentautofix({
    fingerprint: `internal-triage-finding:${deploymentKey}`,
    errorType: `triage_finding:${finding.error_type}`,
    errorValue: body,
    source: 'scheduler/post-run/dispatcher:__internal_triage',
  })
  if (sent) return
  // high/critical already reached the owner via the default email
  // (buildDefaultEmailActions → isHighSeverityTriageFinding); don't double-send.
  if (finding.severity === 'high' || finding.severity === 'critical') return

  // AAF forward failed — never drop the finding silently. Scrubbed exactly like
  // the AAF comment it substitutes for (model output can echo tokens/DSNs).
  await executeEmail(
    {
      type: 'notify_email',
      on: 'always',
      config: {
        subject: scrub(`Remo internal triage finding [AAF forward failed] - ${severityTag}${finding.error_type}`).slice(0, 200),
        body: scrub(body),
      },
    } as PostRunAction,
    { userId: args.task.user_id, templateVars: {} },
  )
}

export async function fireWithContext(args: FireCtxArgs): Promise<void> {
  // Awaited (errors contained) so the AAF forward + fallback email finish inside the
  // post-run lifecycle instead of being orphaned when the caller releases.
  await handleInternalTriageRun(args).catch((err: any) => {
    console.error('[post-run.dispatcher] internal triage handling failed', err?.message ?? err)
  })
  const actionsRaw = await listActionsForTask(args.task.id)
  const parsed = validatePostRunActions(actionsRaw)
  if (!parsed.ok) {
    console.warn(
      `[post-run.dispatcher] task=${args.task.id} actions invalid: ${parsed.errors.join('; ')}`,
    )
    return
  }
  // Default-on run-summary email: fold a synthesized notify_email into the fired
  // set for eligible ROOT runs (chainDepth===0, not opted out, no custom email).
  // The fan-out aggregate path also calls fireWithContext with chainDepth 0, so
  // this yields exactly ONE default email per fired context.
  const actions = [
    ...parsed.value,
    ...buildDefaultEmailActions(args.task, args.chainDepth, parsed.value, {
      status: args.status,
      output_snippet: args.output_snippet,
    }),
  ]
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

  // auto-dev P4: qc_review routing. A bare `qc` root or an explicit `qc_review`
  // step emits a `<<FINDINGS>>` block; we chain `qc_fix` ONLY when ≥1 actionable
  // finding survives the 24h verified-finding idempotency filter, and SUPPRESS
  // the generic `chain_task` fan-out so we never double-fire. Zero findings →
  // finalize clean (no chain). qc_verify NEVER chains qc_review (loop-safety).
  const isQcReview =
    (args.task.task_type === 'qc' || args.task.task_type === 'qc_review') &&
    args.status === 'success'
  let qcHandled = false
  if (isQcReview) {
    qcHandled = await routeQcReviewDecision(args, actions)
  }

  // auto-dev P4: when a qc_verify run finalizes success (tests green + PR
  // opened), record the originating review's findings as fixed-and-verified so
  // the 24h idempotency guard suppresses them on the next review tick. Walks up
  // the trigger chain to the qc_review snippet. Best-effort; never blocks.
  if (args.task.task_type === 'qc_verify' && args.status === 'success') {
    await recordQcVerifiedFindings(args)
  }

  const chainSuppressed = controllerHandled || qcHandled

  for (const action of actions) {
    // Suppress generic chain_task for a controller / qc_review run — its routing
    // already fired (or intentionally skipped, e.g. `propose` / zero findings).
    if (chainSuppressed && action.type === 'chain_task') continue
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
    // propose → no chain (human-in-the-loop). P3: surface the roadmap to chat
    // (email + Telegram) + persist a pending-proposal for HITL reply capture.
    // NEVER auto-builds — a human reply → payload.notes → next-tick `plan`.
    console.log(
      `[post-run.controller] task=${args.task.id} action=propose no_chain reason="${decision.reason}"`,
    )
    try {
      await surfaceProposal({ task: args.task, decision, runId: args.runId })
    } catch (err: any) {
      console.error(`[post-run.controller] surfaceProposal failed task=${args.task.id}:`, err?.message)
    }
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

const QC_FINDING_WINDOW_HOURS = 24

/**
 * auto-dev P4 — qc_review findings router.
 *
 * Parses the run's `<<FINDINGS>>` block. Filters out findings whose hash was
 * fixed-and-verified within the last 24h (the `qc_finding_idempotency` guard —
 * so the routine can't oscillate on a finding the agent can't resolve). If ≥1
 * actionable finding remains, chains the `qc_fix` step (which itself chains
 * `qc_verify` via its own generic chain edge). Zero findings (or all filtered)
 * → no chain; the run finalizes clean and the next tick re-reviews.
 *
 * Returns true to signal the caller to SUPPRESS the generic `chain_task` loop
 * for this run (qc_review owns the chain decision).
 */
export async function routeQcReviewDecision(
  args: FireCtxArgs,
  actions: PostRunAction[],
): Promise<boolean> {
  const findings = parseQcFindings(args.output_snippet ?? '')

  // Idempotency filter: drop findings already fixed-and-verified within 24h.
  const repo = String((args.task as any).payload?.repo ?? args.task.name ?? '')
  const actionable: typeof findings = []
  for (const f of findings) {
    try {
      const seen = await hasVerifiedFinding(args.task.user_id, findingHash(repo, f), QC_FINDING_WINDOW_HOURS)
      if (seen) {
        console.log(`[post-run.qc] task=${args.task.id} skip recently-verified finding file=${f.file} type=${f.finding_type}`)
        continue
      }
    } catch (err: any) {
      // Better to risk a re-fix than to drop a real finding — keep it.
      console.warn(`[post-run.qc] idempotency check failed task=${args.task.id}: ${err?.message}`)
    }
    actionable.push(f)
  }

  if (actionable.length === 0) {
    console.log(`[post-run.qc] task=${args.task.id} qc clean (0 actionable findings); no chain`)
    return true
  }

  // Resolve the qc_fix chain edge.
  const chainEdges = actions.filter((a) => a.type === 'chain_task' && a.config?.task_id)
  let matched: PostRunAction | null = null
  for (const edge of chainEdges) {
    const child = await getTaskById(edge.config.task_id)
    if (child && child.task_type === 'qc_fix') {
      matched = edge
      break
    }
  }

  if (!matched) {
    console.log(`[post-run.qc] task=${args.task.id} ${actionable.length} findings but no qc_fix edge wired; no chain`)
    return true
  }

  console.log(`[post-run.qc] task=${args.task.id} ${actionable.length} findings → chain qc_fix child=${matched.config.task_id}`)
  await executeChain(matched, {
    parentRunId: args.runId,
    userId: args.task.user_id,
    chainDepth: args.chainDepth,
    parentTaskKind: args.task.task_type,
  })
  return true
}

/**
 * auto-dev P4 — record the originating qc_review findings as fixed-and-verified.
 * Called when a `qc_verify` run finalizes success. Walks the trigger chain to
 * the qc_review snippet, parses its `<<FINDINGS>>` block, and records each
 * finding's hash in `qc_finding_idempotency`. Best-effort; log-only on failure.
 */
async function recordQcVerifiedFindings(args: FireCtxArgs): Promise<void> {
  try {
    const origin = await findQcReviewSnippetForRun(args.runId, args.task.user_id)
    if (!origin) return
    const findings = parseQcFindings(origin.snippet ?? '')
    for (const f of findings) {
      try {
        await recordVerifiedFinding(args.task.user_id, findingHash(origin.repo, f), origin.repo)
      } catch (err: any) {
        console.warn(`[post-run.qc] record verified finding failed task=${args.task.id}: ${err?.message}`)
      }
    }
    if (findings.length > 0) {
      console.log(`[post-run.qc] task=${args.task.id} recorded ${findings.length} verified findings (24h idempotency)`)
    }
  } catch (err: any) {
    console.warn(`[post-run.qc] recordQcVerifiedFindings failed task=${args.task.id}: ${err?.message}`)
  }
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
      case 'deploy_verify':
        await executeDeployVerify(action, {
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

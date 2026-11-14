// hub/src/corch/dispatcher.ts
//
// CORCH-01: the central-orchestrator dispatcher. No top-level value import of the DB client,
// store.ts, heal/*, ws/*, telegram/* or orchestrator/* (LD-2): real dependencies are assembled by
// dynamic import so unit tests import this module with zero DB.
//
// One evaluation (LD-6): flag check, claim txn, Workspace.resolve, attach session, build request and
// prompt, governedLaunch (HEAL policy), then on `launched` the single shared dispatch(). Refusals never
// consume an attempt (LD-7); failures do, with bounded backoff and a blocked state (LD-8); every
// end-of-run transition is idempotent and side effects run only when it changed a row (LD-9, LD-10).

import type { AutospawnDeps } from '../heal/autospawn-deps.ts'
import type { SendDeps } from '../heal/sinks/shared.ts'
import type { DispatchOutcome, DispatchRequest, PipelineDeps, RunStore } from '../dispatch/pipeline.ts'
import { governedLaunch } from '../dispatch/governed-launch.ts'
import { automationKillSwitchGate, automationLifetimeCounterGate } from '../dispatch/automation-controls.ts'
import { dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../dispatch/gates.ts'
import { corchEnabled, corchLeaseMs, corchQuotaCeilingPct } from './flag.ts'
import { buildCorchKey, buildCorchRunToken, CORCH_ACTOR } from './keys.ts'
import { corchProjectBudgetGate, corchConcurrencyGate, corchQuotaGate } from './gates.ts'
import { DEFAULT_QUOTA_PROVIDER, createQuotaProvider, type QuotaProvider } from './quota-provider.ts'
import { classifyQuotaDeath, type QuotaDeath } from './quota-death.ts'
import { buildCorchPrompt } from './prompt.ts'
import type { CorchStore, CorchWorkItem, CorchProject, EndRequeueInput, EndResult, LiveRun, NotBefore } from './store.ts'

// ── Seams with fail-closed defaults (LD-11) ──────────────────────────────────

export type WorkspaceResult =
  | { ok: true; sessionId: string; worktreePath: string | null }
  | { ok: false; reason: string }

/** Resolves the repo worktree + session a run executes in. CORCH-09 supplies the real one. */
export interface Workspace {
  resolve(a: { userId: string; item: CorchWorkItem; project: CorchProject; runId: string }): Promise<WorkspaceResult>
}

export type PrLookupResult = { kind: 'open'; url: string } | { kind: 'none' } | { kind: 'unavailable' }

/** Finds the PR for a finished run's branch. CORCH-09 supplies the real one. */
export interface PrLookup {
  lookup(a: { userId: string; repoIdent: string; branch: string; workItemId: string }): Promise<PrLookupResult>
}

export const DEFAULT_WORKSPACE: Workspace = {
  resolve: async () => ({ ok: false, reason: 'workspace_unavailable' }),
}

export const DEFAULT_PR_LOOKUP: PrLookup = {
  lookup: async () => ({ kind: 'unavailable' }),
}

/** The pipeline seams CORCH needs from the real hub (injected so tests fake them). */
export interface PipelineSeams {
  isOnline: PipelineDeps['isOnline']
  /**
   * The guard is the run's cancellation token. A send that awaits (channel lookup, message insert) MUST call
   * `guard.assertLive()` synchronously immediately before each externally visible step (the row insert and the
   * socket write); the real seam does it in `corchSend`.
   */
  send: (req: DispatchRequest, guard: SendGuard) => Promise<void>
  graceKey?: PipelineDeps['graceKey']
  finalizeTimeoutMs?: number
  /** Disarm the pipeline hook and free the dispatch slot of a run closed elsewhere (reclaim). */
  releaseByToken(token: string, reason: string): Promise<void>
}

/**
 * Per-run in-memory cancellation token (hub is a single process). It flips to cancelled SYNCHRONOUSLY, before
 * the first await of any path that ends the run (reclaim, refusal, failure, finalize), so a send already past
 * its liveness checks cannot reach the socket afterwards. Throws `corch_run_not_live` once cancelled.
 */
export interface SendGuard {
  assertLive(): void
}

/** F3: hold applied when a quota death could not be recorded on its account (the 5h window cap). */
const QUOTA_DEATH_FALLBACK_HOLD_MS = 5 * 3600_000
/** QC2 G1 / QC3 H1: max item backoff after a quota death or quota refusal (account state alone governs quota). */
const QUOTA_DEATH_BACKOFF_MS = 600_000

const ALWAYS_LIVE: SendGuard = { assertLive: () => {} }

/** What this hub process positively knows about one supervisor's (or one user's) live sessions. */
export interface InventorySnapshot {
  /** A recent session_inventory frame exists. false = unknown, which is never "nothing is alive". */
  fresh: boolean
  sessionIds: Set<string>
}

/** Liveness knowledge the reconciler reclaims on (LD-13). */
export interface CorchInventory {
  forSupervisor(supervisorId: string): InventorySnapshot
  /** Union of the fresh inventories of the user's online supervisors (fresh = at least one is fresh). */
  forUser(userId: string): InventorySnapshot
  isOnline(supervisorId: string): boolean
}

/** Owner notification. Carries ids, repo_ident, attempts and end_reason only (LD-14). */
export interface CorchNotification {
  kind: 'blocked' | 'stalled'
  userId: string
  workItemId: string
  repoIdent: string
  attempts: number
  endReason: string
  sessionId: string | null
}

export interface CorchTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface CorchDeps {
  store: CorchStore
  workspace: Workspace
  /** Launch deps: REAL_AUTOSPAWN with the CORCH enrollment check as isRepoAutospawnAllowed (LD-1). */
  launch: AutospawnDeps
  /** The run-log command the autospawn daily launch cap counts (AUTOSPAWN_LAUNCH_COMMAND). */
  launchCommand: string
  quota: QuotaProvider
  pipeline: PipelineSeams
  dispatch: (req: DispatchRequest, deps: PipelineDeps) => Promise<DispatchOutcome>
  prLookup: PrLookup
  notify: (n: CorchNotification) => Promise<void>
  inventory: CorchInventory
  timers: CorchTimers
  /** Injectable clock for the quota-death backoff (default: the system clock). */
  now?: () => Date
}

/** Hooks the dispatcher wires into the pipeline for one run (filled by the launch path). */
export interface PipelineHooks {
  /** The run's cancellation token (default: never cancelled, for callers that build a list without a run). */
  guard?: SendGuard
  store: RunStore | null
  replay: PipelineDeps['replay']
  onParkExpire: NonNullable<PipelineDeps['onParkExpire']>
}

const NO_HOOKS: PipelineHooks = {
  store: null,
  replay: async () => {},
  onParkExpire: async () => {},
}

/**
 * The single pipeline builder: exactly one `gates:` literal exists under hub/src/corch (LD-5).
 * Order is binding: kill switch first, lifetime counter last.
 */
export function buildCorchPipelineDeps(deps: CorchDeps, hooks: PipelineHooks = NO_HOOKS): PipelineDeps {
  const guard = hooks.guard ?? ALWAYS_LIVE
  return {
    gates: [
      automationKillSwitchGate,
      dailyCostCapGate,
      dailyTokenCapGate,
      corchProjectBudgetGate(deps.store),
      corchConcurrencyGate(deps.store),
      corchQuotaGate(deps.quota, deps.store),
      sessionInjectRateGate,
      automationLifetimeCounterGate,
    ],
    store: hooks.store,
    isOnline: (req) => deps.pipeline.isOnline(req),
    send: async (req) => {
      guard.assertLive()
      await deps.pipeline.send(req, guard)
    },
    graceKey: deps.pipeline.graceKey,
    finalizeTimeoutMs: deps.pipeline.finalizeTimeoutMs,
    replay: hooks.replay,
    onParkExpire: hooks.onParkExpire,
  }
}

/** The dispatch request for a run. The ONLY place the request's lifetime key is attached (LD-4). */
export function buildCorchRequest(a: {
  userId: string
  sessionId: string
  runId: string
  workItemId: string
  prompt: string
}): DispatchRequest {
  return {
    userId: a.userId,
    sessionId: a.sessionId,
    token: buildCorchRunToken(a.runId),
    prompt: a.prompt,
    counterKey: buildCorchKey(a.workItemId),
  }
}

// ── Refusal schedule (LD-7) ──────────────────────────────────────────────────

export type NotBeforeKind = 'midnight' | 'plus_60m' | 'plus_lease' | 'quota' | null

const MIDNIGHT_PREFIXES = [
  'project_budget',
  'over_daily_cost_cap:',
  'over_daily_token_cap:',
  'over_token_cap',
  'launch_cap',
]
const INJECT_RATE_PREFIX = 'over_session_inject_rate:'

/** Maps a no-attempt refusal reason to wait_reason, end_reason and the not_before kind. */
export function refusalSchedule(reason: string): { endReason: string; waitReason: string; notBefore: NotBeforeKind } {
  const endReason = reason.startsWith('automation_halted:') ? 'automation_halted' : reason
  let notBefore: NotBeforeKind = null
  if (MIDNIGHT_PREFIXES.some((p) => reason === p || reason.startsWith(p))) notBefore = 'midnight'
  else if (reason.startsWith(INJECT_RATE_PREFIX)) notBefore = 'plus_60m'
  else if (reason.startsWith('autospawn_launch_')) notBefore = 'plus_lease'
  else if (reason.startsWith('quota:')) notBefore = 'quota' // resolved in refuseRun via deps.quota.earliestEligibleAt (CORCH-02)
  return { endReason, waitReason: reason, notBefore }
}

/** Turn a schedule kind into the store's NotBefore (the user tz is needed only for midnight). */
export function toNotBefore(kind: NotBeforeKind, tz: string): NotBefore {
  switch (kind) {
    case 'midnight':
      return { midnightTz: tz }
    case 'plus_60m':
      return { plusSeconds: 3600 }
    case 'plus_lease':
      return { plusSeconds: Math.ceil(corchLeaseMs() / 1000) }
    default:
      return null
  }
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

export type EvaluateResult = { kind: 'disabled' } | { kind: 'done'; claimed: number }

const MAX_CLAIMS_PER_EVALUATION = 10
/** setTimeout's largest delay (a larger value fires immediately). */
const MAX_TIMEOUT_MS = 2147483647

type ReleaseArgs = Parameters<AutospawnDeps['release']>[0]

/** Everything one launched run's callbacks need. */
interface RunCtx {
  userId: string
  runId: string
  itemId: string
  repoIdent: string
  branch: string
  sessionId: string | null
  /** true while the launch is still inside the evaluation loop that claimed it (no re-trigger then). */
  inline: boolean
  lifetime: ReleaseArgs
}

function log(msg: string): void {
  console.error(`[corch] ${msg}`)
}

function errMsg(err: unknown): string {
  return (err as { message?: string })?.message ?? String(err)
}

export function createCorchDispatcher(deps: CorchDeps) {
  /** Items this process is currently launching (never reclaimed as orphans). */
  const inFlight = new Set<string>()
  let timer: unknown = null
  /**
   * Run ids that may still send. Added when a run's pipeline is built, removed SYNCHRONOUSLY by every path
   * that ends the run, so it never holds more than the runs this process currently owns.
   */
  const sendable = new Set<string>()
  const guardFor = (runId: string): SendGuard => ({
    assertLive: () => {
      if (!sendable.has(runId)) throw new Error('corch_run_not_live')
    },
  })

  async function notifyOwner(
    kind: CorchNotification['kind'],
    c: { userId: string; runId: string; itemId: string; repoIdent: string; sessionId: string | null },
    attempts: number,
    endReason: string,
  ): Promise<void> {
    try {
      await deps.notify({
        kind,
        userId: c.userId,
        workItemId: c.itemId,
        repoIdent: c.repoIdent,
        attempts,
        endReason,
        sessionId: c.sessionId,
      })
    } catch (err) {
      log(`notify failed run=${c.runId}: ${errMsg(err)}`)
    }
  }

  const notifyBlocked = (c: Parameters<typeof notifyOwner>[1], attempts: number, endReason: string) =>
    notifyOwner('blocked', c, attempts, endReason)

  /** LD-10: a throw is logged with the run id and left. */
  async function releaseReservation(c: RunCtx): Promise<void> {
    try {
      await deps.launch.release(c.lifetime)
    } catch (err) {
      log(`reservation release failed run=${c.runId}: ${errMsg(err)}`)
    }
  }

  /** No-attempt refusal (LD-7): the run ends, the item goes back to queued. */
  async function refuseRun(runId: string, userId: string, reason: string): Promise<EndResult> {
    sendable.delete(runId) // before the first await
    const s = refusalSchedule(reason)
    const tz = s.notBefore === 'midnight' ? await deps.launch.tzForUser(userId) : 'UTC'
    let notBefore = toNotBefore(s.notBefore, tz)
    if (s.notBefore === 'quota') {
      // CORCH-R2.6: the earliest instant an account can become eligible, or NULL when only an event can change it.
      let at: Date | null = null
      try {
        at = (await deps.quota.earliestEligibleAt?.(userId)) ?? null
      } catch (err) {
        log(`earliestEligibleAt failed user=${userId}: ${errMsg(err)}`)
      }
      // QC3 H1: never hold the item to a far-future reset. The account state governs eligibility, so the item waits at
      // most one backoff window and a healthy snapshot arriving before the reset releases it within that window.
      const cap = (deps.now ?? (() => new Date()))().getTime() + QUOTA_DEATH_BACKOFF_MS
      notBefore = at ? { at: new Date(Math.min(at.getTime(), cap)).toISOString() } : null
    }
    const input: EndRequeueInput = {
      endReason: s.endReason,
      consumeAttempt: false,
      waitReason: s.waitReason,
      notBefore,
    }
    return deps.store.endRunAndRequeue(runId, input)
  }

  async function endRefusal(c: RunCtx, reason: string, release: boolean): Promise<void> {
    const r = await refuseRun(c.runId, c.userId, reason)
    if (!r.changed) return
    if (release) await releaseReservation(c)
    if (!c.inline) await armNotBeforeTimer()
  }

  /** Attempt-consuming failure (LD-8): bounded backoff, blocked at max_attempts, one notification. */
  async function endFailure(c: RunCtx, endReason: string, release: boolean): Promise<void> {
    sendable.delete(c.runId) // before the first await
    const r = await deps.store.endRunAndRequeue(c.runId, {
      endReason,
      consumeAttempt: true,
      waitReason: null,
      notBefore: null,
    })
    if (!r.changed) return
    if (release) await releaseReservation(c)
    if (r.itemStatus === 'blocked') await notifyBlocked(c, r.attempts, endReason)
    await afterRunEnd(c)
  }

  /** A run ended: free slot may start another item. Not re-entered from inside the claiming loop. */
  async function afterRunEnd(c: RunCtx): Promise<void> {
    if (c.inline) return // the claiming evaluation continues and re-arms the timer itself
    await evaluateUser(c.userId)
  }

  /**
   * CORCH-R2.5: the run ended on the CLI usage-limit signal. Block its account until the reset (when the run holds
   * one), then requeue with no attempt consumed. The PR lookup is skipped: the run did not fail on its own merits.
   */
  async function endQuotaDeath(c: RunCtx, death: QuotaDeath): Promise<void> {
    sendable.delete(c.runId) // before the first await
    let accountId: string | null = null
    // F3: if the account cannot be identified or blocked, the run must not be immediately redispatchable onto the
    // same (unblocked) account. Fail closed: hold the item for the 5h window cap and log without any content.
    let blockFailed = false
    try {
      accountId = (await deps.store.runContext(c.runId))?.run.account_slot ?? null
    } catch (err) {
      blockFailed = true
      log(`run context failed run=${c.runId}: ${errMsg(err)}`)
    }
    const now = (deps.now ?? (() => new Date()))().getTime()
    let notBeforeAt: number | null = null
    if (accountId && deps.quota.markDeath) {
      try {
        const blockedUntil = await deps.quota.markDeath({ userId: c.userId, accountId, resetAt: death.resetAt, window: death.window })
        // QC2 G1: a recorded block governs quota on its own (dispatch refuses a blocked account; a clearing snapshot
        // triggers evaluation), so the item only backs off briefly. A null/undefined result means no block was recorded.
        if (blockedUntil) notBeforeAt = now + QUOTA_DEATH_BACKOFF_MS
        else blockFailed = true
      } catch (err) {
        blockFailed = true
        log(`markDeath failed run=${c.runId}: ${errMsg(err)}`)
      }
    }
    if (blockFailed && notBeforeAt === null) notBeforeAt = now + QUOTA_DEATH_FALLBACK_HOLD_MS
    const r = await deps.store.endRunAndRequeue(c.runId, {
      endReason: 'quota_death',
      consumeAttempt: false,
      waitReason: 'quota:death',
      notBefore: notBeforeAt === null ? null : { at: new Date(notBeforeAt).toISOString() },
    })
    if (!r.changed) return
    await afterRunEnd(c)
  }

  /** Run end signal from the shared pipeline (the agent's next assistant_message). */
  async function handleRunEnd(c: RunCtx, text?: string): Promise<void> {
    sendable.delete(c.runId) // before the first await
    const death = classifyQuotaDeath(text)
    if (death) return endQuotaDeath(c, death)
    let pr: Awaited<ReturnType<PrLookup['lookup']>>
    try {
      pr = await deps.prLookup.lookup({ userId: c.userId, repoIdent: c.repoIdent, branch: c.branch, workItemId: c.itemId })
    } catch (err) {
      log(`pr lookup failed run=${c.runId}: ${errMsg(err)}`)
      pr = { kind: 'unavailable' }
    }
    if (pr.kind === 'open') {
      const r = await deps.store.endRunMarkPrOpen(c.runId, pr.url)
      if (r.changed) await afterRunEnd(c)
      return
    }
    await endFailure(c, pr.kind === 'none' ? 'no_pr' : 'pr_lookup_unavailable', false)
  }

  async function applyOutcome(c: RunCtx, outcome: DispatchOutcome): Promise<void> {
    switch (outcome.kind) {
      case 'dispatched':
        await deps.store.markRunRunning(c.runId)
        return
      case 'skipped':
        await endRefusal(c, outcome.reason, true)
        return
      case 'failed':
        await endFailure(c, 'dispatch_failed', false)
        return
      case 'dropped_busy':
        await endFailure(c, 'dropped_busy', true)
        return
      default:
        return // queued / parked_offline: the pipeline's replay or park-expiry hook finishes it
    }
  }

  function runStoreFor(c: RunCtx): RunStore {
    return {
      open: async () => null,
      // Called immediately before the send: the conditional UPDATE is the liveness check, so a run that
      // ended (reclaim) between the gates and here throws and the pipeline sends nothing.
      markDispatched: async () => {
        if (!(await deps.store.markRunRunning(c.runId))) throw new Error('corch_run_not_live')
      },
      // The real pipeline reports a busy session as markSkipped('session_busy') BEFORE it returns
      // dropped_busy. It is a dispatch failure (attempt + backoff, LD-8), not a no-deadline refusal.
      markSkipped: async (_token, reason) =>
        reason === 'session_busy' ? endFailure(c, 'dropped_busy', true) : endRefusal(c, reason, true),
      markFailed: async (_token, error) => {
        const death = classifyQuotaDeath(error)
        return death ? endQuotaDeath(c, death) : endFailure(c, 'dispatch_failed', false)
      },
      onFinalize: async (_token, content) => handleRunEnd(c, content),
    }
  }

  /** The callback context of a claimed run that has no session yet (end-of-run transitions only). */
  const claimedCtx = (c: NonNullable<Awaited<ReturnType<CorchStore['claimNext']>>>): RunCtx => ({
    userId: c.run.user_id,
    runId: c.run.id,
    itemId: c.item.id,
    repoIdent: c.project.repo_ident,
    branch: c.item.branch,
    sessionId: null,
    inline: true, // the claiming loop continues and re-arms the timer itself
    lifetime: { counterKey: buildCorchKey(c.item.id), token: buildCorchRunToken(c.run.id) },
  })

  /** True only while the run row exists and has not ended (fail closed on any lookup problem). */
  async function runIsLive(runId: string): Promise<boolean> {
    try {
      const rc = await deps.store.runContext(runId)
      return !!rc && !rc.run.ended_at
    } catch (err) {
      log(`run liveness lookup failed run=${runId}: ${errMsg(err)}`)
      return false
    }
  }

  async function launchAndDispatch(claimed: NonNullable<Awaited<ReturnType<CorchStore['claimNext']>>>, ws: Extract<WorkspaceResult, { ok: true }>): Promise<void> {
    const { run, item, project } = claimed
    const userId = run.user_id
    await deps.store.attachSession(run.id, ws.sessionId, ws.worktreePath)
    const prompt = buildCorchPrompt({ item, project, worktreePath: ws.worktreePath })
    const req = buildCorchRequest({ userId, sessionId: ws.sessionId, runId: run.id, workItemId: item.id, prompt })
    const lifetime = { counterKey: buildCorchKey(item.id), token: req.token }
    const c: RunCtx = {
      userId,
      runId: run.id,
      itemId: item.id,
      repoIdent: project.repo_ident,
      branch: item.branch,
      sessionId: ws.sessionId,
      inline: true,
      lifetime,
    }
    sendable.add(run.id)
    const pdeps: PipelineDeps = buildCorchPipelineDeps(deps, {
      guard: guardFor(run.id),
      store: runStoreFor(c),
      // A parked turn can be minutes stale: it re-enters dispatch() and is fully re-gated.
      // The run may have ended while parked (reclaim, park expiry, finish): a dead run never re-sends.
      replay: async (r) => {
        if (!(await runIsLive(c.runId))) return
        await applyOutcome(c, await deps.dispatch(r ?? req, pdeps))
      },
      onParkExpire: async () => endFailure(c, 'spawn_timeout', true),
    })

    const a = deps.launch
    const supervisorFor = deps.quota.supervisorFor?.bind(deps.quota)
    const UNBOUND = 'quota:supervisor_unbound'
    const launched = await governedLaunch(
      {
        userId,
        sessionId: ws.sessionId,
        repoIdent: project.repo_ident,
        tz: await a.tzForUser(userId),
        armed: corchEnabled(),
        ledger: {
          repoKey: project.repo_ident,
          command: deps.launchCommand,
          rationale: () => `corch work_item=${item.id} run=${run.id}`,
        },
        preLaunch: {
          checkGates: () => a.checkGates(req, pdeps.gates),
          reserve: () =>
            a.reserve({ userId, sessionId: ws.sessionId, ...lifetime, actor: CORCH_ACTOR, enforceRate: true }),
          release: () => releaseReservation(c),
        },
        // F5: the quota gate recorded the run's account; launch on exactly the supervisor advertising it, or refuse
        // (fail closed, no attempt). A provider without supervisorFor is the CORCH-01 seam (it cannot launch in prod).
        resolveTarget: supervisorFor
          ? async () => {
              try {
                const accountId = (await deps.store.runContext(run.id))?.run.account_slot ?? null
                const supervisorId = accountId ? await supervisorFor(userId, accountId) : null
                if (!accountId || !supervisorId) return { ok: false as const, reason: UNBOUND }
                // QC2 G3: re-read the target's CURRENT advertised account (null = not connected) and require it to be
                // the run's recorded account, so a reconnect advertising another account is never launched on.
                const current = await deps.quota.supervisorAccountSlot?.(userId, supervisorId)
                return current === accountId ? { ok: true as const, supervisorId } : { ok: false as const, reason: UNBOUND }
              } catch (err) {
                log(`supervisor binding failed run=${run.id}: ${errMsg(err)}`)
                return { ok: false as const, reason: UNBOUND }
              }
            }
          : undefined,
      },
      a,
    )

    try {
      switch (launched.kind) {
        case 'refused':
          await endRefusal(c, launched.reason, false) // governedLaunch released its own reservation
          return
        case 'in_flight':
          await endRefusal(c, 'in_flight', false)
          return
        case 'failed':
          log(`launch failed run=${run.id}: ${launched.reason}`)
          await endFailure(c, 'launch_failed', false)
          return
        case 'launched':
          await deps.store.markRunLaunched(run.id, launched.supervisorId)
          try {
            await applyOutcome(c, await deps.dispatch(req, pdeps))
          } catch (err) {
            log(`dispatch threw run=${run.id}: ${errMsg(err)}`)
            await endFailure(c, 'dispatch_failed', false)
          }
          return
      }
    } finally {
      c.inline = false // from here on, later callbacks (replay, finalize, park expiry) may re-trigger
    }
  }

  const liveRunCtx = (run: LiveRun) => ({
    userId: run.user_id,
    runId: run.id,
    itemId: run.work_item_id,
    repoIdent: run.repo_ident,
    sessionId: run.session_id,
  })

  /**
   * Reclaim a live run on positive knowledge only (LD-13). The transition is the idempotent LD-9 one; the
   * reservation is NOT released (the turn was sent); the pipeline hook is disarmed after the end so its
   * own markFailed cannot end the run a second way.
   */
  async function reclaimRun(run: LiveRun, endReason: string, consumeAttempt: boolean): Promise<EndResult> {
    sendable.delete(run.id) // cancel the send path BEFORE the first await (codex R2-1)
    const r = await deps.store.endRunAndRequeue(run.id, {
      endReason,
      consumeAttempt,
      waitReason: consumeAttempt ? null : endReason,
      notBefore: null,
    })
    if (!r.changed) return r
    try {
      await deps.pipeline.releaseByToken(buildCorchRunToken(run.id), endReason)
    } catch (err) {
      log(`pipeline release failed run=${run.id}: ${errMsg(err)}`)
    }
    if (r.itemStatus === 'blocked') await notifyBlocked(liveRunCtx(run), r.attempts, endReason)
    await evaluateUser(run.user_id) // a run ended: the free slot may start another item
    return r
  }

  /** Stalled once: the owner is told only when this call changed the row. */
  async function stallRun(run: LiveRun): Promise<void> {
    if (!(await deps.store.markStalled(run.id))) return
    await notifyOwner('stalled', liveRunCtx(run), run.item_attempts, 'no_fresh_inventory')
  }

  /** The supervisor socket closed (seen by THIS process, not replaced by a reconnect): its runs are gone. */
  async function onSupervisorClosed(supervisorId: string): Promise<void> {
    if (!corchEnabled()) return
    if (deps.inventory.isOnline(supervisorId)) return // a reconnect replaced the closed socket
    for (const run of await deps.store.liveRunsForSupervisor(supervisorId)) {
      await reclaimRun(run, 'supervisor_closed', true)
    }
  }

  async function evaluateUser(userId: string): Promise<EvaluateResult> {
    if (!corchEnabled()) return { kind: 'disabled' }
    const excluded: string[] = []
    let claimed = 0
    try {
      for (let n = 0; n < MAX_CLAIMS_PER_EVALUATION; n++) {
        const c = await deps.store.claimNext(userId, excluded)
        if (!c) break
        claimed++
        excluded.push(c.item.id)
        inFlight.add(c.item.id)
        try {
          let ws: WorkspaceResult
          try {
            ws = await deps.workspace.resolve({ userId, item: c.item, project: c.project, runId: c.run.id })
          } catch (err) {
            // A throwing Workspace is a failure with an attempt (bounded backoff, blocked + one notification):
            // ending the run as an orphan would requeue it with no attempt and retry forever (QC MED 2).
            log(`workspace resolve threw run=${c.run.id}: ${errMsg(err)}`)
            await endFailure(claimedCtx(c), 'workspace_error', false)
            continue
          }
          if (!ws.ok) {
            await refuseRun(c.run.id, userId, ws.reason)
            continue
          }
          await launchAndDispatch(c, ws)
        } catch (err) {
          // Anything that escapes the launch path (a gate/store/launch dependency, attachSession,
          // markRunLaunched) must not leave the claimed run live: it would hold the project slot and the
          // user's cap and later be mis-judged stalled or absent. Failure with an attempt and backoff; the
          // reservation was never spent on a send, so it is released (idempotent when none was taken).
          log(`launch threw run=${c.run.id}: ${errMsg(err)}`)
          await endFailure(claimedCtx(c), 'launch_error', true)
        } finally {
          inFlight.delete(c.item.id)
        }
      }
    } finally {
      await armNotBeforeTimer() // an aborted evaluation must still leave the earliest wakeup armed
    }
    return { kind: 'done', claimed }
  }

  /** Evaluate every user that has due queued work (the not_before timer and global triggers). */
  async function evaluateAll(): Promise<void> {
    if (!corchEnabled()) return
    for (const userId of await deps.store.usersWithDueItems()) await evaluateUser(userId)
    await armNotBeforeTimer()
  }

  let arming: Promise<void> | null = null
  let rearm = false

  /**
   * ONE timer for the earliest future not_before (clamped), replacing the previous one. Calls are
   * serialized and coalesced: a call that arrives while a query is in flight marks a re-run, so the last
   * query always runs AFTER the newest request and an older, slower result can never cancel a newer timer.
   */
  function armNotBeforeTimer(): Promise<void> {
    if (!corchEnabled()) return Promise.resolve()
    if (arming) {
      rearm = true
      return arming
    }
    arming = (async () => {
      try {
        do {
          rearm = false
          await armNotBeforeTimerOnce()
        } while (rearm)
      } finally {
        arming = null
      }
    })()
    return arming
  }

  async function armNotBeforeTimerOnce(): Promise<void> {
    const next = await deps.store.earliestFutureNotBefore()
    if (timer != null) {
      deps.timers.clearTimeout(timer)
      timer = null
    }
    if (!next) return
    const ms = Math.min(Math.max(next.getTime() - Date.now(), 0), MAX_TIMEOUT_MS)
    timer = deps.timers.setTimeout(() => {
      timer = null
      void evaluateAll().catch((err) => log(`not_before timer evaluation failed: ${errMsg(err)}`))
    }, ms)
  }

  return { deps, evaluateUser, evaluateAll, armNotBeforeTimer, inFlight, reclaimRun, stallRun, onSupervisorClosed }
}

export type CorchDispatcher = ReturnType<typeof createCorchDispatcher>

// ── Real dependencies + singleton (LD-2: dynamic imports only) ───────────────

/**
 * The send deps with the run's cancellation token checked synchronously immediately before each externally
 * visible step: before the message row is persisted, and before the socket write (no await between
 * `assertLive()` and `ws.send`). A reclaim that ends the run while the channel lookup or the insert is in
 * flight therefore stops the turn. A row inserted before a later cancel stays (it is history, not a send).
 */
export function guardSendDeps(guard: SendGuard, base: SendDeps): SendDeps {
  return {
    getChannel: async (sessionId) => {
      const channel = await base.getChannel(sessionId)
      if (!channel) return channel
      return {
        ws: {
          send: (data: string) => {
            guard.assertLive()
            channel.ws.send(data)
          },
        },
      }
    },
    insertMessage: async (sessionId, role, content) => {
      guard.assertLive()
      return base.insertMessage(sessionId, role, content)
    },
    broadcastToSubscribers: base.broadcastToSubscribers,
  }
}

type DalInsert = { insertMessage: SendDeps['insertMessage'] }

/**
 * The corch send seam: the shared sender (heal sink) behind the run's cancellation token.
 *
 * The DAL module is resolved FIRST, before any guard runs, and the insert dep calls the resolved
 * `insertMessage` directly. `REAL_SEND_DEPS.insertMessage` awaits a dynamic import before inserting,
 * which would leave an await between `guard.assertLive()` and the row write (a reclaim during that
 * await would still persist the cancelled prompt). `base` may override individual deps; `loadDal` is
 * the test seam for the DAL load.
 */
export async function corchSend(
  req: DispatchRequest,
  guard: SendGuard,
  base?: Partial<SendDeps>,
  loadDal: () => Promise<DalInsert> = () => import('../db/dal.ts') as unknown as Promise<DalInsert>,
): Promise<void> {
  const insertMessage = base?.insertMessage ?? (await loadDal()).insertMessage
  const { sendUserMessage, REAL_SEND_DEPS } = await import('../heal/sinks/shared.ts')
  const deps: SendDeps = {
    ...REAL_SEND_DEPS,
    ...base,
    insertMessage: (sessionId, role, content) => insertMessage(sessionId, role, content),
  }
  await sendUserMessage(req, { storedContent: req.prompt }, guardSendDeps(guard, deps))
}

export async function realCorchDeps(): Promise<CorchDeps> {
  const { corchStore } = await import('./store.ts')
  const { quotaStore } = await import('./quota-store.ts')
  const { REAL_AUTOSPAWN } = await import('../heal/autospawn-deps.ts')
  const { AUTOSPAWN_LAUNCH_COMMAND } = await import('../db/orchestrator-rows-dal.ts')
  const { dispatch } = await import('../dispatch/pipeline.ts')
  const { getChannel } = await import('../ws/registry.ts')
  const { releaseClosedRunByToken } = await import('../dispatch/pipeline.ts')
  const registry = await import('../ws/supervisor-registry.ts')
  const { DEAD_SESSION_INVENTORY_MAX_AGE_MS } = await import('../ws/dead-session-reaper.ts')
  // Freshness is the dead-session reaper rule: an inventory older than its max age is unknown.
  const snapshot = (supervisorId: string): InventorySnapshot => {
    const e = registry.getSupervisor(supervisorId)
    const at = e?.sessionInventoryAt ? Date.parse(e.sessionInventoryAt) : NaN
    if (!e || !Number.isFinite(at) || Date.now() - at > DEAD_SESSION_INVENTORY_MAX_AGE_MS) {
      return { fresh: false, sessionIds: new Set() }
    }
    return { fresh: true, sessionIds: new Set(e.sessionInventory.map((s) => s.session_id)) }
  }
  return {
    store: corchStore,
    workspace: DEFAULT_WORKSPACE,
    // LD-1: the heal/orchestrator launch deps with ONE override: CORCH enrollment replaces the allowlist.
    launch: { ...REAL_AUTOSPAWN, isRepoAutospawnAllowed: (u, r) => corchStore.isEnrolledEnabled(u, r) },
    launchCommand: AUTOSPAWN_LAUNCH_COMMAND,
    quota: createQuotaProvider({
      accountsFor: (u) => quotaStore.accountsFor(u),
      liveRunsByAccount: (u, ex) => quotaStore.liveRunsByAccount(u, ex),
      onlineSlotSupervisors: (u) => registry.listOnlineSlotSupervisorsForUser(u),
      claimAccountSlot: (r, u, a, c) => quotaStore.claimAccountSlot(r, u, a, c),
      now: () => new Date(),
      ceilingPct: corchQuotaCeilingPct,
      markDeath: (a) => quotaStore.markDeath(a),
    }),
    pipeline: {
      isOnline: (req) => getChannel(req.sessionId) != null,
      send: (req, guard) => corchSend(req, guard),
      releaseByToken: async (token, reason) => {
        await releaseClosedRunByToken(token, reason)
      },
    },
    dispatch,
    prLookup: DEFAULT_PR_LOOKUP,
    notify: async (n) => {
      const { fanOutNotify } = await import('../orchestrator/notify.ts')
      await fanOutNotify({
        userId: n.userId,
        sessionId: n.sessionId ?? '',
        event: 'failure',
        level: 'blocking',
        detail: `CORCH ${n.kind}: work_item=${n.workItemId} repo=${n.repoIdent} attempts=${n.attempts} reason=${n.endReason}`,
        channels: ['telegram', 'inapp', 'email', 'push'],
      })
    },
    inventory: {
      forSupervisor: snapshot,
      forUser: (userId) => {
        const snaps = registry.listOnlineSupervisorIdsForUser(userId).map(snapshot).filter((x) => x.fresh)
        return { fresh: snaps.length > 0, sessionIds: new Set(snaps.flatMap((x) => [...x.sessionIds])) }
      },
      isOnline: (supervisorId) => registry.isSupervisorOnline(supervisorId),
    },
    timers: REAL_TIMERS,
  }
}

export const REAL_TIMERS: CorchTimers = {
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    ;(t as { unref?: () => void })?.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

let singleton: Promise<CorchDispatcher> | null = null

export function getCorch(): Promise<CorchDispatcher> {
  singleton ??= realCorchDeps().then(createCorchDispatcher)
  return singleton
}

/** Whether the real singleton was ever built (a flag-OFF process must never build it). */
export function corchSingletonConstructed(): boolean {
  return singleton !== null
}

// ── Event triggers: each returns immediately, with no DB access, when the flag is OFF (LD-12) ──

/** Enqueue / enrollment trigger. */
export async function evaluateUserNow(userId: string): Promise<void> {
  if (!corchEnabled()) return
  await (await getCorch()).evaluateUser(userId)
}

/** A supervisor connected: queued work waiting on supervisor_offline can proceed. */
export async function onSupervisorHello(userId: string): Promise<void> {
  if (!corchEnabled()) return
  await (await getCorch()).evaluateUser(userId)
}

/** A supervisor socket closed (seen by this process): reclaim its live runs, then re-evaluate. */
export async function onSupervisorClosed(supervisorId: string): Promise<void> {
  if (!corchEnabled()) return
  await (await getCorch()).onSupervisorClosed(supervisorId)
}

/** A kill switch scope was released: the deferred work in that scope can proceed. */
export async function onKillSwitchReleased(scope: 'global' | 'user' | 'session', userId: string): Promise<void> {
  if (!corchEnabled()) return
  const d = await getCorch()
  if (scope === 'global') await d.evaluateAll()
  else await d.evaluateUser(userId)
}

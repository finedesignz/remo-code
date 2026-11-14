// hub/src/corch/dispatcher.ts
//
// CORCH-01: the central-orchestrator dispatcher. No top-level value import of the DB client,
// store.ts, heal/*, ws/*, telegram/* or orchestrator/* (LD-2): real dependencies are assembled by
// dynamic import so unit tests import this module with zero DB.

import type { AutospawnDeps } from '../heal/autospawn-deps.ts'
import type { DispatchRequest, PipelineDeps, RunStore } from '../dispatch/pipeline.ts'
import { automationKillSwitchGate, automationLifetimeCounterGate } from '../dispatch/automation-controls.ts'
import { dailyCostCapGate, dailyTokenCapGate, sessionInjectRateGate } from '../dispatch/gates.ts'
import { corchEnabled, corchLeaseMs } from './flag.ts'
import { buildCorchKey, buildCorchRunToken } from './keys.ts'
import { corchProjectBudgetGate, corchConcurrencyGate, corchQuotaGate } from './gates.ts'
import { DEFAULT_QUOTA_PROVIDER, type QuotaProvider } from './quota-provider.ts'
import type { CorchStore, CorchWorkItem, CorchProject, EndRequeueInput, NotBefore } from './store.ts'

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
  send: PipelineDeps['send']
  graceKey?: PipelineDeps['graceKey']
  finalizeTimeoutMs?: number
}

export interface CorchDeps {
  store: CorchStore
  workspace: Workspace
  launch: AutospawnDeps
  quota: QuotaProvider
  pipeline: PipelineSeams
}

/** Hooks the dispatcher wires into the pipeline for one run (filled by the launch path). */
export interface PipelineHooks {
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
    send: (req) => deps.pipeline.send(req),
    graceKey: deps.pipeline.graceKey,
    finalizeTimeoutMs: deps.pipeline.finalizeTimeoutMs,
    replay: hooks.replay,
    onParkExpire: hooks.onParkExpire,
  }
}

/** The dispatch request for a run. The ONLY place the lifetime key is attached (LD-4). */
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

export type EvaluateResult = { kind: 'disabled' } | { kind: 'done'; claimed: number }

// ── Refusal schedule (LD-7) ──────────────────────────────────────────────────

export type NotBeforeKind = 'midnight' | 'plus_60m' | 'plus_lease' | null

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
  return { endReason, waitReason: reason, notBefore }
}

/** Turn a schedule kind into the store's NotBefore (needs the user tz only for midnight). */
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

const MAX_CLAIMS_PER_EVALUATION = 10

export function createCorchDispatcher(deps: CorchDeps) {
  /** Items this process is currently launching (never reclaimed as orphans). */
  const inFlight = new Set<string>()

  async function refuseNoAttempt(runId: string, tz: string, reason: string): Promise<void> {
    const s = refusalSchedule(reason)
    const input: EndRequeueInput = {
      endReason: s.endReason,
      consumeAttempt: false,
      waitReason: s.waitReason,
      notBefore: toNotBefore(s.notBefore, tz),
    }
    await deps.store.endRunAndRequeue(runId, input)
  }

  async function evaluateUser(userId: string): Promise<EvaluateResult> {
    if (!corchEnabled()) return { kind: 'disabled' }
    const excluded: string[] = []
    let claimed = 0
    for (let n = 0; n < MAX_CLAIMS_PER_EVALUATION; n++) {
      const c = await deps.store.claimNext(userId, excluded)
      if (!c) break
      claimed++
      excluded.push(c.item.id)
      inFlight.add(c.item.id)
      try {
        const ws = await deps.workspace.resolve({ userId, item: c.item, project: c.project, runId: c.run.id })
        if (!ws.ok) {
          await refuseNoAttempt(c.run.id, 'UTC', ws.reason)
          continue
        }
        // Task 4 replaces this line with the governed launch + dispatch turn. Never reachable in prod:
        // DEFAULT_WORKSPACE refuses.
        await deps.store.endRunAndRequeue(c.run.id, {
          endReason: 'launch_not_wired',
          consumeAttempt: false,
          waitReason: 'launch_not_wired',
          notBefore: null,
        })
      } finally {
        inFlight.delete(c.item.id)
      }
    }
    return { kind: 'done', claimed }
  }

  return { evaluateUser, inFlight }
}

// ── Real dependencies + singleton (LD-2: dynamic imports only) ───────────────

/** CORCH-01 defaults: the quota/workspace seams refuse, so nothing can launch until later phases. */
export async function realCorchDeps(): Promise<CorchDeps> {
  const { corchStore } = await import('./store.ts')
  const { REAL_AUTOSPAWN } = await import('../heal/autospawn-deps.ts')
  return {
    store: corchStore,
    workspace: DEFAULT_WORKSPACE,
    quota: DEFAULT_QUOTA_PROVIDER,
    // Task 4 binds the real heal send/isOnline here; until then nothing can reach a send (workspace refuses).
    pipeline: {
      isOnline: async () => false,
      send: async () => {
        throw new Error('corch pipeline send is not wired')
      },
    },
    // LD-1: the heal/orchestrator launch deps with ONE override: CORCH enrollment replaces the allowlist.
    launch: { ...REAL_AUTOSPAWN, isRepoAutospawnAllowed: (u, r) => corchStore.isEnrolledEnabled(u, r) },
  }
}

let singleton: Promise<ReturnType<typeof createCorchDispatcher>> | null = null

export function getCorch(): Promise<ReturnType<typeof createCorchDispatcher>> {
  singleton ??= realCorchDeps().then(createCorchDispatcher)
  return singleton
}

/** Event trigger for enqueue / enrollment: no-op (and no DB access) when the flag is OFF. */
export async function evaluateUserNow(userId: string): Promise<void> {
  if (!corchEnabled()) return
  await (await getCorch()).evaluateUser(userId)
}

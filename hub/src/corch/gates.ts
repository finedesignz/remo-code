// hub/src/corch/gates.ts
//
// CORCH-01 (LD-5, CORCH-R1.8, R1.9, R1.13): the three CORCH-specific dispatch gates. Each resolves its
// run from the request token (corch-run:<id>) and fails closed (`corch_bad_token`) for any other token.
// No top-level value import of the DB client or store (LD-2): the store is injected.

import type { DispatchGate, DispatchRequest } from '../dispatch/pipeline.ts'
import { runIdFromToken } from './keys.ts'
import type { CorchStore, RunContext } from './store.ts'
import type { QuotaProvider } from './quota-provider.ts'

type GateResult = { ok: true } | { ok: false; reason: string }

const BAD_TOKEN: GateResult = { ok: false, reason: 'corch_bad_token' }

async function contextFor(store: CorchStore, req: DispatchRequest): Promise<RunContext | null> {
  const runId = runIdFromToken(req.token)
  if (!runId) return null
  return store.runContext(runId)
}

/** Refuses `project_budget` once the project's CORCH sessions used today's daily_token_budget. */
export function corchProjectBudgetGate(store: CorchStore): DispatchGate {
  return {
    name: 'corch_project_budget',
    async check(req): Promise<GateResult> {
      const ctx = await contextFor(store, req)
      if (!ctx) return BAD_TOKEN
      const used = await store.projectTokensToday(ctx.project.id, ctx.tz)
      return used >= Number(ctx.project.daily_token_budget) ? { ok: false, reason: 'project_budget' } : { ok: true }
    },
  }
}

/** Refuses `corch_concurrency` when the user's other live runs already fill their cap. */
export function corchConcurrencyGate(store: CorchStore): DispatchGate {
  return {
    name: 'corch_concurrency',
    async check(req): Promise<GateResult> {
      const ctx = await contextFor(store, req)
      if (!ctx) return BAD_TOKEN
      const others = await store.liveRunsForUser(ctx.run.user_id, ctx.run.id)
      return others >= ctx.maxConcurrent ? { ok: false, reason: 'corch_concurrency' } : { ok: true }
    },
  }
}

/** Refuses with the provider's reason (default `quota_no_snapshot`); ignores account/supervisor on success. */
export function corchQuotaGate(quota: QuotaProvider, store: CorchStore): DispatchGate {
  return {
    name: 'corch_quota',
    async check(req): Promise<GateResult> {
      const ctx = await contextFor(store, req)
      if (!ctx) return BAD_TOKEN
      const snap = await quota.snapshotFor({ userId: ctx.run.user_id, projectId: ctx.project.id, workItemId: ctx.item.id })
      return snap.ok ? { ok: true } : { ok: false, reason: snap.reason }
    },
  }
}

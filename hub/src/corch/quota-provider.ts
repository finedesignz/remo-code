// hub/src/corch/quota-provider.ts
//
// CORCH-01 (LD-11): the quota seam. The default refuses, so no work item can launch (CORCH-R1.13).
// CORCH-02 (LD-Q8, LD-Q9, LD-Q13): createQuotaProvider is the real provider used when REMO_CORCH_ENABLED
// is on. It imports no DB module: everything is injected (realCorchDeps wires quota-store by dynamic import).
// F5: success carries the supervisor advertising the chosen account; supervisorFor re-resolves it at launch.

import { evaluateAccounts, type QuotaAccountRow } from './quota-eligibility.ts'

export type QuotaSnapshot = { ok: true; account_slot: string | null; supervisor_id: string | null } | { ok: false; reason: string }

export interface QuotaProvider {
  snapshotFor(a: {
    userId: string
    projectId: string
    workItemId: string
    /** The run being gated; the chosen account is recorded on it. */
    runId?: string
    /** The account the run already holds, if any (a run is never moved across accounts). */
    accountSlot?: string | null
  }): Promise<QuotaSnapshot>
  /** When an account can next become eligible; null when only an event can change it. */
  earliestEligibleAt?(userId: string): Promise<Date | null>
  /**
   * CORCH-02 QC F5: the online supervisor (lowest id) advertising `accountId`, or null when none does. The corch
   * launch targets exactly this supervisor so the quota account that was checked is the one that runs.
   */
  supervisorFor?(userId: string, accountId: string): Promise<string | null>
  /**
   * CORCH-02 QC2 G3: the account `supervisorId` CURRENTLY advertises in the registry, or null when it is not
   * connected (or advertises none). Re-read at launch so a reconnect under another account is detected.
   */
  supervisorAccountSlot?(userId: string, supervisorId: string): Promise<string | null>
  /**
   * Block an account after a quota death until its reset (CORCH-R2.5). Returns the resulting blocked_until
   * (null when only a newer reading can clear the block).
   */
  markDeath?(a: { userId: string; accountId: string; resetAt: Date | null; window?: '5h' | '7d' | null }): Promise<Date | null>
}

export const DEFAULT_QUOTA_PROVIDER: QuotaProvider = {
  snapshotFor: async () => ({ ok: false, reason: 'quota_no_snapshot' }),
}

export interface OnlineSlotSupervisor {
  supervisorId: string
  accountSlot: string
  maxConcurrent: number
}

export interface QuotaProviderDeps {
  accountsFor(userId: string): Promise<QuotaAccountRow[]>
  liveRunsByAccount(userId: string, excludeRunId?: string | null): Promise<Record<string, number>>
  onlineSlotSupervisors(userId: string): OnlineSlotSupervisor[] | Promise<OnlineSlotSupervisor[]>
  /** One conditional UPDATE; false => the account's other live runs already fill `capacity` (or the run is gone). */
  claimAccountSlot(runId: string, userId: string, accountId: string, capacity: number): Promise<boolean>
  now(): Date
  ceilingPct(): number
  markDeath?(a: { userId: string; accountId: string; resetAt: Date | null; window?: '5h' | '7d' | null }): Promise<Date | null>
}

/** The deterministic supervisor for an account: lowest supervisorId among those advertising it. */
function supervisorIdFor(supervisors: OnlineSlotSupervisor[], accountId: string): string | null {
  let best: string | null = null
  for (const s of supervisors) if (s.accountSlot === accountId && (best === null || s.supervisorId < best)) best = s.supervisorId
  return best
}

export function createQuotaProvider(deps: QuotaProviderDeps): QuotaProvider {
  return {
    async snapshotFor(a) {
      const rows = await deps.accountsFor(a.userId)
      if (rows.length === 0) return { ok: false, reason: 'quota:no_snapshot' }
      const busy = await deps.liveRunsByAccount(a.userId, a.runId ?? null)
      const evals = evaluateAccounts(rows, { now: deps.now(), ceilingPct: deps.ceilingPct(), busyByAccount: busy })
      const supervisors = await deps.onlineSlotSupervisors(a.userId)

      const capacityOf = (row: QuotaAccountRow): number => {
        let cap = 0
        for (const s of supervisors) if (s.accountSlot === row.account_id) cap = Math.max(cap, s.maxConcurrent)
        // Unknown 5h caps the account at one live run (CORCH-R2.4).
        return row.five_h_pct === null ? Math.min(cap, 1) : cap
      }

      const pinned = a.accountSlot ?? null
      const considered = rows.map((row, i) => ({ row, ev: evals[i]! })).filter((x) => pinned === null || x.row.account_id === pinned)
      if (considered.length === 0) return { ok: false, reason: 'quota:no_snapshot' }

      const candidates = considered
        .filter((x) => x.ev.eligible && capacityOf(x.row) > (busy[x.row.account_id] ?? 0))
        .map((x) => ({ ...x, capacity: capacityOf(x.row) }))

      if (candidates.length === 0) {
        const eligibleExists = considered.some((x) => x.ev.eligible)
        if (eligibleExists) return { ok: false, reason: 'quota:no_slot_supervisor' }
        const reasons = new Set(considered.map((x) => x.ev.reason))
        return { ok: false, reason: reasons.size === 1 ? [...reasons][0]! : 'quota:no_eligible_account' }
      }

      const score = (r: QuotaAccountRow) => Math.max(r.five_h_pct ?? r.seven_d_pct ?? 0, r.seven_d_pct ?? 0)
      candidates.sort((x, y) => score(x.row) - score(y.row) || (x.row.account_id < y.row.account_id ? -1 : x.row.account_id > y.row.account_id ? 1 : 0))
      const pick = candidates[0]!

      // A run that already holds its account keeps it; only a fresh pick is recorded (and capacity-checked).
      if (pinned === null && a.runId) {
        const ok = await deps.claimAccountSlot(a.runId, a.userId, pick.row.account_id, pick.capacity)
        if (!ok) return { ok: false, reason: 'quota:slot_taken' }
      }
      return { ok: true, account_slot: pick.row.account_id, supervisor_id: supervisorIdFor(supervisors, pick.row.account_id) }
    },

    async earliestEligibleAt(userId) {
      const rows = await deps.accountsFor(userId)
      if (rows.length === 0) return null
      const busy = await deps.liveRunsByAccount(userId, null)
      const evals = evaluateAccounts(rows, { now: deps.now(), ceilingPct: deps.ceilingPct(), busyByAccount: busy })
      const ineligible = evals.filter((e) => !e.eligible)
      if (ineligible.length === 0) return null
      let min: Date | null = null
      for (const e of ineligible) {
        if (e.not_before === null) return null
        const d = new Date(e.not_before)
        if (min === null || d.getTime() < min.getTime()) min = d
      }
      return min
    },

    async supervisorFor(userId, accountId) {
      return supervisorIdFor(await deps.onlineSlotSupervisors(userId), accountId)
    },

    async supervisorAccountSlot(userId, supervisorId) {
      return (await deps.onlineSlotSupervisors(userId)).find((s) => s.supervisorId === supervisorId)?.accountSlot ?? null
    },

    markDeath: deps.markDeath,
  }
}

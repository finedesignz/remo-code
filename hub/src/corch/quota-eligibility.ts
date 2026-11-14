// hub/src/corch/quota-eligibility.ts
//
// CORCH-02 (LD-Q6): the ONE copy of the quota eligibility rules. Pure: no DB import, no clock read
// (the caller passes `now`). Feeds both GET /api/quota/snapshot (R2.2) and the real quota provider.
// First failing rule wins. Fails closed: unknown is never eligible.

export interface QuotaAccountRow {
  account_id: string
  slot: string | null
  five_h_pct: number | null
  seven_d_pct: number | null
  resets_5h: Date | null
  resets_7d: Date | null
  fetched_at: Date | null
  source: string
  enabled: boolean
  cug_blocked: boolean
  received_at: Date
  blocked_until: Date | null
  blocked_at: Date | null
}

export interface AccountEligibility {
  account_id: string
  eligible: boolean
  /** `quota:<reason>` when ineligible, null when eligible. */
  reason: string | null
  /** ISO instant the account can next become eligible, null when only an event can change it. */
  not_before: string | null
}

export interface EvaluateOpts {
  now: Date
  ceilingPct: number
  /** Live CORCH runs per account_id (used only for the null-5h one-run cap). */
  busyByAccount?: Record<string, number>
}

const SNAPSHOT_TTL_MS = 600_000
const ACCOUNT_TTL_MS = 900_000
const FUTURE_SKEW_MS = 60_000

function no(account_id: string, reason: string, notBefore: Date | null = null): AccountEligibility {
  return { account_id, eligible: false, reason: `quota:${reason}`, not_before: notBefore ? notBefore.toISOString() : null }
}

export function evaluateAccounts(rows: QuotaAccountRow[], opts: EvaluateOpts): AccountEligibility[] {
  const nowMs = opts.now.getTime()
  return rows.map((r) => {
    // 2. the whole POST is stale (hub clock on received_at)
    if (nowMs - r.received_at.getTime() > SNAPSHOT_TTL_MS) return no(r.account_id, 'snapshot_stale')
    // 4. only live readings count
    if (r.source !== 'live') return no(r.account_id, 'source_not_live')
    return { account_id: r.account_id, eligible: true, reason: null, not_before: null }
  })
}

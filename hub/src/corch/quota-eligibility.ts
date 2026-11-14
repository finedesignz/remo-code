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

/** Later of the resets of every window at or over the ceiling; null when any of them is null or already past. */
function overCeilingNotBefore(r: QuotaAccountRow, ceilingPct: number, nowMs: number): Date | null {
  const resets: Array<Date | null> = []
  if (r.five_h_pct !== null && r.five_h_pct >= ceilingPct) resets.push(r.resets_5h)
  if (r.seven_d_pct !== null && r.seven_d_pct >= ceilingPct) resets.push(r.resets_7d)
  let latest: Date | null = null
  for (const d of resets) {
    if (d === null || d.getTime() <= nowMs) return null
    if (latest === null || d.getTime() > latest.getTime()) latest = d
  }
  return latest
}

export function evaluateAccounts(rows: QuotaAccountRow[], opts: EvaluateOpts): AccountEligibility[] {
  const nowMs = opts.now.getTime()
  return rows.map((r) => {
    // 2. the whole POST is stale (hub clock on received_at)
    if (nowMs - r.received_at.getTime() > SNAPSHOT_TTL_MS) return no(r.account_id, 'snapshot_stale')
    // 3. the reading itself is stale, missing, or from the future (clock skew)
    if (
      r.fetched_at === null ||
      nowMs - r.fetched_at.getTime() > ACCOUNT_TTL_MS ||
      r.fetched_at.getTime() - nowMs > FUTURE_SKEW_MS
    ) {
      return no(r.account_id, 'account_stale')
    }
    // 4. only live readings count
    if (r.source !== 'live') return no(r.account_id, 'source_not_live')
    // 5, 6. CUG's own verdicts
    if (r.cug_blocked) return no(r.account_id, 'cug_blocked')
    if (!r.enabled) return no(r.account_id, 'cug_disabled')
    // 7. hub-owned block (quota death). A NULL-until block waits for an event (a newer reading clears it).
    if (r.blocked_until !== null && r.blocked_until.getTime() > nowMs) return no(r.account_id, 'blocked', r.blocked_until)
    if (r.blocked_until === null && r.blocked_at !== null) return no(r.account_id, 'blocked')
    // 8. unknown 7d is never eligible
    if (r.seven_d_pct === null) return no(r.account_id, 'seven_d_unknown')
    // 9. ceiling on the max of the known windows (null 5h is unknown, not 0)
    const maxPct = r.five_h_pct === null ? r.seven_d_pct : Math.max(r.five_h_pct, r.seven_d_pct)
    if (maxPct >= opts.ceilingPct) return no(r.account_id, 'over_ceiling', overCeilingNotBefore(r, opts.ceilingPct, nowMs))
    // 10. unknown 5h: at most one live run on the account
    if (r.five_h_pct === null && (opts.busyByAccount?.[r.account_id] ?? 0) >= 1) {
      return no(r.account_id, 'five_h_unknown_busy')
    }
    return { account_id: r.account_id, eligible: true, reason: null, not_before: null }
  })
}

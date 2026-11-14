// hub/src/corch/quota-store.ts
//
// CORCH-02 (LD-Q4, LD-Q5): persistence for the latest CUG usage reading per account slot. user_id is
// ALWAYS the verified key owner's id, never anything from the body. No email column exists.

import { sql } from '../db/postgres.ts'
import type { QuotaAccountRow } from './quota-eligibility.ts'

/** One validated account entry of a CUG usage-snapshot v1 body (email / label are rejected upstream). */
export interface QuotaAccountInput {
  account_id: string
  slot: string | null
  five_h_pct: number | null
  seven_d_pct: number | null
  resets_5h: string | null
  resets_7d: string | null
  fetched_at: string | null
  source: string
  enabled: boolean
  /** CUG's `blocked` flag. */
  blocked: boolean
}

export const quotaStore = {
  /** One transaction per POST. Hub-owned blocked_until / blocked_at survive (LD-Q5). Returns rows written. */
  async upsertSnapshot(userId: string, accounts: QuotaAccountInput[]): Promise<number> {
    return sql.begin(async (tx) => {
      for (const a of accounts) {
        await tx`
          INSERT INTO corch_quota_accounts
            (user_id, account_id, slot, five_h_pct, seven_d_pct, resets_5h, resets_7d, fetched_at,
             source, enabled, cug_blocked, received_at)
          VALUES
            (${userId}, ${a.account_id}, ${a.slot}, ${a.five_h_pct}::numeric, ${a.seven_d_pct}::numeric,
             ${a.resets_5h}::timestamptz, ${a.resets_7d}::timestamptz, ${a.fetched_at}::timestamptz,
             ${a.source}, ${a.enabled}, ${a.blocked}, now())
          ON CONFLICT (user_id, account_id) DO UPDATE SET
            slot = EXCLUDED.slot,
            five_h_pct = EXCLUDED.five_h_pct,
            seven_d_pct = EXCLUDED.seven_d_pct,
            resets_5h = EXCLUDED.resets_5h,
            resets_7d = EXCLUDED.resets_7d,
            fetched_at = EXCLUDED.fetched_at,
            source = EXCLUDED.source,
            enabled = EXCLUDED.enabled,
            cug_blocked = EXCLUDED.cug_blocked,
            received_at = now(),
            -- F1: CUG is the single quota source. A live reading fetched after the death supersedes the
            -- text-detected block (both columns), so a death can never outlive the next reading.
            blocked_until = CASE WHEN corch_quota_accounts.blocked_at IS NOT NULL
                   AND EXCLUDED.source = 'live'
                   AND EXCLUDED.fetched_at IS NOT NULL
                   AND EXCLUDED.fetched_at > corch_quota_accounts.blocked_at
                THEN NULL ELSE corch_quota_accounts.blocked_until END,
            blocked_at = CASE WHEN corch_quota_accounts.blocked_at IS NOT NULL
                   AND EXCLUDED.source = 'live'
                   AND EXCLUDED.fetched_at IS NOT NULL
                   AND EXCLUDED.fetched_at > corch_quota_accounts.blocked_at
                THEN NULL ELSE corch_quota_accounts.blocked_at END
          -- F7: a replayed / out-of-order POST never overwrites a newer stored reading (nor refreshes received_at).
          WHERE corch_quota_accounts.fetched_at IS NULL
             OR EXCLUDED.fetched_at IS NULL
             OR EXCLUDED.fetched_at >= corch_quota_accounts.fetched_at`
      }
      return accounts.length
    })
  },

  /** Every stored row for the user, NUMERIC coerced to number (null stays null). */
  async accountsFor(userId: string): Promise<QuotaAccountRow[]> {
    const rows = await sql<Record<string, any>[]>`
      SELECT account_id, slot, five_h_pct, seven_d_pct, resets_5h, resets_7d, fetched_at, source,
             enabled, cug_blocked, received_at, blocked_until, blocked_at
      FROM corch_quota_accounts WHERE user_id = ${userId} ORDER BY account_id`
    const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
    return rows.map((r) => ({
      account_id: r.account_id,
      slot: r.slot ?? null,
      five_h_pct: num(r.five_h_pct),
      seven_d_pct: num(r.seven_d_pct),
      resets_5h: r.resets_5h ?? null,
      resets_7d: r.resets_7d ?? null,
      fetched_at: r.fetched_at ?? null,
      source: r.source,
      enabled: r.enabled,
      cug_blocked: r.cug_blocked,
      received_at: r.received_at,
      blocked_until: r.blocked_until ?? null,
      blocked_at: r.blocked_at ?? null,
    }))
  },

  /**
   * Record the chosen account on the run: ONE conditional UPDATE that only sets account_slot when it is NULL,
   * the run is live and owned by the user, and the account's other live runs are below `capacity`.
   * F4: serialized per (user_id, account_id) by a transaction-scoped advisory lock taken before the count, so two
   * claims for different runs cannot both observe an empty account (READ COMMITTED write skew). The count + UPDATE
   * statement runs after the lock is held and therefore sees every earlier committed claim.
   * false = 0 rows updated.
   */
  async claimAccountSlot(runId: string, userId: string, accountId: string, capacity: number): Promise<boolean> {
    return sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}::text || ':' || ${accountId}::text))`
      const rows = await tx<{ id: string }[]>`
        UPDATE corch_runs SET account_slot = ${accountId}
        WHERE id = ${runId} AND user_id = ${userId} AND account_slot IS NULL AND ended_at IS NULL
          AND (SELECT count(*) FROM corch_runs o
               WHERE o.user_id = ${userId} AND o.account_slot = ${accountId} AND o.ended_at IS NULL AND o.id <> ${runId})
              < ${capacity}::int
        RETURNING id`
      return rows.length > 0
    })
  },

  /**
   * CORCH-R2.5 (LD-Q10), CORCH-02 QC F1: a text-detected quota death is NOT authoritative (the text is run output).
   * blocked_at = now() (the death instant); blocked_until = min(candidate reset, now + window cap) where the cap is
   * 7d for the 7d window and 5h otherwise, and the candidate is the signal's reset when in the future, else the named
   * window's reset from the reading, else the earliest future reading reset, else the cap. A far-future or past
   * epoch therefore clamps; F2: the later of the existing and the new blocked_until is kept (a session death never
   * shortens a weekly block); the next live reading fetched after blocked_at clears the block (upsertSnapshot).
   * Returns the resulting blocked_until (null only when the account has no row).
   */
  async markDeath(a: { userId: string; accountId: string; resetAt: Date | null; window?: '5h' | '7d' | null }): Promise<Date | null> {
    const resetAt = a.resetAt ? a.resetAt.toISOString() : null
    const window = a.window ?? null
    const rows = await sql<{ blocked_until: Date | null }[]>`
      UPDATE corch_quota_accounts SET
        blocked_at = now(),
        blocked_until = GREATEST(blocked_until, LEAST(
          now() + (CASE WHEN ${window}::text = '7d' THEN interval '7 days' ELSE interval '5 hours' END),
          COALESCE(
            CASE WHEN ${resetAt}::timestamptz > now() THEN ${resetAt}::timestamptz END,
            CASE WHEN ${window}::text = '5h' THEN CASE WHEN resets_5h > now() THEN resets_5h END
                 WHEN ${window}::text = '7d' THEN CASE WHEN resets_7d > now() THEN resets_7d END
                 ELSE (SELECT min(t) FROM (VALUES (resets_5h), (resets_7d)) AS v(t) WHERE t > now())
            END,
            'infinity'::timestamptz)))
      WHERE user_id = ${a.userId} AND account_id = ${a.accountId}
      RETURNING blocked_until`
    return rows[0]?.blocked_until ?? null
  },

  /** Live (un-ended) CORCH runs per account_slot for the user, optionally excluding one run. */
  async liveRunsByAccount(userId: string, excludeRunId?: string | null): Promise<Record<string, number>> {
    const rows = await sql<{ account_slot: string; n: number }[]>`
      SELECT account_slot, count(*)::int AS n FROM corch_runs
      WHERE user_id = ${userId} AND ended_at IS NULL AND account_slot IS NOT NULL
        AND (${excludeRunId ?? null}::uuid IS NULL OR id <> ${excludeRunId ?? null}::uuid)
      GROUP BY account_slot`
    const out: Record<string, number> = {}
    for (const r of rows) out[r.account_slot] = r.n
    return out
  },
}

export type QuotaStore = typeof quotaStore

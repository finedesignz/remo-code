/**
 * POST/GET /api/quota/snapshot - CORCH-02 quota ingest and eligibility read.
 *
 * Auth: `Authorization: Bearer <api key>`; POST needs the EXPLICIT scope `quota:publish`, GET the EXPLICIT
 * scope `quota:read` (hasExplicitScope: a legacy NULL-scopes key never qualifies, neither scope implies
 * the other, and cookies never authenticate). Mounted BEFORE the /api/* auth catch-all (index.ts).
 *
 * The body is a CUG usage-snapshot v1, strict at both levels: email, label and any unknown key are a 400
 * with no row written. The body is never logged and no Zod issue value is echoed. user_id comes only from
 * the verified key. See docs/corch.md "Quota eligibility (CORCH-02)".
 */
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { hashToken } from '../lib/crypto'
import { verifyApiKeyFull } from '../db/dal'
import { hasExplicitScope, SCOPE_QUOTA_PUBLISH, SCOPE_QUOTA_READ } from '../auth/scopes'
import { quotaStore, type QuotaAccountInput } from '../corch/quota-store.ts'
import { evaluateAccounts, type QuotaAccountRow } from '../corch/quota-eligibility.ts'

export const QUOTA_MAX_BODY_BYTES = 64 * 1024
export const QUOTA_MAX_ACCOUNTS = 32

const iso = z.string().datetime({ offset: true })
const pct = z.number().finite().min(0).max(1000).nullable()

const AccountSchema = z
  .object({
    account_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    slot: z.union([z.string().max(64), z.number().int()]).nullable(),
    five_h_pct: pct,
    seven_d_pct: pct,
    resets_5h: iso.nullable(),
    resets_7d: iso.nullable(),
    fetched_at: iso.nullable(),
    source: z.string().min(1).max(32),
    enabled: z.boolean(),
    blocked: z.boolean(),
    current: z.boolean(),
  })
  .strict()

export const SnapshotSchema = z
  .object({
    schema: z.literal(1),
    publisher: z.literal('cug'),
    generated_at: iso,
    poll_interval_secs: z.number().int().min(1).max(86400),
    accounts: z.array(AccountSchema).max(QUOTA_MAX_ACCOUNTS),
  })
  .strict()

export interface QuotaKey {
  id: string
  user_id: string
  scopes: string[] | null
}

export interface QuotaRouteDeps {
  /** Resolve a raw Bearer key. null = unknown. Throwing = lookup failure (fails closed to 401). */
  verifyKey: (rawKey: string) => Promise<QuotaKey | null>
  store: {
    upsertSnapshot: (userId: string, accounts: QuotaAccountInput[]) => Promise<number>
    accountsFor: (userId: string) => Promise<QuotaAccountRow[]>
  }
  ceilingPct: () => number
  /** Called exactly once after a successful POST commit. */
  evaluate: (userId: string) => Promise<void>
  now: () => Date
}

export function createQuotaRoutes(deps: QuotaRouteDeps) {
  const app = new Hono<{ Variables: { quotaKey: QuotaKey } }>()

  const requireScope = (scope: string) => async (c: any, next: () => Promise<void>) => {
    const auth = c.req.header('Authorization') ?? ''
    const rawKey = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    if (!/^(remokey_|remo_)[A-Za-z0-9_-]+$/.test(rawKey)) return c.json({ error: 'unauthorized' }, 401)
    // FAIL CLOSED: a lookup failure never authenticates.
    let key: QuotaKey | null = null
    try {
      key = await deps.verifyKey(rawKey)
    } catch (err: any) {
      console.warn(`[quota] key lookup failed: ${err?.message ?? err}`)
      return c.json({ error: 'unauthorized' }, 401)
    }
    if (!key) return c.json({ error: 'unauthorized' }, 401)
    if (!hasExplicitScope(key.scopes, scope)) {
      return c.json({ error: 'insufficient_scope', required: scope }, 403)
    }
    c.set('quotaKey', key)
    return next()
  }

  app.post(
    '/snapshot',
    requireScope(SCOPE_QUOTA_PUBLISH),
    bodyLimit({ maxSize: QUOTA_MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const key = c.get('quotaKey')
      let json: unknown
      try {
        json = JSON.parse(await c.req.text())
      } catch {
        console.warn(`[quota] invalid_snapshot user=${key.user_id}`)
        return c.json({ error: 'invalid_snapshot' }, 400)
      }
      const parsed = SnapshotSchema.safeParse(json)
      if (!parsed.success) {
        console.warn(`[quota] invalid_snapshot user=${key.user_id}`)
        return c.json({ error: 'invalid_snapshot' }, 400)
      }
      const accounts: QuotaAccountInput[] = parsed.data.accounts.map((a) => ({
        account_id: a.account_id,
        slot: a.slot === null ? null : String(a.slot),
        five_h_pct: a.five_h_pct,
        seven_d_pct: a.seven_d_pct,
        resets_5h: a.resets_5h,
        resets_7d: a.resets_7d,
        fetched_at: a.fetched_at,
        source: a.source,
        enabled: a.enabled,
        blocked: a.blocked,
      }))
      let accepted: number
      try {
        accepted = await deps.store.upsertSnapshot(key.user_id, accounts)
      } catch (err: any) {
        console.error(`[quota] snapshot_store_failed user=${key.user_id}`)
        return c.json({ error: 'snapshot_store_failed' }, 500)
      }
      try {
        await deps.evaluate(key.user_id)
      } catch (err: any) {
        console.warn(`[quota] evaluate trigger failed user=${key.user_id}: ${err?.message ?? err}`)
      }
      return c.json({ ok: true, accepted }, 200)
    },
  )

  app.get('/snapshot', requireScope(SCOPE_QUOTA_READ), async (c) => {
    const key = c.get('quotaKey')
    let ceiling: number
    try {
      ceiling = deps.ceilingPct()
    } catch {
      return c.json({ error: 'quota_ceiling_invalid' }, 500)
    }
    const rows = await deps.store.accountsFor(key.user_id)
    const evals = evaluateAccounts(rows, { now: deps.now(), ceilingPct: ceiling })
    const iso = (d: Date | null) => (d ? d.toISOString() : null)
    return c.json({
      ceiling_pct: ceiling,
      accounts: rows.map((r, i) => ({
        account_id: r.account_id,
        slot: r.slot,
        eligible: evals[i]!.eligible,
        reason: evals[i]!.reason,
        not_before: evals[i]!.not_before,
        five_h_pct: r.five_h_pct,
        seven_d_pct: r.seven_d_pct,
        resets_5h: iso(r.resets_5h),
        resets_7d: iso(r.resets_7d),
        fetched_at: iso(r.fetched_at),
        source: r.source,
        received_at: iso(r.received_at),
        blocked_until: iso(r.blocked_until),
      })),
    })
  })

  return app
}

/** Task 5 replaces this no-op with the flag-gated dispatcher trigger (LD-Q11). */
async function noopEvaluate(_userId: string): Promise<void> {}

export default createQuotaRoutes({
  verifyKey: async (rawKey) => verifyApiKeyFull(await hashToken(rawKey)),
  store: quotaStore,
  ceilingPct: () => 55,
  evaluate: noopEvaluate,
  now: () => new Date(),
})

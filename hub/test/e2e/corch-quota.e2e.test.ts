// CORCH-02 e2e on real Postgres. Skips only when REMO_E2E_DB_URL is unset.
// Boots the REAL hub app (hub/src/index.ts) against the disposable DB; DATABASE_URL is pointed at the
// same DB before any hub module loads.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('CORCH-02 e2e - quota ingest on real Postgres', () => {
  let harness: typeof import('./orchestrator-harness.ts')
  let h: import('./orchestrator-harness.ts').Harness
  let app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> }
  let publishKey = ''
  let readKey = ''

  const snapshot = (accounts: Record<string, unknown>[]) => ({
    schema: 1,
    publisher: 'cug',
    generated_at: new Date().toISOString(),
    poll_interval_secs: 300,
    accounts,
  })
  const acct = (id: string, over: Record<string, unknown> = {}) => ({
    account_id: id,
    slot: id,
    five_h_pct: 10,
    seven_d_pct: 20,
    resets_5h: new Date(Date.now() + 3_600_000).toISOString(),
    resets_7d: new Date(Date.now() + 86_400_000).toISOString(),
    fetched_at: new Date().toISOString(),
    source: 'live',
    enabled: true,
    blocked: false,
    current: false,
    ...over,
  })
  const post = (body: unknown, key = publishKey) =>
    app.request('/api/quota/snapshot', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  const get = (key = readKey) =>
    app.request('/api/quota/snapshot', { headers: { Authorization: `Bearer ${key}` } })

  async function mintKey(userId: string, scopes: string[]): Promise<string> {
    const { hashToken } = await import('../../src/lib/crypto.ts')
    const { createApiKey } = await import('../../src/db/dal.ts')
    const raw = `remokey_${randomUUID().replace(/-/g, '')}`
    await createApiKey(userId, await hashToken(raw), `quota-e2e-${scopes.join('+')}`, {
      purpose: 'external',
      scopes,
    })
    return raw
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    harness = await import('./orchestrator-harness.ts')
    h = await harness.setupHarness()
    app = (await import('../../src/index.ts')).app as any
    publishKey = await mintKey(h.userId, ['quota:publish'])
    readKey = await mintKey(h.userId, ['quota:read'])
  }, 60_000)

  afterAll(async () => {
    if (h) await harness.teardownHarness(h)
  })

  test('tracer: publish -> store -> read on real Postgres', async () => {
    const r = await post(snapshot([acct('acct_a')]))
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ ok: true, accepted: 1 })

    const rows = await h.sql`SELECT account_id, source FROM corch_quota_accounts WHERE user_id = ${h.userId}`
    expect(rows.length).toBe(1)
    expect(rows[0]!.account_id).toBe('acct_a')

    const g = await get()
    expect(g.status).toBe(200)
    const body = (await g.json()) as any
    expect(body.accounts.length).toBe(1)
    expect(body.accounts[0].account_id).toBe('acct_a')
    expect(body.accounts[0].eligible).toBe(true)
    expect(body.accounts[0].reason).toBeNull()
  })
})

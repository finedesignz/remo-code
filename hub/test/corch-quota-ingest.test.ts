// CORCH-02 Task 2: ingest auth, strictness and isolation pins (SC1, SC2; CORCH-R2.1, CORCH-R2.2).
// createQuotaRoutes with fake verifyKey / store / evaluate: no DB, no network.
import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { createQuotaRoutes, type QuotaKey, type QuotaRouteDeps } from '../src/api/quota.ts'
import type { QuotaAccountRow } from '../src/corch/quota-eligibility.ts'

const KEYS: Record<string, QuotaKey> = {
  remokey_publish: { id: 'k1', user_id: 'user-A', scopes: ['quota:publish'] },
  remokey_read: { id: 'k2', user_id: 'user-A', scopes: ['quota:read'] },
  remokey_legacy: { id: 'k3', user_id: 'user-A', scopes: null },
  remokey_empty: { id: 'k4', user_id: 'user-A', scopes: [] },
  remokey_others: {
    id: 'k5',
    user_id: 'user-A',
    scopes: ['agent', 'ext:read', 'ext:ask', 'ext:work', 'ext:launch', 'ext:corch', 'cloud:hook', 'settings:read', 'settings:write', 'chat:session'],
  },
  remokey_both: { id: 'k6', user_id: 'user-B', scopes: ['quota:publish', 'quota:read'] },
}

function row(id: string, over: Partial<QuotaAccountRow> = {}): QuotaAccountRow {
  const now = new Date('2026-11-13T12:00:00Z')
  return {
    account_id: id, slot: id, five_h_pct: 10, seven_d_pct: 20, resets_5h: null, resets_7d: null,
    fetched_at: now, source: 'live', enabled: true, cug_blocked: false, received_at: now,
    blocked_until: null, blocked_at: null, ...over,
  }
}

function setup(rowsByUser: Record<string, QuotaAccountRow[]> = {}, busyByUser: Record<string, Record<string, number>> = {}) {
  const upserts: Array<{ userId: string; accounts: unknown[] }> = []
  const evaluated: string[] = []
  const deps: QuotaRouteDeps = {
    verifyKey: async (raw) => KEYS[raw] ?? null,
    store: {
      upsertSnapshot: async (userId, accounts) => {
        upserts.push({ userId, accounts })
        return accounts.length
      },
      accountsFor: async (userId) => rowsByUser[userId] ?? [],
      liveRunsByAccount: async (userId) => busyByUser[userId] ?? {},
    },
    ceilingPct: () => 55,
    evaluate: async (userId) => {
      evaluated.push(userId)
    },
    now: () => new Date('2026-11-13T12:00:10Z'),
  }
  return { app: createQuotaRoutes(deps), upserts, evaluated }
}

const acct = (id: string, over: Record<string, unknown> = {}) => ({
  account_id: id, slot: id, five_h_pct: 10, seven_d_pct: 20, resets_5h: '2026-11-13T15:00:00Z',
  resets_7d: '2026-11-18T15:00:00Z', fetched_at: '2026-11-13T12:00:00Z', source: 'live',
  enabled: true, blocked: false, current: false, ...over,
})
const snap = (accounts: unknown[], over: Record<string, unknown> = {}) => ({
  schema: 1, publisher: 'cug', generated_at: '2026-11-13T12:00:00Z', poll_interval_secs: 300, accounts, ...over,
})
const post = (app: ReturnType<typeof createQuotaRoutes>, key: string | null, body: unknown, raw?: string) =>
  app.request('/snapshot', {
    method: 'POST',
    headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  })
const get = (app: ReturnType<typeof createQuotaRoutes>, key: string | null) =>
  app.request('/snapshot', { headers: key ? { Authorization: `Bearer ${key}` } : {} })

describe('CORCH-R2.1 SC1: POST /snapshot auth is explicit-scope only', () => {
  test('no header, malformed Bearer, unknown key => 401', async () => {
    const { app, upserts } = setup()
    expect((await post(app, null, snap([]))).status).toBe(401)
    expect((await app.request('/snapshot', { method: 'POST', headers: { Authorization: 'Bearer bad key!' }, body: '{}' })).status).toBe(401)
    expect((await post(app, 'remokey_unknown', snap([]))).status).toBe(401)
    expect(upserts.length).toBe(0)
  })

  test('a throwing key lookup fails closed to 401', async () => {
    const { app } = setup()
    const deps2: QuotaRouteDeps = {
      verifyKey: async () => { throw new Error('db down') },
      store: { upsertSnapshot: async () => 0, accountsFor: async () => [], liveRunsByAccount: async () => ({}) },
      ceilingPct: () => 55, evaluate: async () => {}, now: () => new Date(),
    }
    const res = await post(createQuotaRoutes(deps2), 'remokey_publish', snap([]))
    expect(res.status).toBe(401)
    void app
  })

  test('NULL-scope legacy key, empty scopes and every non-quota scope => 403 on POST and GET', async () => {
    const { app, upserts } = setup()
    for (const k of ['remokey_legacy', 'remokey_empty', 'remokey_others']) {
      const p = await post(app, k, snap([acct('a')]))
      expect(p.status).toBe(403)
      expect(await p.json()).toEqual({ error: 'insufficient_scope', required: 'quota:publish' })
      const g = await get(app, k)
      expect(g.status).toBe(403)
      expect(await g.json()).toEqual({ error: 'insufficient_scope', required: 'quota:read' })
    }
    expect(upserts.length).toBe(0)
  })

  test('quota:read key POST => 403 required quota:publish; quota:publish key GET => 403 required quota:read', async () => {
    const { app, upserts } = setup()
    const p = await post(app, 'remokey_read', snap([acct('a')]))
    expect(p.status).toBe(403)
    expect(await p.json()).toEqual({ error: 'insufficient_scope', required: 'quota:publish' })
    const g = await get(app, 'remokey_publish')
    expect(g.status).toBe(403)
    expect(await g.json()).toEqual({ error: 'insufficient_scope', required: 'quota:read' })
    expect(upserts.length).toBe(0)
  })
})

describe('CORCH-R2.1 SC1: valid body', () => {
  test('2 accounts => 200 {ok:true, accepted:2}; upsert called once with the key owner user id', async () => {
    const { app, upserts } = setup()
    const res = await post(app, 'remokey_publish', snap([acct('acct_a'), acct('acct_b', { slot: 3, five_h_pct: null })]))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, accepted: 2 })
    expect(upserts.length).toBe(1)
    expect(upserts[0]!.userId).toBe('user-A')
    expect((upserts[0]!.accounts[1] as any).slot).toBe('3')
    expect((upserts[0]!.accounts[1] as any).five_h_pct).toBeNull()
  })

  test('a user_id field in the body is itself an unknown key => 400', async () => {
    const { app, upserts } = setup()
    expect((await post(app, 'remokey_publish', snap([acct('a')], { user_id: 'user-B' }))).status).toBe(400)
    expect((await post(app, 'remokey_publish', snap([acct('a', { user_id: 'user-B' })]))).status).toBe(400)
    expect(upserts.length).toBe(0)
  })

  test('an empty accounts array is accepted (0)', async () => {
    const { app, upserts } = setup()
    const res = await post(app, 'remokey_publish', snap([]))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, accepted: 0 })
    expect(upserts.length).toBe(1)
  })
})

describe('CORCH-R2.1 SC2: strict body, 400 and no row', () => {
  const bad: Array<[string, () => unknown]> = [
    ['email at account level', () => snap([acct('a', { email: 'x@example.invalid' })])],
    ['email at top level', () => snap([acct('a')], { email: 'x@example.invalid' })],
    ['label at account level', () => snap([acct('a', { label: 'work' })])],
    ['unknown key at top level', () => snap([acct('a')], { extra: 1 })],
    ['unknown key at account level', () => snap([acct('a', { extra: 1 })])],
    ['schema 2', () => snap([acct('a')], { schema: 2 })],
    ["publisher 'other'", () => snap([acct('a')], { publisher: 'other' })],
    ['33 accounts', () => snap(Array.from({ length: 33 }, (_, i) => acct(`a${i}`)))],
    ['five_h_pct -1', () => snap([acct('a', { five_h_pct: -1 })])],
    ['account_id with a dot', () => snap([acct('a.b')])],
    ['account_id of 65 chars', () => snap([acct('a'.repeat(65))])],
    ['non-finite-ish pct 1001', () => snap([acct('a', { seven_d_pct: 1001 })])],
    ['generated_at not a datetime', () => snap([acct('a')], { generated_at: 'yesterday' })],
    ['poll_interval_secs 0', () => snap([acct('a')], { poll_interval_secs: 0 })],
    ['missing source', () => snap([{ ...acct('a'), source: undefined }])],
  ]
  for (const [name, build] of bad) {
    test(`${name} => 400 invalid_snapshot, store never called`, async () => {
      const { app, upserts, evaluated } = setup()
      const res = await post(app, 'remokey_publish', build())
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'invalid_snapshot' })
      expect(upserts.length).toBe(0)
      expect(evaluated.length).toBe(0)
    })
  }

  test('invalid JSON => 400, store never called', async () => {
    const { app, upserts } = setup()
    expect((await post(app, 'remokey_publish', null, '{not json')).status).toBe(400)
    expect(upserts.length).toBe(0)
  })

  test('a body over 64 KiB => 413, store never called', async () => {
    const { app, upserts } = setup()
    const res = await post(app, 'remokey_publish', null, JSON.stringify({ pad: 'x'.repeat(70 * 1024) }))
    expect(res.status).toBe(413)
    expect(upserts.length).toBe(0)
  })
})

describe('CORCH-R2.1 T-CORCH02-10: a 400 never logs or echoes body values', () => {
  const spies: Array<{ mockRestore: () => void }> = []
  afterEach(() => { while (spies.length) spies.pop()!.mockRestore() })

  test('email probe-x@example.invalid and account_id probe_acct_9 appear nowhere in the response or console', async () => {
    const logged: string[] = []
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      spies.push(spyOn(console, m).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')) }))
    }
    const { app } = setup()
    const res = await post(app, 'remokey_publish', snap([acct('probe_acct_9', { email: 'probe-x@example.invalid' })]))
    expect(res.status).toBe(400)
    const text = await res.text()
    const all = logged.join('\n') + '\n' + text
    expect(all).not.toContain('probe-x@example.invalid')
    expect(all).not.toContain('probe_acct_9')
    expect(logged.some((l) => l.includes('invalid_snapshot') && l.includes('user-A'))).toBe(true)
  })
})

describe('CORCH-R2.2: GET /snapshot is per key owner', () => {
  test('returns only that user rows, with eligibility, never an email or label field', async () => {
    const { app } = setup({ 'user-A': [row('acct_a'), row('acct_b', { source: 'fetch_failed' })], 'user-B': [row('acct_z')] })
    const res = await get(app, 'remokey_read')
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.ceiling_pct).toBe(55)
    expect(body.accounts.map((a: any) => a.account_id)).toEqual(['acct_a', 'acct_b'])
    expect(body.accounts[0].eligible).toBe(true)
    expect(body.accounts[1].eligible).toBe(false)
    expect(body.accounts[1].reason).toBe('quota:source_not_live')
    const text = JSON.stringify(body)
    expect(text).not.toContain('acct_z')
    for (const a of body.accounts) {
      expect('email' in a).toBe(false)
      expect('label' in a).toBe(false)
    }
  })

  test('F6: eligibility counts live runs per account (same as dispatch): null-5h + a live run => eligible false', async () => {
    const { app } = setup(
      { 'user-A': [row('acct_n', { five_h_pct: null }), row('acct_ok')], 'user-B': [row('acct_z', { five_h_pct: null })] },
      { 'user-A': { acct_n: 1, acct_ok: 1 }, 'user-B': { acct_z: 0 } },
    )
    const body = (await (await get(app, 'remokey_read')).json()) as any
    expect(body.accounts[0]).toMatchObject({ account_id: 'acct_n', eligible: false, reason: 'quota:five_h_unknown_busy' })
    expect(body.accounts[1]).toMatchObject({ account_id: 'acct_ok', eligible: true }) // known 5h is not capped by busy
  })

  test('no rows => accounts []', async () => {
    const { app } = setup()
    const res = await get(app, 'remokey_read')
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).accounts).toEqual([])
  })
})

describe('CORCH-R2.3 LD-Q7: an invalid ceiling is a 500 on GET, never a silent default', () => {
  test('ceilingPct throwing => 500 quota_ceiling_invalid', async () => {
    const deps: QuotaRouteDeps = {
      verifyKey: async (raw) => KEYS[raw] ?? null,
      store: { upsertSnapshot: async () => 0, accountsFor: async () => [row('acct_a')], liveRunsByAccount: async () => ({}) },
      ceilingPct: () => { throw new Error('bad') },
      evaluate: async () => {}, now: () => new Date('2026-11-13T12:00:10Z'),
    }
    const res = await get(createQuotaRoutes(deps), 'remokey_read')
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'quota_ceiling_invalid' })
  })
})

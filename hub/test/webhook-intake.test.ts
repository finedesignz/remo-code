/**
 * Webhook auth-gate deep module tests (Phase 2 foundation, C2).
 *
 * Proves the security invariants from the Invariant-Risk Register:
 *   IR-3  HMAC computed over EXACT raw bytes (a parses-equal-but-byte-differs
 *         body fails HMAC → proves raw-body-before-parse).
 *   IR-4  constant-time compare: equal / mismatch / unequal-length-no-throw;
 *         uses timingSafeEqual.
 *   IR-5  audit row is preview-only (≤500 chars) and contains NO token/secret.
 *   IR-6  onAuthFail:false writes NOTHING on auth failure (sentry/telegram DoS
 *         guard); onAuthFail:true writes a row.
 *   + skew accept at +299s / reject at +301s.
 *   + IP allowlist allow/deny (reuses cidr.ts).
 *   + uniform 401 shape (no leak of which check failed).
 *
 * No DB, no Postgres — the audit `record` is an in-memory spy and every gate
 * is driven through a real Hono app via `app.request()` (same harness the
 * per-webhook tests use), so the real Hono Context flows through `runIntake`.
 */
import { describe, test, expect } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import type { Context } from 'hono'
import {
  runIntake,
  constantTimeEqual,
  verifyHmacSig,
  type IntakeConfig,
  type AuditRow,
} from '../src/webhooks/intake.ts'

const SECRET = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

/** Build a one-route Hono app that runs `runIntake(cfg)` and returns its result. */
function appFor(cfg: IntakeConfig) {
  const app = new Hono()
  app.post('/hook/:user_id/:token', async (c) => {
    const r = await runIntake(c, cfg)
    if (!r.ok) return c.json(r.body, r.status)
    return c.json({ accepted: true, ownerId: r.ownerId, rawBody: r.rawBody }, 202)
  })
  // single-segment variant for global-secret (telegram-style)
  app.post('/global/:secret', async (c) => {
    const r = await runIntake(c, cfg)
    if (!r.ok) return c.json(r.body, r.status)
    return c.json({ accepted: true, ownerId: r.ownerId }, 202)
  })
  return app
}

/** url-token config (revanote/coolify-style): owner+secret from URL params. */
function urlTokenCfg(over: Partial<IntakeConfig> = {}, audit?: { rows: AuditRow[]; onAuthFail: boolean }): IntakeConfig {
  return {
    credentialSource: 'url-token',
    resolveSecret: async (c: Context) => ({
      ownerId: c.req.param('user_id') ?? null,
      presented: c.req.param('token') ?? '',
      secret: SECRET,
    }),
    verifyHmac: false,
    audit: audit ? { record: async (row) => { audit.rows.push(row) }, onAuthFail: audit.onAuthFail } : undefined,
    ...over,
  }
}

// ── constant-time compare (IR-4) ─────────────────────────────────────────────

describe('constantTimeEqual (IR-4)', () => {
  test('equal strings → true', () => {
    expect(constantTimeEqual(SECRET, SECRET)).toBe(true)
  })
  test('same-length mismatch → false', () => {
    expect(constantTimeEqual('a'.repeat(36), 'b'.repeat(36))).toBe(false)
  })
  test('unequal length → false WITHOUT throwing', () => {
    expect(() => constantTimeEqual('short', 'a-much-longer-value')).not.toThrow()
    expect(constantTimeEqual('short', 'a-much-longer-value')).toBe(false)
  })
  test('empty vs non-empty → false', () => {
    expect(constantTimeEqual('', SECRET)).toBe(false)
  })
})

// ── HMAC over EXACT raw bytes (IR-3) ─────────────────────────────────────────

describe('verifyHmacSig + raw-body discipline (IR-3)', () => {
  const body = JSON.stringify({ a: 1, b: 2 })

  test('valid signature over rawBody → true', () => {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex')
    expect(verifyHmacSig(SECRET, '', body, sig)).toBe(true)
  })

  test('valid signature over `${ts}.${rawBody}` → true', () => {
    const ts = '1700000000'
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')
    expect(verifyHmacSig(SECRET, ts, body, sig)).toBe(true)
  })

  test('parses-equal-but-byte-differs body FAILS hmac (proves raw bytes, not parsed)', () => {
    // Same JSON value, different bytes (extra whitespace).
    const signedBytes = '{"a":1,"b":2}'
    const sentBytes = '{ "a": 1, "b": 2 }'
    expect(JSON.stringify(JSON.parse(signedBytes))).toBe(JSON.stringify(JSON.parse(sentBytes)))
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(signedBytes).digest('hex')
    // Signature was computed over signedBytes; verifying against sentBytes must fail.
    expect(verifyHmacSig(SECRET, '', sentBytes, sig)).toBe(false)
  })

  test('wrong secret → false', () => {
    const sig = 'sha256=' + createHmac('sha256', 'other-secret').update(body).digest('hex')
    expect(verifyHmacSig(SECRET, '', body, sig)).toBe(false)
  })
})

// ── runIntake: url-token credential gate + uniform 401 ───────────────────────

describe('runIntake url-token credential', () => {
  test('correct token → ok:true with ownerId + rawBody', async () => {
    const app = appFor(urlTokenCfg())
    const body = JSON.stringify({ hello: 'world' })
    const res = await app.request(`/hook/user-1/${SECRET}`, { method: 'POST', body })
    expect(res.status).toBe(202)
    const j = await res.json()
    expect(j.accepted).toBe(true)
    expect(j.ownerId).toBe('user-1')
    expect(j.rawBody).toBe(body) // exact bytes handed back
  })

  test('wrong token → uniform 401 { error: unauthorized }', async () => {
    const app = appFor(urlTokenCfg())
    const res = await app.request(`/hook/user-1/wrong-token`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  test('no secret configured → SAME uniform 401 (no enumeration leak)', async () => {
    const app = appFor(urlTokenCfg({ resolveSecret: async (c) => ({ ownerId: c.req.param('user_id') ?? null, presented: c.req.param('token') ?? '', secret: null }) }))
    const res = await app.request(`/hook/user-1/${SECRET}`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })
})

// ── HMAC enforcement modes through runIntake ─────────────────────────────────

describe('runIntake HMAC modes', () => {
  const body = JSON.stringify({ ev: 'x' })

  test('hmacRequiredWhenPresent: valid sig → ok', async () => {
    const app = appFor(urlTokenCfg({ verifyHmac: true, hmacHeader: 'x-revuu-signature', hmacRequiredWhenPresent: true }))
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex')
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body, headers: { 'x-revuu-signature': sig } })
    expect(res.status).toBe(202)
  })

  test('hmacRequiredWhenPresent: absent header → ok (accept unsigned)', async () => {
    const app = appFor(urlTokenCfg({ verifyHmac: true, hmacHeader: 'x-revuu-signature', hmacRequiredWhenPresent: true }))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body })
    expect(res.status).toBe(202)
  })

  test('hmacRequiredWhenPresent: present-but-bad → 401', async () => {
    const app = appFor(urlTokenCfg({ verifyHmac: true, hmacHeader: 'x-revuu-signature', hmacRequiredWhenPresent: true }))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body, headers: { 'x-revuu-signature': 'sha256=deadbeef' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
  })

  test('required HMAC (not when-present): missing header → 401', async () => {
    const app = appFor(urlTokenCfg({ verifyHmac: true, hmacHeader: 'x-coolify-signature', hmacTimestampHeader: 'x-coolify-timestamp' }))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body })
    expect(res.status).toBe(401)
  })
})

// ── skew accept/reject (±300s) ───────────────────────────────────────────────

describe('runIntake HMAC timestamp skew', () => {
  const body = JSON.stringify({ ev: 'deploy' })
  const cfg = () => urlTokenCfg({ verifyHmac: true, hmacHeader: 'x-coolify-signature', hmacTimestampHeader: 'x-coolify-timestamp', skewSeconds: 300 })

  function signed(ts: number) {
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex')
    return { 'x-coolify-signature': sig, 'x-coolify-timestamp': String(ts) }
  }

  test('+299s within window → ok', async () => {
    const app = appFor(cfg())
    const ts = Math.floor(Date.now() / 1000) - 299
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body, headers: signed(ts) })
    expect(res.status).toBe(202)
  })

  test('+301s outside window → 401', async () => {
    const app = appFor(cfg())
    const ts = Math.floor(Date.now() / 1000) - 301
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body, headers: signed(ts) })
    expect(res.status).toBe(401)
  })

  test('non-numeric timestamp → 401', async () => {
    const app = appFor(cfg())
    const sig = 'sha256=' + createHmac('sha256', SECRET).update(`xx.${body}`).digest('hex')
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body, headers: { 'x-coolify-signature': sig, 'x-coolify-timestamp': 'not-a-number' } })
    expect(res.status).toBe(401)
  })
})

// ── IP allowlist (reuses cidr.ts) ────────────────────────────────────────────

describe('runIntake IP allowlist', () => {
  test('source IP in allowlist → ok', async () => {
    const app = appFor(urlTokenCfg({ ipAllowlist: async () => ['10.0.0.0/8'] }))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body: '{}', headers: { 'x-real-ip': '10.1.2.3' } })
    expect(res.status).toBe(202)
  })

  test('source IP NOT in allowlist → 403 ip_not_allowed', async () => {
    const app = appFor(urlTokenCfg({ ipAllowlist: async () => ['10.0.0.0/8'] }))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body: '{}', headers: { 'x-real-ip': '8.8.8.8' } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'ip_not_allowed' })
  })

  test('empty allowlist → allow-all (ok)', async () => {
    const app = appFor(urlTokenCfg({ ipAllowlist: async () => [] }))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body: '{}', headers: { 'x-real-ip': '8.8.8.8' } })
    expect(res.status).toBe(202)
  })
})

// ── audit policy (IR-5 / IR-6) ───────────────────────────────────────────────

describe('audit policy (IR-5/IR-6)', () => {
  test('onAuthFail:true → auth failure writes ONE preview-only row with NO token', async () => {
    const audit = { rows: [] as AuditRow[], onAuthFail: true }
    const app = appFor(urlTokenCfg({}, audit))
    const body = 'x'.repeat(2000) // >500 → must be truncated in the preview
    const res = await app.request(`/hook/owner-9/super-secret-bad-token-value`, { method: 'POST', body })
    expect(res.status).toBe(401)
    expect(audit.rows.length).toBe(1)
    const row = audit.rows[0]!
    expect(row.status).toBe('auth_failed')
    expect(row.ownerId).toBe('owner-9')
    // IR-5: preview ≤500 chars.
    expect(row.rawBodyPreview!.length).toBeLessThanOrEqual(500)
    // IR-5: the presented bad token must NOT appear anywhere in the audit row.
    const serialized = JSON.stringify(row)
    expect(serialized.includes('super-secret-bad-token-value')).toBe(false)
    // And the audit row has no field named token/secret.
    expect('token' in (row as any)).toBe(false)
    expect('secret' in (row as any)).toBe(false)
  })

  test('onAuthFail:false → auth failure writes NOTHING (DoS guard, IR-6)', async () => {
    const audit = { rows: [] as AuditRow[], onAuthFail: false }
    const app = appFor(urlTokenCfg({}, audit))
    const res = await app.request(`/hook/u/wrong`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(audit.rows.length).toBe(0)
  })

  test('no audit config at all → auth failure still 401, no crash', async () => {
    const app = appFor(urlTokenCfg()) // audit undefined
    const res = await app.request(`/hook/u/wrong`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  test('hmac_failed audit row carries status hmac_failed', async () => {
    const audit = { rows: [] as AuditRow[], onAuthFail: true }
    const app = appFor(urlTokenCfg({ verifyHmac: true, hmacHeader: 'x-revuu-signature', hmacRequiredWhenPresent: true }, audit))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body: '{}', headers: { 'x-revuu-signature': 'sha256=deadbeef' } })
    expect(res.status).toBe(401)
    expect(audit.rows.length).toBe(1)
    expect(audit.rows[0]!.status).toBe('hmac_failed')
  })

  test('SUCCESS is NOT audited by runIntake (caller owns the success row)', async () => {
    const audit = { rows: [] as AuditRow[], onAuthFail: true }
    const app = appFor(urlTokenCfg({}, audit))
    const res = await app.request(`/hook/u/${SECRET}`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(202)
    expect(audit.rows.length).toBe(0)
  })
})

// ── global-secret (telegram-style) ───────────────────────────────────────────

describe('runIntake global secret (telegram-style)', () => {
  function globalCfg(onAuthFail: boolean, audit: { rows: AuditRow[] }): IntakeConfig {
    return {
      credentialSource: 'url-secret',
      resolveSecret: async (c: Context) => ({ ownerId: null, presented: c.req.param('secret') ?? '', secret: SECRET }),
      verifyHmac: false,
      audit: { record: async (r) => { audit.rows.push(r) }, onAuthFail },
    }
  }

  test('correct global secret → ok, ownerId null', async () => {
    const audit = { rows: [] as AuditRow[] }
    const app = appFor(globalCfg(false, audit))
    const res = await app.request(`/global/${SECRET}`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(202)
    expect((await res.json()).ownerId).toBeNull()
  })

  test('wrong global secret → 401 + NO audit row (IR-6)', async () => {
    const audit = { rows: [] as AuditRow[] }
    const app = appFor(globalCfg(false, audit))
    const res = await app.request(`/global/wrong`, { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
    expect(audit.rows.length).toBe(0)
  })
})

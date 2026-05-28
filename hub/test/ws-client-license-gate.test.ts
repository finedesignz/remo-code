/**
 * Bundle 4 (TRIAGE-2026-05-28): Phase 07 invariant — /ws/client mutations
 * must respect license_status. Mirrors the HTTP `requireActiveLicense` gate.
 *
 * Strategy: mock the DAL + auth modules, drive `handleClientMessage` directly
 * with a fake ServerWebSocket. No Postgres, no real socket.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
// Force the gate ON (prod runs with TITANIUM_BYPASS=true; tests must not).
process.env.TITANIUM_BYPASS = 'false'
process.env.LICENSE_REQUIRED = 'true'
process.env.ALLOW_LEGACY_LOGIN = 'true' // permit bearer JWT auth path
// Short TTL so opportunistic-refresh test runs quickly.
process.env.TITANIUM_LICENSE_CACHE_TTL_SECONDS = '1'

import { describe, test, expect, mock, beforeEach } from 'bun:test'

// Defeat sibling mock.module registrations (notably
// send-fence-scheduled-run.test.ts which hardcodes `getUserLicenseFields`
// to always-active) BEFORE we install ours. Bun's mock.module is
// process-global + first-write-wins per specifier; `mock.restore()` is the
// only reliable way to clear prior registrations so our new ones land.
mock.restore()

// Force config flags to gate-ON values regardless of which test file loaded
// `src/config` first. `config.ts` reads env at module-load time, and Bun's
// module cache is process-wide — so a sibling test that imported config with
// `TITANIUM_BYPASS=true` (e.g. send-fence-scheduled-run) freezes our gate
// OPEN by the time we get here. The exported `config` object is plain (not
// Object.freezed), so we mutate the cached value in place.
//
// Additionally: defeat sibling `mock.module('../src/config.ts', …)` pollution
// from `telegram-api.test.ts` which stubs config with a telegram-only shape
// lacking `titaniumBypass` / `licenseRequired` / `titanium`. When that mock
// fires first, `config` is an object with only `.telegram`; assigning our
// flags works, but `client.ts` reads `config.titanium.licenseCacheTtlSeconds`
// and crashes (or `!config.licenseRequired` is `true` when undefined → gate
// auto-opens). Graft on the missing fields the same way titanium-client.test
// does, so the cached object satisfies both shapes regardless of fire order.
const { config } = await import('../src/config') as any
config.titaniumBypass = false
config.licenseRequired = true
config.allowLegacyLogin = true // bearer JWT auth path used by tests below
if (!config.titanium) {
  config.titanium = {
    keygenApiUrl: process.env.TITANIUM_KEYGEN_API_URL,
    accountId: process.env.TITANIUM_KEYGEN_ACCOUNT_ID,
    productId: process.env.TITANIUM_KEYGEN_PRODUCT_ID,
    portalToken: '',
    adminToken: '',
    licenseCacheTtlSeconds: 1,
  }
} else {
  config.titanium.licenseCacheTtlSeconds = 1
}

// --- Mocks (must precede module under test) -----------------------------

// IMPORTANT: ws/client is loaded (and its `getUserLicenseFields` import
// bound) by `send-fence-scheduled-run.test.ts` which runs BEFORE this file
// alphabetically. Bun's mock.module is process-global + first-write-wins
// per specifier, so our own mock.module('../src/db/dal', ...) below is
// IGNORED for the cached client.ts. The send-fence mock now reads from a
// global toggle (see that file) — we drive license_status by writing to
// that same toggle here, which propagates to the cached binding.
function setLicenseStatus(s: string) {
  ;(globalThis as any).__wsClientLicenseStatusForTests = s
}
let licenseStatus: string | null = 'active'
let dalCalls = 0
const getUserLicenseFields = mock(async (_userId: string) => {
  dalCalls++
  return {
    license_status: licenseStatus,
    license_id: 'lic-1',
    license_checked_at: new Date(),
    titanium_subject: 'subj-1',
  }
})
const getSession = mock(async (_id: string, _userId: string) => ({
  id: 'sess-1',
  user_id: 'user-1',
}))
const listSessions = mock(async (_userId: string) => [])
const insertMessage = mock(async (_sid: string, _role: string, content: string) => ({
  id: 'msg-1',
  session_id: 'sess-1',
  role: 'user',
  content,
  created_at: new Date().toISOString(),
}))

const realDal = await import('../src/db/dal')
const dalStub = () => ({
  ...realDal,
  getUserLicenseFields,
  getSession,
  listSessions,
  insertMessage,
})
// Register under all specifier shapes the cached & fresh client.ts may
// resolve to. Bun's mock.module is process-global + first-write-wins per
// exact specifier — `send-fence-scheduled-run.test.ts` already claimed
// `'../src/db/dal'`, so we additionally claim `.ts` and the bun-cli-style
// absolute keys to outrank it.
mock.module('../src/db/dal', dalStub)
mock.module('../src/db/dal.ts', dalStub)

mock.module('../src/auth/jwt.ts', () => ({
  verifyJwt: (_t: string) => ({ sub: 'user-1', email: 'a@b.com', role: 'admin' }),
  signJwt: () => 'fake-jwt',
}))

const realSession = await import('../src/session')
mock.module('../src/session.ts', () => ({
  ...realSession,
  verifyAuthSessionToken: async (_t: string) => null,
  verifyAuthSessionCookie: async (_c: any) => null,
}))

mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => ({ allowed: true }),
}))

mock.module('../src/usage/store', () => ({
  getUsage: () => null,
}))

// Import AFTER mocks installed.
const { createClientWsData, handleClientMessage } = await import('../src/ws/client')

// --- Fake WS ------------------------------------------------------------

function fakeWs() {
  const sent: any[] = []
  const data = createClientWsData()
  const ws: any = {
    data,
    send: (s: string) => { sent.push(JSON.parse(s)); return s.length },
    close: (_code?: number, _reason?: string) => {},
    readyState: 1,
  }
  return { ws, sent, data }
}

async function authenticate(ws: any) {
  await handleClientMessage(ws, JSON.stringify({ type: 'auth', token: 'fake-jwt' }))
}


// --- Tests --------------------------------------------------------------

beforeEach(() => {
  licenseStatus = 'active'
  setLicenseStatus('active')
  dalCalls = 0
  getUserLicenseFields.mockClear()
  getSession.mockClear()
})

describe('Bundle 4: WS client license gate', () => {
  test('active user — send_message succeeds (no refusal emitted)', async () => {
    const { ws, sent } = fakeWs()
    licenseStatus = 'active'
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'send_message', id: '11111111-1111-4111-8111-111111111111', session_id: 'sess-1', content: 'hi',
    }))
    const refused = sent.find(m => m.type === 'send_refused' && m.reason === 'license_inactive')
    expect(refused).toBeUndefined()
  })

  test('expired user — send_message refused with license_inactive', async () => {
    const { ws, sent } = fakeWs()
    licenseStatus = 'expired'
    setLicenseStatus('expired')
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'send_message', id: '11111111-1111-4111-8111-111111111111', session_id: 'sess-1', content: 'hi',
    }))
    const refused = sent.find(m => m.type === 'send_refused')
    expect(refused).toBeDefined()
    expect(refused.reason).toBe('license_inactive')
  })

  test('expired user — subscribe still succeeds (read-only)', async () => {
    const { ws, sent } = fakeWs()
    licenseStatus = 'expired'
    setLicenseStatus('expired')
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'subscribe', session_ids: ['sess-1'],
    }))
    const refused = sent.find(m => m.type === 'send_refused')
    expect(refused).toBeUndefined()
    // subscribe with one owned id should not produce subscribe_error either
    const subErr = sent.find(m => m.type === 'subscribe_error')
    expect(subErr).toBeUndefined()
  })

  test('banned user — permission_response refused', async () => {
    const { ws, sent } = fakeWs()
    licenseStatus = 'banned'
    setLicenseStatus('banned')
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'permission_response', session_id: 'sess-1', request_id: 'r1', approved: true,
    }))
    const refused = sent.find(m => m.type === 'send_refused')
    expect(refused).toBeDefined()
    expect(refused.reason).toBe('license_inactive')
  })

  test('banned user — question_response refused', async () => {
    const { ws, sent } = fakeWs()
    licenseStatus = 'banned'
    setLicenseStatus('banned')
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'question_response', session_id: 'sess-1', request_id: 'r1', answer: 'x',
    }))
    const refused = sent.find(m => m.type === 'send_refused')
    expect(refused).toBeDefined()
    expect(refused.reason).toBe('license_inactive')
  })

  test('renewed mid-session — opportunistic refresh picks up active after TTL', async () => {
    const { ws, sent, data } = fakeWs()
    // Connect while expired → refused.
    licenseStatus = 'expired'
    setLicenseStatus('expired')
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'send_message', id: '11111111-1111-4111-8111-111111111111', session_id: 'sess-1', content: 'first',
    }))
    expect(sent.find(m => m.type === 'send_refused' && m.reason === 'license_inactive')).toBeDefined()

    // Renew externally + force-expire the cache so the next mutation re-queries
    // the DAL. (Manually rewinding `licenseCheckedAt` is more deterministic
    // than sleeping past the TTL — the TTL is config-driven and config is
    // captured at module load.)
    licenseStatus = 'active'
    setLicenseStatus('active')
    data.licenseCheckedAt = 0

    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'send_message', id: '22222222-2222-4222-8222-222222222222', session_id: 'sess-1', content: 'second',
    }))
    expect(sent.find(m => m.type === 'send_refused' && m.reason === 'license_inactive')).toBeUndefined()
  })
})

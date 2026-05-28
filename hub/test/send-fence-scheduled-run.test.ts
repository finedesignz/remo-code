/**
 * Bundle 5 fallback (TRIAGE-2026-05-28): /ws/client `send_message` must refuse
 * manual sends while a scheduled run is the active turn for the session.
 * Prevents cross-attribution of the manual reply as the scheduled run's
 * completion. Hub-side fence; replaces the bailed runner-side run_id echo.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
process.env.TITANIUM_BYPASS = 'true' // bypass license gate — focus on the fence
process.env.LICENSE_REQUIRED = 'false'
process.env.ALLOW_LEGACY_LOGIN = 'true'

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const getSession = mock(async (_id: string, _userId: string) => ({
  id: 'sess-fence',
  user_id: 'user-1',
}))
const insertMessage = mock(async (_sid: string, _role: string, content: string) => ({
  id: 'msg-1',
  session_id: 'sess-fence',
  role: 'user',
  content,
  created_at: new Date().toISOString(),
}))

const realDal = await import('../src/db/dal')
// Export a mutable holder so ws-client-license-gate.test.ts (which runs
// AFTER this file alphabetically and re-uses the cached ws/client module
// this file loaded) can override `license_status` per-test. Without this
// shared toggle, Bun's process-global mock.module + first-write-wins keeps
// THIS file's hardcoded 'active' wired into ws/client forever, and the
// downstream license-gate tests can't drive expired/banned cases.
;(globalThis as any).__wsClientLicenseStatusForTests = (globalThis as any).__wsClientLicenseStatusForTests ?? 'active'
mock.module('../src/db/dal', () => ({
  ...realDal,
  getSession,
  insertMessage,
  listSessions: async () => [],
  getUserLicenseFields: async () => ({
    license_status: (globalThis as any).__wsClientLicenseStatusForTests ?? 'active',
    license_id: 'lic-1',
    license_checked_at: new Date(),
    titanium_subject: 'subj-1',
  }),
}))

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
mock.module('../src/usage/store', () => ({ getUsage: () => null }))

// Mock the scheduled-run-active probe so we can toggle per-test without
// touching the real pendingTurns Map.
let scheduledRunActive = false
mock.module('../src/scheduler/senders/agent.ts', () => ({
  isScheduledRunActive: (_sid: string) => scheduledRunActive,
}))

const { createClientWsData, handleClientMessage } = await import('../src/ws/client')

function fakeWs() {
  const sent: any[] = []
  const data = createClientWsData()
  const ws: any = {
    data,
    send: (s: string) => { sent.push(JSON.parse(s)); return s.length },
    close: () => {},
    readyState: 1,
  }
  return { ws, sent }
}

async function authenticate(ws: any) {
  await handleClientMessage(ws, JSON.stringify({ type: 'auth', token: 'fake-jwt' }))
}

beforeEach(() => {
  scheduledRunActive = false
  getSession.mockClear()
  insertMessage.mockClear()
})

describe('Bundle 5 fallback: send_message fence while scheduled run active', () => {
  test('no scheduled run in flight — send_message proceeds (persists + acks)', async () => {
    const { ws, sent } = fakeWs()
    scheduledRunActive = false
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'send_message',
      id: '11111111-1111-4111-8111-111111111111',
      session_id: 'sess-fence',
      content: 'hello',
    }))
    // No fence refusal
    expect(sent.find(m => m.type === 'send_refused' && m.reason === 'scheduled_run_active')).toBeUndefined()
    // Ack emitted = handler proceeded past fence
    expect(sent.find(m => m.type === 'send_ack')).toBeDefined()
    expect(insertMessage).toHaveBeenCalled()
  })

  test('scheduled run in flight — send_message refused with scheduled_run_active', async () => {
    const { ws, sent } = fakeWs()
    scheduledRunActive = true
    await authenticate(ws)
    sent.length = 0
    await handleClientMessage(ws, JSON.stringify({
      type: 'send_message',
      id: '22222222-2222-4222-8222-222222222222',
      session_id: 'sess-fence',
      content: 'manual reply',
    }))
    const refused = sent.find(m => m.type === 'send_refused')
    expect(refused).toBeDefined()
    expect(refused.reason).toBe('scheduled_run_active')
    expect(refused.session_id).toBe('sess-fence')
    expect(refused.client_id).toBe('22222222-2222-4222-8222-222222222222')
    // Persistence and ack must NOT happen
    expect(insertMessage).not.toHaveBeenCalled()
    expect(sent.find(m => m.type === 'send_ack')).toBeUndefined()
  })
})

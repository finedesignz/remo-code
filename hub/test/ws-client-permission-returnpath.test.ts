/**
 * fix/permission-grant-returnpath — empirical proof of the hub→supervisor hop.
 *
 * Drives a web-shaped `permission_response` / `question_response` through
 * `handleClientMessage` and asserts the REGISTERED agent channel (the
 * supervisor socket) receives the exact forwarded frame. This is the gate the
 * task flagged: if the message were dropped before client.ts:316, the agent
 * channel would never see it. The test also asserts the audit log fires.
 *
 * Mirrors ws-client-license-gate.test.ts harness (fake WS, mocked DAL/auth).
 */
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test'
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
// License gate OPEN for this test — we exercise the forward path, not the gate.
process.env.TITANIUM_BYPASS = 'true'
process.env.LICENSE_REQUIRED = 'false'
process.env.ALLOW_LEGACY_LOGIN = 'true'

import { describe, test, expect, mock, beforeEach } from 'bun:test'

mock.restore()

const { config } = await import('../src/config') as any
config.titaniumBypass = true
config.licenseRequired = false
config.allowLegacyLogin = true

const getUserLicenseFields = mock(async (_userId: string) => ({
  license_status: 'active',
  license_id: 'lic-1',
  license_checked_at: new Date(),
  titanium_subject: 'subj-1',
}))
const getSession = mock(async (_id: string, _userId: string) => ({ id: 'sess-1', user_id: 'user-1' }))
const listSessions = mock(async (_userId: string) => [])
const insertMessage = mock(async () => ({ id: 'msg-1' }))

const realDal = await import('../src/db/dal')
const dalStub = () => ({ ...realDal, getUserLicenseFields, getSession, listSessions, insertMessage })
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

mock.module('../src/usage/threshold.ts', () => ({ checkUserThreshold: async () => ({ allowed: true }) }))
mock.module('../src/usage/store', () => ({ getUsage: () => null }))

const { createClientWsData, handleClientMessage } = await import('../src/ws/client')
const { registerChannel, unregisterChannel } = await import('../src/ws/registry')
const { _setWriterForTest } = await import('../src/observability/logger')

// Capture structured log lines so we can assert the audit row fires.
let logLines: any[] = []
_setWriterForTest((line: string) => { try { logLines.push(JSON.parse(line)) } catch {} })

function fakeWs() {
  const sent: any[] = []
  const data = createClientWsData()
  const ws: any = {
    data,
    send: (s: string) => { sent.push(JSON.parse(s)); return s.length },
    close: () => {},
    readyState: 1,
  }
  return { ws, sent, data }
}

// Fake supervisor agent-channel socket: captures frames the hub forwards.
function fakeChannelWs() {
  const recv: any[] = []
  const ws: any = { send: (s: string) => { recv.push(JSON.parse(s)); return s.length }, close: () => {} }
  return { ws, recv }
}

async function authenticate(ws: any) {
  await handleClientMessage(ws, JSON.stringify({ type: 'auth', token: 'fake-jwt' }))
}

beforeEach(() => {
  getUserLicenseFields.mockClear()
  getSession.mockClear()
  logLines = []
})

describe('permission/question return-path: web → hub → supervisor channel', () => {
  test('permission_response reaches the agent channel with allow/deny intact', async () => {
    const { ws } = fakeWs()
    await authenticate(ws)
    const { ws: chWs, recv } = fakeChannelWs()
    registerChannel('sess-1', 'user-1', chWs)
    try {
      await handleClientMessage(ws, JSON.stringify({
        type: 'permission_response', session_id: 'sess-1',
        request_id: 'req-abc', approved: true,
      }))
      const fwd = recv.find((m) => m.type === 'permission_response')
      expect(fwd).toBeDefined()
      expect(fwd.session_id).toBe('sess-1')
      expect(fwd.request_id).toBe('req-abc')
      expect(fwd.approved).toBe(true)
      // Audit row fires with source=web.
      const audit = logLines.find((l) => l.msg === 'permission.grant_applied')
      expect(audit).toBeDefined()
      expect(audit.source).toBe('web')
      expect(audit.request_id).toBe('req-abc')
      expect(audit.approved).toBe(true)
    } finally {
      unregisterChannel('sess-1')
    }
  })

  test('question_response reaches the agent channel with answer intact', async () => {
    const { ws } = fakeWs()
    await authenticate(ws)
    const { ws: chWs, recv } = fakeChannelWs()
    registerChannel('sess-1', 'user-1', chWs)
    try {
      await handleClientMessage(ws, JSON.stringify({
        type: 'question_response', session_id: 'sess-1',
        request_id: 'req-q', answer: 'option-2',
      }))
      const fwd = recv.find((m) => m.type === 'question_response')
      expect(fwd).toBeDefined()
      expect(fwd.request_id).toBe('req-q')
      expect(fwd.answer).toBe('option-2')
    } finally {
      unregisterChannel('sess-1')
    }
  })
})

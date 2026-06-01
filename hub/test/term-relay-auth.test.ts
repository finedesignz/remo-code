/**
 * Phase 16 (H2 / R-PTY-29 + T-16-05) — authenticated, per-session-authorized,
 * byte-faithful term relay on /ws/client. Drives the REAL handleClientMessage.
 *
 * Named cases:
 *   - a term.input on an unauthenticated connection is dropped,
 *   - a term.input for a session NOT in this connection's subscribedSessions is
 *     dropped (no forged-session relay),
 *   - CROSS-USER hijack: user A cannot write to user B's PTY even with their own
 *     valid session — canWriteTerminal(userA, sessionB) is false,
 *   - a legitimately-owned + subscribed term.input is forwarded byte-faithfully
 *     (the hub does not parse the payload),
 *   - a term.data (server→client output) injected by a CLIENT is rejected
 *     (direction allowlist, NH-2).
 *
 * mock.module is process-global first-write-wins; we spread the cache-busted real
 * modules and override only what we drive (memory: bun-mock-pollution).
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

const USER_A = 'userA'
const USER_B = 'userB'
const SESSION_A = 'sessA' // owned by userA
const SESSION_B = 'sessB' // owned by userB

const fwd: string[] = []

const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  // Ownership ground-truth: each session belongs to exactly one user.
  canWriteTerminal: async (userId: string, sessionId: string) => {
    if (userId === USER_A) return sessionId === SESSION_A
    if (userId === USER_B) return sessionId === SESSION_B
    return false
  },
  getSession: async (sessionId: string, userId: string) => {
    if (userId === USER_A && sessionId === SESSION_A) return { id: SESSION_A }
    if (userId === USER_B && sessionId === SESSION_B) return { id: SESSION_B }
    return null
  },
  getSessionRunnerType: async () => 'pty-interactive',
  getUserLicenseFields: async () => ({ license_status: 'active' }),
  listSessions: async () => [],
}))

const realRegistry = await import(`../src/ws/registry.ts?real=${Date.now()}`)
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  getChannel: (sessionId: string) => ({
    ws: { send: (raw: string) => { fwd.push(raw) } },
  }),
  broadcastToSubscribers: () => {},
  broadcastErrorEvent: () => {},
  countSubscribers: () => 1,
}))

let handleClientMessage: any

beforeEach(async () => {
  fwd.length = 0
  const mod = await import(`../src/ws/client.ts?rt=${Date.now()}`)
  handleClientMessage = mod.handleClientMessage
})

// Build a fake authenticated /ws/client connection for `userId` subscribed to
// `subscribed` session ids.
function fakeClient(userId: string | null, subscribed: string[], authed = true) {
  const sends: string[] = []
  const ws = {
    data: {
      authenticated: authed,
      userId,
      clientEntry: { subscriptions: new Set(subscribed) },
      authTimer: null,
      msgCount: 0,
      msgWindowStart: Date.now(),
      authMethod: 'session_cookie',
      licenseStatus: 'active',
      licenseCheckedAt: Date.now(),
    },
    send: (raw: string) => { sends.push(raw) },
    close: () => {},
  }
  return { ws, sends }
}

function termInput(sessionId: string) {
  return JSON.stringify({ type: 'term.input', session_id: sessionId, bytes: btoa('ls\n') })
}

describe('Phase 16 — term relay auth + per-session authz (H2)', () => {
  test('term.input on an UNAUTHENTICATED connection is dropped', async () => {
    const { ws } = fakeClient(USER_A, [SESSION_A], false)
    await handleClientMessage(ws as any, termInput(SESSION_A))
    expect(fwd.length).toBe(0)
  })

  test('term.input for a session NOT in subscribedSessions is dropped', async () => {
    const { ws } = fakeClient(USER_A, [/* not subscribed to SESSION_A */])
    await handleClientMessage(ws as any, termInput(SESSION_A))
    expect(fwd.length).toBe(0)
  })

  test('CROSS-USER hijack: user A cannot write to user B PTY (even subscribed)', async () => {
    // Even if A somehow has B's id in its subscription set, canWriteTerminal(A,B)
    // is false → dropped.
    const { ws } = fakeClient(USER_A, [SESSION_B])
    await handleClientMessage(ws as any, termInput(SESSION_B))
    expect(fwd.length).toBe(0)
  })

  test('a legitimately owned + subscribed term.input is forwarded byte-faithfully', async () => {
    const { ws } = fakeClient(USER_A, [SESSION_A])
    const raw = termInput(SESSION_A)
    await handleClientMessage(ws as any, raw)
    expect(fwd.length).toBe(1)
    // Byte-faithful: the forwarded frame carries the SAME base64 payload (hub
    // never parses/re-encodes the bytes).
    const sent = JSON.parse(fwd[0])
    expect(sent.type).toBe('term.input')
    expect(sent.session_id).toBe(SESSION_A)
    expect(sent.bytes).toBe(btoa('ls\n'))
  })

  test('a term.data injected by a CLIENT is rejected (direction allowlist NH-2)', async () => {
    const { ws } = fakeClient(USER_A, [SESSION_A])
    await handleClientMessage(
      ws as any,
      JSON.stringify({ type: 'term.data', session_id: SESSION_A, bytes: btoa('x') }),
    )
    expect(fwd.length).toBe(0)
  })
})

/**
 * PTYCAP Phase 2 (`.planning/phases/PTYCAP-02-pty-preflight-gate/`) — wiring
 * test for `hub/src/ws/client.ts`'s `term.input` relay.
 *
 * Proves (integration level, gate LOGIC is unit-tested in
 * hub/test/pty-preflight.test.ts):
 *   1. A NEW pty-interactive turn (turn-lock free) is preflight-checked with
 *      actor:'human', sessionId + userId taken from the connection (never the
 *      frame) — and a failing check drops the frame + sends `send_refused`
 *      instead of forwarding to the agent channel.
 *   2. A passing check forwards the frame exactly as before this phase.
 *   3. The check runs ONCE per turn, not once per keystroke: a second
 *      term.input while the SAME connection still holds the turn does NOT
 *      re-invoke the preflight check.
 *   4. After the turn completes (turn-lock released), the NEXT turn is
 *      checked again.
 *   5. A non-pty-interactive (stream-json) session is never preflight-checked
 *      at all (unaffected — this relay's checks are pty-interactive-only).
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { _resetTurnLockForTests, holder, release, acquire } from '../src/telegram/turn-lock.ts'
import { _resetTermWritersForTests } from '../src/ws/term-writers.ts'

const USER = 'userP'
const SESSION = 'sessP'

let runnerType = 'pty-interactive'
const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  canWriteTerminal: async (u: string, s: string) => u === USER && s === SESSION,
  getSession: async (s: string, u: string) => (u === USER && s === SESSION ? { id: SESSION } : null),
  getSessionRunnerType: async () => runnerType,
  getSessionHostname: async () => 'hostP',
  getUserLicenseFields: async () => ({ license_status: 'active' }),
  listSessions: async () => [],
}))

const realRegistry = await import(`../src/ws/registry.ts?real=${Date.now()}`)
const fwd: string[] = []
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  getChannel: () => ({ ws: { send: (raw: string) => { fwd.push(raw) } } }),
  broadcastToSubscribers: () => {},
  broadcastErrorEvent: () => {},
  countSubscribers: () => 1,
}))

let preflightResult: { ok: true } | { ok: false; reason: string } = { ok: true }
const preflightCalls: Array<{ userId: string; sessionId: string; actor: string }> = []
mock.module('../src/dispatch/pty-preflight.ts', () => ({
  checkPtyTurnPreflight: async (input: { userId: string; sessionId: string; actor: string }) => {
    preflightCalls.push(input)
    return preflightResult
  },
}))

const { handleClientMessage } = await import(`../src/ws/client.ts?rt=${Date.now()}`)

function humanClient() {
  const sent: any[] = []
  const ws: any = {
    data: {
      authenticated: true,
      userId: USER,
      clientEntry: { subscriptions: new Set([SESSION]) },
      authTimer: null,
      msgCount: 0,
      msgWindowStart: Date.now(),
      authMethod: 'session_cookie',
      licenseStatus: 'active',
      licenseCheckedAt: Date.now(),
      writerId: `client:${Math.random()}`,
    },
    send: (raw: string) => { sent.push(JSON.parse(raw)) },
    close: () => {},
  }
  return { ws, sent }
}

function inputFrame(byte = 'y') {
  return JSON.stringify({ type: 'term.input', session_id: SESSION, bytes: btoa(byte) })
}

beforeEach(() => {
  _resetTurnLockForTests()
  _resetTermWritersForTests()
  fwd.length = 0
  preflightCalls.length = 0
  preflightResult = { ok: true }
  runnerType = 'pty-interactive'
})

describe('PTYCAP Phase 2 — ws/client.ts term.input preflight wiring', () => {
  test('a fresh turn is preflight-checked with the server-inferred human actor', async () => {
    const { ws } = humanClient()
    await handleClientMessage(ws, inputFrame())
    expect(preflightCalls).toEqual([{ userId: USER, sessionId: SESSION, actor: 'human' }])
  })

  test('a passing preflight forwards the frame to the agent channel (unchanged behaviour)', async () => {
    const { ws } = humanClient()
    preflightResult = { ok: true }
    await handleClientMessage(ws, inputFrame())
    expect(fwd.length).toBe(1)
  })

  test('a FAILING preflight drops the frame and sends send_refused with the gate reason', async () => {
    const { ws, sent } = humanClient()
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    await handleClientMessage(ws, inputFrame())
    expect(fwd.length).toBe(0)
    const refused = sent.find((m) => m.type === 'send_refused')
    expect(refused).toBeDefined()
    expect(refused.reason).toBe('over_daily_cost_cap:$12.00>=$10.00')
    // the failed turn must not have been granted the turn lock
    expect(holder(SESSION)).toBeNull()
  })

  test('the check runs ONCE per turn — a second keystroke from the SAME holder does not re-invoke it', async () => {
    const { ws } = humanClient()
    await handleClientMessage(ws, inputFrame('a'))
    expect(preflightCalls.length).toBe(1)
    await handleClientMessage(ws, inputFrame('b'))
    expect(preflightCalls.length).toBe(1) // unchanged — still held by the same writer
    expect(fwd.length).toBe(2) // both keystrokes still forwarded
  })

  test('after the turn completes, the NEXT turn is preflight-checked again', async () => {
    const { ws } = humanClient()
    await handleClientMessage(ws, inputFrame('a'))
    expect(preflightCalls.length).toBe(1)
    release(SESSION) // observed turn_complete
    await handleClientMessage(ws, inputFrame('b'))
    expect(preflightCalls.length).toBe(2)
  })

  test('a non-pty-interactive (stream-json) session is never preflight-checked', async () => {
    runnerType = 'stream-json'
    const { ws } = humanClient()
    await handleClientMessage(ws, inputFrame())
    expect(preflightCalls.length).toBe(0)
    expect(fwd.length).toBe(1) // still forwarded — unaffected by this phase
  })

  // Review-finding fix (AgentAutofix ai-review on PR #493, codex reviewer
  // "blocking"): the original `holder(...) === null` check decided whether to
  // preflight BEFORE calling acquire(), based on the state at the moment this
  // frame was RECEIVED. A frame received while a DIFFERENT writer (e.g.
  // Telegram) already held the turn would see a non-null holder and skip
  // preflight — including at the moment it is later PROMOTED to holder from the
  // turn-lock queue, which is a genuinely fresh turn for this writer that must
  // still be gated. The fix moves the decision to `holder(...) !== writerId`,
  // evaluated synchronously right before `acquire()` (no `await` in between —
  // see the comment in client.ts), and runs the actual preflight check AFTER
  // `acquire()` grants the turn, so it fires whether the grant is immediate or
  // via queue promotion.
  test('a frame queued behind ANOTHER writer is still preflight-checked once promoted to holder', async () => {
    // Seed telegram as the current holder directly via turn-lock (bypassing
    // client.ts — this relay never emits the 'telegram' writer id itself).
    await acquire(SESSION, 'telegram')
    expect(holder(SESSION)).toBe('telegram')

    const { ws } = humanClient()
    // handleClientMessage's internal acquire(SESSION, <client writer>) call
    // queues behind 'telegram' and does not resolve until promoted — do not
    // await the call yet, or this test would hang.
    const pending = handleClientMessage(ws, inputFrame())

    // Let the synchronous prefix of handleClientMessage run (holder-snapshot,
    // claimTermWriter, the queuing acquire() call) before asserting.
    await Promise.resolve()
    expect(preflightCalls.length).toBe(0) // not yet promoted — not checked yet

    release(SESSION) // observed telegram turn_complete — promotes the queued client writer
    await pending

    expect(preflightCalls).toEqual([{ userId: USER, sessionId: SESSION, actor: 'human' }])
    expect(fwd.length).toBe(1)
  })

  test('a promoted-from-queue frame that FAILS preflight releases the turn instead of leaving a phantom holder', async () => {
    await acquire(SESSION, 'telegram')
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }

    const { ws, sent } = humanClient()
    const pending = handleClientMessage(ws, inputFrame())
    await Promise.resolve()

    release(SESSION) // promotes the queued client writer to holder
    await pending

    expect(preflightCalls.length).toBe(1)
    expect(fwd.length).toBe(0)
    const refused = sent.find((m: any) => m.type === 'send_refused')
    expect(refused?.reason).toBe('over_daily_cost_cap:$12.00>=$10.00')
    // The rejected writer must not be left holding the turn — a phantom holder
    // would wedge every other writer until the 60s TTL backstop fires.
    expect(holder(SESSION)).toBeNull()
  })
})

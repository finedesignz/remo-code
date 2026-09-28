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
// A test-controlled gate: when set, checkPtyTurnPreflight suspends on it before
// resolving, so a test can deterministically pause mid-check (to prove what
// happens to a SECOND frame that arrives before the first's DB round trip
// settles) instead of guessing how many microtask ticks to await.
let preflightGate: Promise<void> | null = null
mock.module('../src/dispatch/pty-preflight.ts', () => ({
  checkPtyTurnPreflight: async (input: { userId: string; sessionId: string; actor: string }) => {
    preflightCalls.push(input)
    if (preflightGate) await preflightGate
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

// Several mocked async calls (canWriteTerminal, getSession, isLicenseActive,
// getSessionRunnerType) precede the preflight check inside handleClientMessage,
// each its own microtask tick — poll for the observable effect instead of
// guessing a fixed tick count.
async function waitUntil(cond: () => boolean, maxTicks = 50) {
  for (let i = 0; i < maxTicks && !cond(); i++) await Promise.resolve()
  if (!cond()) throw new Error('waitUntil: condition never became true')
}

beforeEach(() => {
  _resetTurnLockForTests()
  _resetTermWritersForTests()
  fwd.length = 0
  preflightCalls.length = 0
  preflightResult = { ok: true }
  preflightGate = null
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

  // Review-finding fix #1 (AgentAutofix ai-review on PR #493, codex reviewer
  // "blocking"): the original `holder(...) === null` check decided whether to
  // preflight based on the state at the moment this frame was RECEIVED. A
  // frame received while a DIFFERENT writer (e.g. Telegram) already held the
  // turn would see a non-null holder and skip preflight forever — including at
  // the moment it is later promoted to holder from the turn-lock queue, which
  // is a genuinely fresh turn for that writer that must still be gated.
  test('a frame received while ANOTHER writer holds the turn is still preflight-checked (not just when holder is null)', async () => {
    // Seed telegram as the current holder directly via turn-lock (bypassing
    // client.ts — this relay never emits the 'telegram' writer id itself).
    await acquire(SESSION, 'telegram')
    expect(holder(SESSION)).toBe('telegram')

    const { ws } = humanClient()
    // The preflight check itself runs AFTER acquire() grants (see client.ts),
    // so handleClientMessage suspends first, queued behind telegram's held
    // lock, and only checks once promoted.
    const pending = handleClientMessage(ws, inputFrame())
    release(SESSION) // observed telegram turn_complete — promotes the queued client writer
    await pending

    expect(preflightCalls).toEqual([{ userId: USER, sessionId: SESSION, actor: 'human' }])
    expect(fwd.length).toBe(1)
  })

  test('a frame promoted from the queue that FAILS preflight releases the turn it just took', async () => {
    await acquire(SESSION, 'telegram')
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }

    const { ws, sent } = humanClient()
    const pending = handleClientMessage(ws, inputFrame())
    release(SESSION) // promotes the queued client writer to holder
    await pending

    expect(preflightCalls.length).toBe(1)
    expect(fwd.length).toBe(0)
    const refused = sent.find((m: any) => m.type === 'send_refused')
    expect(refused?.reason).toBe('over_daily_cost_cap:$12.00>=$10.00')
    // The check now runs AFTER acquire() grants the turn (see client.ts for
    // why), so a rejection must give the turn back — telegram already left to
    // promote us, so the session ends up fully free, not phantom-held.
    expect(holder(SESSION)).toBeNull()
  })

  // Review-finding fix #3 (round 3 — codex "blocking", claude concurred with a
  // non-blocking "warning"): fix #2 checked ONCE, at the moment a fresh-turn
  // frame was RECEIVED, using whatever spend totals looked like then. A turn
  // that had to wait in the queue behind another writer could still be
  // admitted on that now-STALE passing verdict even if the writer ahead of it
  // pushed spend over a cap during the wait. Fixed by moving the check to run
  // only once a turn is actually granted (see the round-3 comment in
  // client.ts) — a queued frame is never checked at all until promotion, so
  // there is no stale snapshot to go stale.
  test('a queued turn is checked with FRESH state at the moment of promotion, not a stale snapshot from receipt time', async () => {
    await acquire(SESSION, 'telegram')
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' } // would fail if checked now

    const { ws } = humanClient()
    const pending = handleClientMessage(ws, inputFrame())

    // Still queued behind telegram — nothing has been checked yet, because
    // this design never reads spend until the turn is actually granted.
    expect(preflightCalls.length).toBe(0)

    // Spend recovers before this turn is promoted (e.g. the daily window
    // rolled over, or telegram's own turn came in under the cap after all).
    preflightResult = { ok: true }
    release(SESSION) // promote the queued client writer
    await pending

    expect(preflightCalls.length).toBe(1)
    expect(fwd.length).toBe(1) // admitted on the FRESH verdict, not the stale one from receipt time
  })

  // Review-finding fix #2 (same PR, same reviewers, found on the FIRST fix's
  // own commit — "blocking" from codex AND the advisory agy reviewer): moving
  // the check to run AFTER acquire() (fix #1's implementation) opened a worse
  // window — once the first frame of a fresh turn had acquired the lock, a
  // SECOND frame from the SAME writer arriving while the first's preflight was
  // still in flight would see `holder === writerId` (already granted), skip
  // preflight, and forward immediately — reaching PTY stdin even if the first
  // frame's preflight went on to reject. Fixed by publishing the in-flight
  // check as a promise shared by every frame for that session (see
  // `pendingPtyPreflight` in client.ts) and running it BEFORE acquire(), so
  // the lock is never mutated until the shared verdict is known.
  test('a second frame arriving while the first preflight is still resolving shares its verdict instead of skipping the check', async () => {
    let unblock!: () => void
    preflightGate = new Promise<void>((r) => { unblock = r })
    preflightResult = { ok: true }

    const { ws } = humanClient() // SAME connection/writerId for both frames
    const first = handleClientMessage(ws, inputFrame('a'))
    // Let the first frame reach and register the in-flight preflight call
    // before the second one arrives. The check runs AFTER acquire() grants
    // (round 3's design), so the lock IS already held by the time it starts.
    await waitUntil(() => preflightCalls.length === 1)
    expect(holder(SESSION)).toBe(ws.data.writerId)

    const second = handleClientMessage(ws, inputFrame('b'))
    unblock() // let the shared preflight settle
    await Promise.all([first, second])

    // Exactly ONE DB round trip for both frames of this fresh turn (the
    // original once-per-turn intent), and both were admitted since it passed.
    expect(preflightCalls.length).toBe(1)
    expect(fwd.length).toBe(2)
  })

  test('a second frame arriving while the first preflight is still resolving is ALSO refused if it ultimately rejects', async () => {
    let unblock!: () => void
    preflightGate = new Promise<void>((r) => { unblock = r })
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }

    const { ws, sent } = humanClient()
    const first = handleClientMessage(ws, inputFrame('a'))
    await waitUntil(() => preflightCalls.length === 1)

    const second = handleClientMessage(ws, inputFrame('b'))
    unblock()
    await Promise.all([first, second])

    // Neither frame reached the channel — the second did not sneak through
    // ahead of the shared rejection, and the lock was never acquired by either.
    expect(fwd.length).toBe(0)
    expect(holder(SESSION)).toBeNull()
    expect(sent.filter((m: any) => m.type === 'send_refused').length).toBe(2)
  })

  test('a thrown/rejected preflight check fails CLOSED and never leaves a phantom holder', async () => {
    let reject!: (err: unknown) => void
    preflightGate = new Promise<void>((_, r) => { reject = r })

    const { ws, sent } = humanClient()
    const pending = handleClientMessage(ws, inputFrame())
    await waitUntil(() => preflightCalls.length === 1)
    reject(new Error('db unreachable'))
    await pending

    expect(fwd.length).toBe(0)
    // Acquired (the check runs after acquire()), then released on failure —
    // no phantom holder left wedging the next writer.
    expect(holder(SESSION)).toBeNull()
    const refused = sent.find((m: any) => m.type === 'send_refused')
    expect(refused?.reason).toBe('pty_preflight_error')
  })

  // Review-finding fix #4 (round 4, codex "blocking"): the pre-existing
  // current-writer re-check after `acquire()` (see client.ts, "ENFORCE the
  // invariant, don't just record it") only covers the wait INSIDE acquire()
  // itself. Round 3 added a SECOND `await` after that check (the preflight
  // round trip) without a matching re-check — a connection that gets
  // superseded by a new client connection (e.g. the user opens a new tab)
  // while its own preflight is still resolving would still forward its now-
  // stale bytes once that preflight settled, violating the single-writer
  // invariant the acquire-side check exists to enforce.
  test('a socket superseded by a new connection while its own preflight is still resolving does not forward stale bytes', async () => {
    let unblock!: () => void
    preflightGate = new Promise<void>((r) => { unblock = r })
    preflightResult = { ok: true }

    const a = humanClient()
    const pendingA = handleClientMessage(a.ws, inputFrame('a'))
    await waitUntil(() => preflightCalls.length === 1)
    expect(holder(SESSION)).toBe(a.ws.data.writerId)

    // A different connection takes over (e.g. a new tab) while A's own
    // preflight round trip is still in flight. B reuses A's still-pending
    // shared promise (same session), so this call also suspends until unblock().
    const b = humanClient()
    const pendingB = handleClientMessage(b.ws, inputFrame('b'))
    await waitUntil(() => holder(SESSION) === b.ws.data.writerId)

    unblock() // let both A's and B's (shared) preflight settle together
    await Promise.all([pendingA, pendingB])

    // A's stale frame must NOT have reached the channel — only B's should.
    expect(fwd.length).toBe(1)
  })
})

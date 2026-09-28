/**
 * PTYCAP Phase 2 (`.planning/phases/PTYCAP-02-pty-preflight-gate/`) — wiring
 * test for `hub/src/ws/client.ts`'s `term.input` relay. Gate LOGIC is
 * unit-tested in hub/test/pty-preflight.test.ts.
 *
 * Design under test: the spend preflight runs on every PROMPT SUBMIT (a
 * term.input containing CR/LF), regardless of `sessions.runner_type`, with a
 * fresh check per submit and no shared verdicts. Plain typing, Ctrl-C, Esc and
 * attachments always pass. Frames from one writer are serialized so a
 * keystroke never overtakes a submit that is still being checked, and the
 * single-writer + turn-lock invariants are re-verified immediately before the
 * write.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test:test@localhost:5432/test'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'

import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { _resetTurnLockForTests, holder, release, acquire, queueDepth } from '../src/telegram/turn-lock.ts'
import { _resetTermWritersForTests } from '../src/ws/term-writers.ts'

const USER = 'userP'
const SESSION = 'sessP'

let runnerType = 'pty-interactive'
let canWriteHook: (() => Promise<void>) | null = null
const realDal = await import(`../src/db/dal.ts?real=${Date.now()}`)
mock.module('../src/db/dal.ts', () => ({
  ...realDal,
  canWriteTerminal: async (u: string, s: string) => { if (canWriteHook) await canWriteHook(); return u === USER && s === SESSION },
  getSession: async (s: string, u: string) => (u === USER && s === SESSION ? { id: SESSION } : null),
  getSessionRunnerType: async () => runnerType,
  getSessionHostname: async () => 'hostP',
  getUserLicenseFields: async () => ({ license_status: 'active' }),
  listSessions: async () => [],
}))

const realRegistry = await import(`../src/ws/registry.ts?real=${Date.now()}`)
const fwd: any[] = []
const defaultChannel = { ws: { send: (raw: string) => { fwd.push(JSON.parse(raw)) } } }
let channelOverride: any = null
mock.module('../src/ws/registry.ts', () => ({
  ...realRegistry,
  getChannel: () => channelOverride ?? defaultChannel,
  broadcastToSubscribers: () => {},
  broadcastErrorEvent: () => {},
  countSubscribers: () => 1,
}))

// The real preflight module, with only `checkPtyTurnPreflight` replaced by a
// controllable stub (the real `isPtySubmit` is kept, so submit detection is
// exercised for real). `preflightGate`, when set, suspends the check until the
// test resolves it — a deterministic way to pause mid-check.
const realPreflight = await import(`../src/dispatch/pty-preflight.ts?real=${Date.now()}`)
let preflightResult: { ok: true } | { ok: false; reason: string } = { ok: true }
let preflightGate: Promise<void> | null = null
const preflightCalls: Array<{ userId: string; sessionId: string; actor: string }> = []
mock.module('../src/dispatch/pty-preflight.ts', () => ({
  ...realPreflight,
  checkPtyTurnPreflight: async (input: { userId: string; sessionId: string; actor: string }) => {
    preflightCalls.push(input)
    if (preflightGate) await preflightGate
    return preflightResult
  },
}))

const { handleClientMessage, _resetPtyRelayStateForTests } = await import(`../src/ws/client.ts?rt=${Date.now()}`)

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

const input = (s: string) => JSON.stringify({ type: 'term.input', session_id: SESSION, bytes: btoa(s) })
const ENTER = '\r'
const fwdText = () => fwd.filter((f) => f.type === 'term.input').map((f) => atob(f.bytes))
const refusals = (sent: any[]) => sent.filter((m) => m.type === 'send_refused')

async function waitUntil(cond: () => boolean, maxTicks = 200) {
  for (let i = 0; i < maxTicks && !cond(); i++) await Promise.resolve()
  if (!cond()) throw new Error('waitUntil: condition never became true')
}

function pauseChecks() {
  let unblock!: () => void
  preflightGate = new Promise<void>((r) => { unblock = r })
  return () => unblock()
}

beforeEach(() => {
  _resetTurnLockForTests()
  _resetTermWritersForTests()
  _resetPtyRelayStateForTests()
  fwd.length = 0
  preflightCalls.length = 0
  preflightResult = { ok: true }
  preflightGate = null
  runnerType = 'pty-interactive'
  channelOverride = null
  canWriteHook = null
})

describe('PTYCAP Phase 2 — what gets checked', () => {
  test('a prompt submit is checked with the SERVER-INFERRED human actor and the connection\'s own user/session', async () => {
    const { ws } = humanClient()
    await handleClientMessage(ws, input(ENTER))
    expect(preflightCalls).toEqual([{ userId: USER, sessionId: SESSION, actor: 'human' }])
    expect(fwdText()).toEqual([ENTER])
  })

  test('plain typing, Ctrl-C and Esc are never checked', async () => {
    const { ws } = humanClient()
    for (const k of ['h', 'i', '\x03', '\x1b', '\x1b[A']) await handleClientMessage(ws, input(k))
    expect(preflightCalls.length).toBe(0)
    expect(fwdText()).toEqual(['h', 'i', '\x03', '\x1b', '\x1b[A'])
  })

  test('term.attach_file is never checked (it types a path, it does not submit)', async () => {
    const { ws } = humanClient()
    await handleClientMessage(ws, JSON.stringify({ type: 'term.attach_file', session_id: SESSION, filename: 'a.txt', data_b64: btoa('x') }))
    expect(preflightCalls.length).toBe(0)
    expect(fwd.length).toBe(1)
  })

  // Panel finding (security, blocking): the gate used to run only when
  // sessions.runner_type === 'pty-interactive'. That column defaults to
  // 'stream-json' and the web client never sets it, while the supervisor writes
  // every term.input to the PTY on its own env flag — so in prod the gate never
  // ran. It must not depend on that column.
  test('a submit on a session whose runner_type is the default \'stream-json\' is STILL checked', async () => {
    runnerType = 'stream-json'
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    const { ws } = humanClient()
    await handleClientMessage(ws, input(ENTER))
    expect(preflightCalls.length).toBe(1)
    expect(fwd.length).toBe(0)
  })

  // Panel finding (security): with a per-turn check, a keystroke every <60s kept
  // the turn lock (and its one passing check) alive all day. Every submit now
  // pays its own fresh check.
  test('EVERY submit is checked, even while the same writer still holds the turn', async () => {
    const { ws } = humanClient()
    await handleClientMessage(ws, input('first' + ENTER))
    await handleClientMessage(ws, input('x'))
    await handleClientMessage(ws, input('second' + ENTER))
    expect(holder(SESSION)).toBe(ws.data.writerId)
    expect(preflightCalls.length).toBe(2)
  })
})

describe('PTYCAP Phase 2 — refusal', () => {
  test('a refused submit is dropped and the client gets send_refused on the term channel', async () => {
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    const { ws, sent } = humanClient()
    await handleClientMessage(ws, input('go' + ENTER))
    expect(fwd.length).toBe(0)
    expect(refusals(sent)).toEqual([
      { type: 'send_refused', channel: 'term', session_id: SESSION, reason: 'over_daily_cost_cap:$12.00>=$10.00' },
    ])
  })

  // Panel finding (correctness, blocking): Ctrl-C / Esc used to be refused
  // mid-turn once over the cap, so the cap stopped the user from interrupting
  // the very spend it was meant to limit.
  test('over the cap, the user can still interrupt and cancel (Ctrl-C, Esc pass; only Enter is refused)', async () => {
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    const { ws, sent } = humanClient()
    await handleClientMessage(ws, input('\x03'))
    await handleClientMessage(ws, input('\x1b'))
    await handleClientMessage(ws, input(ENTER))
    expect(fwdText()).toEqual(['\x03', '\x1b'])
    expect(refusals(sent).length).toBe(1)
  })
})

describe('PTYCAP Phase 2 — Enter encodings without CR/LF (security panel)', () => {
  test('a kitty/CSI-u Enter (ESC[13u) is checked and, over the cap, refused', async () => {
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    const { ws, sent } = humanClient()
    await handleClientMessage(ws, input('\x1b[13u'))
    expect(preflightCalls.length).toBe(1)
    expect(fwd.length).toBe(0)
    expect(refusals(sent).length).toBe(1)
  })

  test('ESC[13u split across two frames (ESC | [13u) is still checked at the second frame', async () => {
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    const { ws } = humanClient()
    await handleClientMessage(ws, input('\x1b')) // a lone Esc passes (cancel must work)
    await handleClientMessage(ws, input('[13u'))
    expect(fwdText()).toEqual(['\x1b'])
    expect(preflightCalls.length).toBe(1)
  })

  test('the lone-Esc tail is per SESSION: a second connection cannot complete the sequence unchecked', async () => {
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    const a = humanClient()
    const b = humanClient()
    await handleClientMessage(a.ws, input('\x1b'))
    await handleClientMessage(b.ws, input('[13u'))
    expect(fwdText()).toEqual(['\x1b'])
    expect(preflightCalls.length).toBe(1)
  })

  // ai-review (codex, blocking) on 8c0ca80: `ESC[` checked and forwarded while
  // under the cap, then `13u` arriving after the cap is crossed, was plain text.
  test('an open CSI prefix forwarded under the cap cannot be completed unchecked after it is crossed', async () => {
    const { ws, sent } = humanClient()
    await handleClientMessage(ws, input('\x1b['))
    expect(fwdText()).toEqual(['\x1b['])
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    await handleClientMessage(ws, input('13u'))
    expect(fwdText()).toEqual(['\x1b['])
    expect(preflightCalls.length).toBe(2)
    expect(refusals(sent).length).toBe(1)
  })

  test('after a forwarded non-Esc frame the tail is cleared (plain text is not re-checked)', async () => {
    const { ws } = humanClient()
    await handleClientMessage(ws, input('\x1b'))
    await handleClientMessage(ws, input('\x1b[A'))
    await handleClientMessage(ws, input('[13u'))
    expect(preflightCalls.length).toBe(0)
    expect(fwdText()).toEqual(['\x1b', '\x1b[A', '[13u'])
  })
})

// Panels (security + correctness): ordering used to hold only from the chain
// point on — each frame paid several DB round-trips BEFORE taking its slot, so
// two frames could enter the chain in DB-completion order.
describe('PTYCAP Phase 2 — arrival order is kept even when DB checks finish out of order', () => {
  test('a submit whose ownership check is slow is not overtaken by the next keystroke', async () => {
    let releaseSlow!: () => void
    const slow = new Promise<void>((r) => { releaseSlow = r })
    let calls = 0
    canWriteHook = async () => { if (++calls === 1) await slow }
    const { ws } = humanClient()
    const a = handleClientMessage(ws, input('go' + ENTER))
    const b = handleClientMessage(ws, input('n'))
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(fwd.length).toBe(0)
    releaseSlow()
    await Promise.all([a, b])
    expect(fwdText()).toEqual(['go' + ENTER, 'n'])
  })
})

describe('PTYCAP Phase 2 — ordering and invariants across the check await', () => {
  test('a keystroke typed while a submit is still being checked waits behind it (order kept on pass)', async () => {
    const unblock = pauseChecks()
    const { ws } = humanClient()
    const a = handleClientMessage(ws, input('go' + ENTER))
    await waitUntil(() => preflightCalls.length === 1)
    const b = handleClientMessage(ws, input('n'))
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(fwd.length).toBe(0) // 'n' must not overtake the pending submit
    unblock()
    await Promise.all([a, b])
    expect(fwdText()).toEqual(['go' + ENTER, 'n'])
  })

  test('if the pending submit is refused, a later plain keystroke still lands — after it, never ahead', async () => {
    const unblock = pauseChecks()
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' }
    const { ws } = humanClient()
    const a = handleClientMessage(ws, input('go' + ENTER))
    await waitUntil(() => preflightCalls.length === 1)
    const b = handleClientMessage(ws, input('n'))
    for (let i = 0; i < 50; i++) await Promise.resolve()
    expect(fwd.length).toBe(0)
    unblock()
    await Promise.all([a, b])
    expect(fwdText()).toEqual(['n'])
  })

  test('two submits in flight from one writer each get their OWN check (no shared verdict)', async () => {
    const unblock = pauseChecks()
    const { ws } = humanClient()
    const a = handleClientMessage(ws, input('one' + ENTER))
    const b = handleClientMessage(ws, input('two' + ENTER))
    await waitUntil(() => preflightCalls.length === 1)
    unblock()
    await Promise.all([a, b])
    expect(preflightCalls.length).toBe(2)
    expect(fwdText()).toEqual(['one' + ENTER, 'two' + ENTER])
  })

  test('a socket superseded by a new connection while its submit is being checked does not forward', async () => {
    const unblock = pauseChecks()
    const a = humanClient()
    const pendingA = handleClientMessage(a.ws, input('stale' + ENTER))
    await waitUntil(() => preflightCalls.length === 1)
    preflightGate = null
    const b = humanClient()
    await handleClientMessage(b.ws, input('fresh' + ENTER))
    unblock()
    await pendingA
    expect(fwdText()).toEqual(['fresh' + ENTER])
    expect(preflightCalls.length).toBe(2) // B paid its own check
    expect(refusals(a.sent).map((r) => r.reason)).toEqual(['not_current_writer'])
  })

  // Panel finding (concurrency): the turn lock can be released mid-check
  // (TTL expiry, turn_complete). If it is FREE and we are still the current
  // writer, re-take it rather than silently eating the user's Enter.
  test('a submit whose turn lock goes FREE while its check is pending re-takes the lock and forwards', async () => {
    const unblock = pauseChecks()
    const { ws } = humanClient()
    const p = handleClientMessage(ws, input('go' + ENTER))
    await waitUntil(() => preflightCalls.length === 1)
    release(SESSION)
    expect(holder(SESSION)).toBe(null)
    unblock()
    await p
    expect(fwdText()).toEqual(['go' + ENTER])
    expect(holder(SESSION)).toBe(ws.data.writerId)
  })

  // ...but a lock handed to ANOTHER writer mid-check is never taken over.
  test('a submit whose lock passes to another writer mid-check is dropped with a visible refusal', async () => {
    const unblock = pauseChecks()
    const { ws, sent } = humanClient()
    const p = handleClientMessage(ws, input('go' + ENTER))
    await waitUntil(() => preflightCalls.length === 1)
    release(SESSION)
    await acquire(SESSION, 'telegram')
    unblock()
    await p
    expect(fwd.length).toBe(0)
    expect(holder(SESSION)).toBe('telegram')
    expect(refusals(sent)).toEqual([
      { type: 'send_refused', channel: 'term', session_id: SESSION, reason: 'not_current_writer' },
    ])
  })

  // Panel finding (concurrency): the channel was captured before the awaits, so
  // a supervisor reconnect mid-check sent the frame to the closed old socket.
  test('the agent channel is resolved at send time, not before the check', async () => {
    const unblock = pauseChecks()
    const { ws } = humanClient()
    const p = handleClientMessage(ws, input('go' + ENTER))
    await waitUntil(() => preflightCalls.length === 1)
    const newSock: any[] = []
    channelOverride = { ws: { send: (raw: string) => { newSock.push(JSON.parse(raw)) } } }
    unblock()
    await p
    expect(fwd.length).toBe(0)
    expect(newSock.map((f) => atob(f.bytes))).toEqual(['go' + ENTER])
  })

  // Panel finding (correctness): the old version of this test released the
  // other writer before the frame ever reached acquire(), so it never queued
  // and passed against the buggy code. Wait for the waiter to actually queue.
  test('a submit queued behind another writer is checked with state FRESH at promotion', async () => {
    await acquire(SESSION, 'telegram')
    preflightResult = { ok: false, reason: 'over_daily_cost_cap:$12.00>=$10.00' } // would fail if checked now
    const { ws } = humanClient()
    const p = handleClientMessage(ws, input('go' + ENTER))
    await waitUntil(() => queueDepth(SESSION) === 1)
    expect(preflightCalls.length).toBe(0) // not checked while queued
    preflightResult = { ok: true } // spend recovers before promotion
    release(SESSION)
    await p
    expect(preflightCalls.length).toBe(1)
    expect(fwdText()).toEqual(['go' + ENTER])
  })
})

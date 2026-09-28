/**
 * PTYCAP Phase 2 (`.planning/phases/PTYCAP-02-pty-preflight-gate/`) — the PTY
 * pre-flight gate chain (`hub/src/dispatch/pty-preflight.ts`).
 *
 * SC-1: a programmatic ("automation") PTY turn passes
 *   [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]
 *   or it does not happen.
 * SC-2: covered by `hub/test/token-cap-coverage.test.ts`'s extended
 *   "known dispatchers" list + its generic `gates: [ ... ]` scan (this file's
 *   `ptyPreflightDispatchConfig` literal is discovered by that scan).
 * SC-3: a human turn is NEVER gated by the inject-rate ceiling.
 *
 * Strategy mirrors `hub/test/cost-cap-real-tokens.test.ts`: mock the leaf DAL/
 * usage modules `gates.ts` calls into, then exercise the REAL gate objects
 * through the REAL `checkPtyTurnPreflight`. `bun run check-baseline` runs each
 * hub/test file in its own process (see tools/regression-baseline.json), so
 * these `mock.module` registrations cannot collide with another test file's.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, mock, beforeEach } from 'bun:test'

const state = {
  thresholdAllowed: true,
  cap: '10.00' as string | null,
  tz: 'UTC',
  costSpent: 0,
  tokenTotal: 0,
  injectsInWindow: 0,
  haltBound: null as string | null,
  creditUsed: 0,
  thresholdMode: 'normal' as 'normal' | 'throw' | 'hang',
}

mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => {
    if (state.thresholdMode === 'throw') throw new Error('db down')
    if (state.thresholdMode === 'hang') return new Promise(() => {})
    return state.thresholdAllowed
      ? { allowed: true }
      : {
          allowed: false,
          reason: 'session_threshold',
          utilization_pct: 99,
          threshold_pct: 80,
        }
  },
}))

mock.module('../src/usage/store.ts', () => ({
  getUsage: () => ({ usage: { programmatic_credit: { claimed: true, used_usd: state.creditUsed } } }),
}))

// gates.ts resolves tz + the dollar cap + the programmatic-halt bound via `sql`.
// One generic row satisfies all three call sites (bound is always null here —
// the opt-in programmatic-credit hard-halt stays OFF for these tests).
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [{ cap: state.cap, tz: state.tz, bound: state.haltBound }],
}))

mock.module('../src/db/token-usage-dal.ts', () => ({
  getTodayTokenCostUsd: async () => state.costSpent,
  getTodayTokenTotal: async () => state.tokenTotal,
}))

mock.module('../src/db/orchestrator-rows-dal.ts', () => ({
  countSessionInjectsSince: async () => state.injectsInWindow,
}))

const modUrl = `../src/dispatch/pty-preflight.ts?t=${Date.now()}${Math.random()}`
const {
  checkPtyTurnPreflight,
  PTY_AUTOMATION_TURN_GATES,
  PTY_HUMAN_TURN_GATES,
  ptyPreflightDispatchConfig,
  isPtySubmit,
  classifyPtyInput,
  _setPtyPreflightTimeoutForTests,
  _resetPtyPreflightTimeoutForTests,
} = await import(modUrl)
const { sessionInjectRateGate } = await import('../src/dispatch/gates.ts')

beforeEach(() => {
  state.thresholdAllowed = true
  state.cap = '10.00'
  state.tz = 'UTC'
  state.costSpent = 0
  state.tokenTotal = 0
  state.injectsInWindow = 0
  state.haltBound = null
  state.creditUsed = 0
  state.thresholdMode = 'normal'
  _resetPtyPreflightTimeoutForTests()
})

describe('PTYCAP Phase 2 — chain shape', () => {
  test('SC-1: automation chain is EXACTLY the ROADMAP order: threshold -> token cap -> cost cap -> inject-rate', () => {
    expect(PTY_AUTOMATION_TURN_GATES.map((g: { name: string }) => g.name)).toEqual([
      'threshold',
      'daily_token_cap',
      'daily_cost_cap',
      'session_inject_rate',
    ])
  })

  test('SC-3: the human chain never contains sessionInjectRateGate', () => {
    expect(PTY_HUMAN_TURN_GATES).not.toContain(sessionInjectRateGate)
    expect(PTY_HUMAN_TURN_GATES.map((g: { name: string }) => g.name)).toEqual([
      'threshold',
      'daily_token_cap',
      'daily_cost_cap',
    ])
  })

  test('SC-2: the scanned literal `gates: [...]` IS the array that runs — not a decorative copy', () => {
    const names = ptyPreflightDispatchConfig.gates.map((g: { name: string }) => g.name)
    expect(names).toContain('daily_token_cap')
    expect(names).toContain('daily_cost_cap')
    // Same object identity: editing the scanned literal edits the real chain.
    expect(PTY_AUTOMATION_TURN_GATES).toBe(ptyPreflightDispatchConfig.gates)
  })

  test('the human chain is the automation chain minus the inject-rate gate (cannot drift apart)', () => {
    expect(PTY_HUMAN_TURN_GATES).toEqual(PTY_AUTOMATION_TURN_GATES.filter((g: unknown) => g !== sessionInjectRateGate))
  })
})

describe('PTYCAP Phase 2 — human turns (SC-3)', () => {
  test('a human turn under every ceiling passes', async () => {
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(true)
  })

  test('a human turn over the daily COST cap is blocked', async () => {
    state.costSpent = 999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_cost_cap')
  })

  test('a human turn over the daily TOKEN cap is blocked', async () => {
    state.tokenTotal = 999_999_999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_token_cap')
  })

  test('a human turn over the CLAUDE USAGE THRESHOLD is blocked', async () => {
    state.thresholdAllowed = false
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('quota_threshold_reached')
  })

  test('SC-3 (the absolute): a human turn is NEVER blocked by the inject-rate ceiling, even when it would trip it', async () => {
    state.injectsInWindow = 999_999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(true)
  })
})

describe('PTYCAP Phase 2 — non-human ("automation") turns (SC-1)', () => {
  // No admission path exists yet that lets a non-human actor reach this
  // function in production (humanOnlyPtyGate / humanOnlyRejectsActor reject
  // every automation source upstream) — these prove the chain ITSELF is
  // correct so Phase 3 has a tested seam to wire into.
  test('a non-human actor under every ceiling passes the FULL chain', async () => {
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(true)
  })

  test('SC-1: a non-human actor over the inject-rate ceiling IS blocked (unlike a human)', async () => {
    state.injectsInWindow = 999_999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_session_inject_rate')
  })

  test('a non-human actor over the daily cost cap is blocked', async () => {
    state.costSpent = 999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_cost_cap')
  })

  test('gate order — FIRST block wins: threshold fails before the inject-rate check would even run', async () => {
    state.thresholdAllowed = false
    state.injectsInWindow = 999_999 // would ALSO fail — threshold must win, being first
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('quota_threshold_reached')
  })
})

describe('PTYCAP Phase 2 — programmatic-credit halt applies to automation only', () => {
  test('a human turn is exempt from the programmatic-credit halt (gates.ts invariant)', async () => {
    state.haltBound = '5'
    state.creditUsed = 50
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(true)
  })

  test('an automation turn IS stopped by the same programmatic-credit halt', async () => {
    state.haltBound = '5'
    state.creditUsed = 50
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'automation' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('programmatic_credit_halt')
  })

  test('the halt exemption never exempts a human from the daily cost cap itself', async () => {
    state.haltBound = '5'
    state.creditUsed = 50
    state.costSpent = 999
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r.ok).toBe(false)
    expect((r as { reason: string }).reason).toContain('over_daily_cost_cap')
  })
})

describe('PTYCAP Phase 2 — fail closed', () => {
  test('a gate that THROWS is a rejection, never a pass', async () => {
    state.thresholdMode = 'throw'
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r).toEqual({ ok: false, reason: 'pty_preflight_error' })
  })

  test('a gate that never settles times out as a rejection instead of hanging the writer', async () => {
    state.thresholdMode = 'hang'
    _setPtyPreflightTimeoutForTests(20)
    const r = await checkPtyTurnPreflight({ userId: 'u1', sessionId: 's1', actor: 'human' })
    expect(r).toEqual({ ok: false, reason: 'pty_preflight_timeout' })
  })
})

describe('PTYCAP Phase 2 — isPtySubmit', () => {
  const b64 = (s: string) => btoa(s)
  test('Enter, and a paste ending in a newline, are submits', () => {
    expect(isPtySubmit(b64('\r'))).toBe(true)
    expect(isPtySubmit(b64('hello world\n'))).toBe(true)
  })
  test('plain typing, Ctrl-C, Esc and arrow keys are NOT submits', () => {
    expect(isPtySubmit(b64('a'))).toBe(false)
    expect(isPtySubmit(b64('\x03'))).toBe(false)
    expect(isPtySubmit(b64('\x1b'))).toBe(false)
    expect(isPtySubmit(b64('\x1b[A'))).toBe(false)
  })
  test('undecodable input fails closed (treated as a submit)', () => {
    expect(isPtySubmit('!!!not base64!!!')).toBe(true)
  })
})

// Security panel (blocking): Enter has encodings with NO CR/LF byte. The Claude
// CLI's key parser maps the kitty/CSI-u sequences `ESC[13u` / `ESC[57414u` to
// "return" whether or not kitty mode was enabled — a bypass of a CR/LF-only
// check. Anything with ESC that is not a known-safe sequence must be checked.
describe('PTYCAP Phase 2 — classifyPtyInput (non-CR/LF encodings of Enter)', () => {
  // UTF-8 encode, as xterm's onData → TextEncoder does, then base64.
  const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)))
  test('kitty / CSI-u Enter encodings are submits', () => {
    for (const seq of ['\x1b[13u', '\x1b[57414u', '\x1b[13;1u', '\x1b[13;1:1u', 'hi\x1b[13u']) {
      expect(isPtySubmit(b64(seq))).toBe(true)
    }
  })
  test('keypad Enter in application mode (ESC O M) and C1 CSI/SS3 are submits', () => {
    expect(isPtySubmit(b64('\x1bOM'))).toBe(true)
    expect(isPtySubmit(btoa(String.fromCharCode(0xc2, 0x9b)) )).toBe(true) // U+009B as UTF-8
    expect(isPtySubmit(btoa(String.fromCharCode(0xc2, 0x8f)) )).toBe(true) // U+008F as UTF-8
  })
  // ai-review (codex, blocking): a non-fatal decoder turned a raw C1 byte into
  // U+FFFD, so raw `9b 31 33 75` (8-bit CSI 13u) passed as plain text — while
  // the supervisor writes the raw bytes to the PTY.
  test('raw (non-UTF-8) C1 bytes and any invalid UTF-8 are submits', () => {
    expect(isPtySubmit(btoa(String.fromCharCode(0x9b, 0x31, 0x33, 0x75)))).toBe(true)
    expect(isPtySubmit(btoa(String.fromCharCode(0x8f, 0x4d)))).toBe(true)
    expect(isPtySubmit(btoa(String.fromCharCode(0x61, 0xff)))).toBe(true)
  })
  test('an unknown or incomplete escape fails closed', () => {
    expect(isPtySubmit(b64('\x1b[1'))).toBe(true)
    expect(isPtySubmit(b64('\x1b['))).toBe(true)
    expect(isPtySubmit(b64('\x1bO'))).toBe(true)
    expect(isPtySubmit(b64('\x1b[<0;10;5M'))).toBe(true)
  })
  test('navigation, editing and cancel keys are NOT submits', () => {
    for (const seq of [
      '\x1b[B', '\x1b[C', '\x1b[D', '\x1b[H', '\x1b[F', '\x1b[Z', '\x1b[I', '\x1b[O',
      '\x1b[1;5C', '\x1b[1;2A', '\x1b[3~', '\x1b[5~', '\x1b[6~', '\x1b[3;5~',
      '\x1bOA', '\x1bOH', '\x1b\x1b', '\x7f', '\t', '\x1bb', '\x1b[200~pasted\x1b[201~', 'héllo ✓',
    ]) {
      expect({ seq, submit: isPtySubmit(b64(seq)) }).toEqual({ seq, submit: false })
    }
  })
  test('a trailing lone Esc is carried as the tail; nothing else is', () => {
    expect(classifyPtyInput(b64('\x1b'))).toEqual({ submit: false, tail: '\x1b' })
    expect(classifyPtyInput(b64('abc\x1b\x1b'))).toEqual({ submit: false, tail: '\x1b' })
    expect(classifyPtyInput(b64('\x1b[A'))).toEqual({ submit: false, tail: '' })
  })
  // ai-review (codex, blocking) on 8c0ca80: only a lone ESC was carried, so a
  // checked-and-passed `ESC[` could be completed later by an unchecked `13u`.
  test('ANY open escape prefix is carried as the tail (and is itself a submit)', () => {
    expect(classifyPtyInput(b64('\x1b['))).toEqual({ submit: true, tail: '\x1b[' })
    expect(classifyPtyInput(b64('\x1b[13'))).toEqual({ submit: true, tail: '\x1b[13' })
    expect(classifyPtyInput(b64('\x1bO'))).toEqual({ submit: true, tail: '\x1bO' })
    expect(classifyPtyInput(b64('go\r\x1b['))).toEqual({ submit: true, tail: '\x1b[' }) // tail kept after a CR
    expect(classifyPtyInput(b64('3'), '\x1b[1')).toEqual({ submit: true, tail: '\x1b[13' })
    expect(classifyPtyInput(b64('u'), '\x1b[13').submit).toBe(true)
    expect(classifyPtyInput(b64('A'), '\x1b[')).toEqual({ submit: false, tail: '' }) // completes to an arrow
    expect(classifyPtyInput(b64('\x1b[' + '1'.repeat(200))).tail.length).toBe(64)
  })
  test('a sequence SPLIT across frames is judged joined with the previous tail', () => {
    expect(classifyPtyInput(b64('[13u'), '\x1b').submit).toBe(true)
    expect(classifyPtyInput(b64('OM'), '\x1b').submit).toBe(true)
    expect(classifyPtyInput(b64('[A'), '\x1b')).toEqual({ submit: false, tail: '' })
    expect(classifyPtyInput(b64('h'), '\x1b')).toEqual({ submit: false, tail: '' }) // Alt+h
    expect(classifyPtyInput(b64('[13u')).submit).toBe(false) // without a tail it is plain text
  })
})

/**
 * Milestone ASK — the gate contract for the external ask path.
 *
 * IR-1 / BSA-04: the ask dispatch MUST ride the non-bypassable daily COST cap AND
 * daily TOKEN cap, the human-only-PTY guard (the actor is server-inferred
 * automation, so a pty-interactive target is REJECTED, never redirected), and the
 * per-key ask-rate ceiling. `hub/test/token-cap-coverage.test.ts` scans every
 * `gates: [...]` array in hub/src and hard-fails CI if the token cap is missing —
 * this file pins the rest of the list + the two behaviours we can prove in a unit.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { humanOnlyRejectsActor, maxAsksPerHour } from '../src/dispatch/gates.ts'
import { EXT_ACTOR } from '../src/auth/ext-api-key-middleware.ts'

const askDispatchSrc = readFileSync(join(import.meta.dir, '../src/ask/dispatch.ts'), 'utf8')

describe('ask gate list', () => {
  const gatesBlock = askDispatchSrc.slice(
    askDispatchSrc.indexOf('gates: ['),
    askDispatchSrc.indexOf('store,', askDispatchSrc.indexOf('gates: [')),
  )

  for (const gate of [
    'thresholdGate',
    'dailyCostCapGate',
    'dailyTokenCapGate',
    'humanOnlyPtyGate',
    'askRateGate',
  ]) {
    test(`ask dispatch composes ${gate}`, () => {
      expect(
        gatesBlock.includes(gate),
        `hub/src/ask/dispatch.ts gates[] is missing ${gate}. The external ask path must ` +
          `never dispatch without the cost cap, the token cap, the human-only-PTY guard, ` +
          `and the per-key ask-rate ceiling.`,
      ).toBe(true)
    })
  }
})

describe('the actor is server-inferred automation', () => {
  test('an external ask can NEVER drive a pty-interactive session', () => {
    expect(humanOnlyRejectsActor(EXT_ACTOR, 'pty-interactive')).toBe(true)
  })

  test('a stream-json ask session is allowed', () => {
    expect(humanOnlyRejectsActor(EXT_ACTOR, 'stream-json')).toBe(false)
  })

  test('the actor constant is not something a client could assert as human', () => {
    expect(EXT_ACTOR).not.toBe('human')
  })
})

describe('askRateGate config', () => {
  test('defaults to 10 asks/hour', () => {
    const prev = process.env.REMO_ASK_MAX_PER_HOUR
    delete process.env.REMO_ASK_MAX_PER_HOUR
    expect(maxAsksPerHour()).toBe(10)
    if (prev !== undefined) process.env.REMO_ASK_MAX_PER_HOUR = prev
  })

  test('honours the env override', () => {
    const prev = process.env.REMO_ASK_MAX_PER_HOUR
    process.env.REMO_ASK_MAX_PER_HOUR = '3'
    expect(maxAsksPerHour()).toBe(3)
    if (prev === undefined) delete process.env.REMO_ASK_MAX_PER_HOUR
    else process.env.REMO_ASK_MAX_PER_HOUR = prev
  })
})

/**
 * BSA-01 — autospawn gate (REMO_ORCHESTRATOR_AUTOSPAWN).
 *
 * Pure env-toggle coverage: default OFF, accepts 1|true|yes|on (case-insensitive),
 * read at call-time (so a test's process.env mutation applies without reimport).
 * No caller acts on it yet — this foundation only exposes the predicate.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { isAutospawnEnabled } from '../src/orchestrator/controller.ts'

const KEY = 'REMO_ORCHESTRATOR_AUTOSPAWN'
const original = process.env[KEY]

afterEach(() => {
  if (original === undefined) delete process.env[KEY]
  else process.env[KEY] = original
})

describe('BSA-01 isAutospawnEnabled', () => {
  test('default OFF when unset', () => {
    delete process.env[KEY]
    expect(isAutospawnEnabled()).toBe(false)
  })

  test('OFF for 0/false/empty/garbage', () => {
    for (const v of ['0', 'false', '', '  ', 'no', 'off', 'maybe']) {
      process.env[KEY] = v
      expect(isAutospawnEnabled()).toBe(false)
    }
  })

  test('ON for 1|true|yes|on, case-insensitive + trimmed', () => {
    for (const v of ['1', 'true', 'TRUE', 'Yes', ' on ', 'ON']) {
      process.env[KEY] = v
      expect(isAutospawnEnabled()).toBe(true)
    }
  })

  test('read at call-time (toggles without reimport)', () => {
    process.env[KEY] = '1'
    expect(isAutospawnEnabled()).toBe(true)
    process.env[KEY] = '0'
    expect(isAutospawnEnabled()).toBe(false)
  })
})

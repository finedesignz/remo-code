/**
 * Phase 16 (NH-3 / R-PTY-34) — Origin / CSWSH enforcement on the /ws/client
 * handshake. A disallowed OR missing Origin is rejected so a forged-origin
 * socket cannot ride the user's cookie to drive the human PTY; an allowed
 * Origin proceeds.
 */
import { describe, test, expect } from 'bun:test'
import { isAllowedClientWsOrigin } from '../src/ws/origin-guard'

const ALLOWED = ['https://app.remo-code.com', 'http://localhost:5173']

describe('Phase 16 — /ws/client Origin/CSWSH guard', () => {
  test('an allowed Origin proceeds', () => {
    expect(isAllowedClientWsOrigin('https://app.remo-code.com', ALLOWED)).toBe(true)
    expect(isAllowedClientWsOrigin('http://localhost:5173', ALLOWED)).toBe(true)
  })

  test('a cross-site/disallowed Origin is rejected', () => {
    expect(isAllowedClientWsOrigin('https://evil.example.com', ALLOWED)).toBe(false)
  })

  test('a MISSING Origin is rejected (CSWSH hardening — browsers always send it)', () => {
    expect(isAllowedClientWsOrigin(null, ALLOWED)).toBe(false)
    expect(isAllowedClientWsOrigin(undefined, ALLOWED)).toBe(false)
    expect(isAllowedClientWsOrigin('', ALLOWED)).toBe(false)
  })
})

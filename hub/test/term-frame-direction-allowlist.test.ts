/**
 * Phase 16 (NH-2 / R-PTY-33) — per-socket terminal-frame DIRECTION allowlist.
 *
 * `term.input` (client→PTY write) is accepted ONLY on /ws/client, NEVER on
 * /ws/agent; /ws/agent terminal frames are OUTPUT-ONLY (`term.data`). This is the
 * pure allowlist the relay branches consult before forwarding — proving it here
 * fixes the contract; the relay-handler tests (term-relay-auth /
 * term-agent-inventory-auth) exercise it end-to-end.
 */
import { describe, test, expect } from 'bun:test'
import {
  isClientToHubTermType,
  isAgentToHubTermType,
  CLIENT_TO_HUB_TERM_TYPES,
  AGENT_TO_HUB_TERM_TYPES,
} from '../src/ws/term-protocol'

describe('Phase 16 — frame-direction allowlist', () => {
  test('/ws/client accepts ONLY client→PTY write frames', () => {
    expect(isClientToHubTermType('term.input')).toBe(true)
    expect(isClientToHubTermType('term.resize')).toBe(true)
    expect(isClientToHubTermType('term.attach')).toBe(true)
    expect(isClientToHubTermType('term.reattach')).toBe(true)
    // A server→client OUTPUT frame injected by a client is NOT a write frame.
    expect(isClientToHubTermType('term.data')).toBe(false)
  })

  test('/ws/agent accepts ONLY server→client output (term.data)', () => {
    expect(isAgentToHubTermType('term.data')).toBe(true)
    // term.input (a WRITE) on /ws/agent is rejected — the supervisor channel
    // must never become an unguarded input path into a human PTY.
    expect(isAgentToHubTermType('term.input')).toBe(false)
    expect(isAgentToHubTermType('term.resize')).toBe(false)
    expect(isAgentToHubTermType('term.attach')).toBe(false)
    expect(isAgentToHubTermType('term.reattach')).toBe(false)
  })

  test('the two direction sets are disjoint (no frame is valid in both directions)', () => {
    for (const t of CLIENT_TO_HUB_TERM_TYPES) {
      expect(AGENT_TO_HUB_TERM_TYPES.has(t)).toBe(false)
    }
    for (const t of AGENT_TO_HUB_TERM_TYPES) {
      expect(CLIENT_TO_HUB_TERM_TYPES.has(t)).toBe(false)
    }
  })
})

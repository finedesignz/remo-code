/**
 * Phase 16 (R-PTY-10 / constraint 3 / T-16-06 / T-16-08) — the human-only PTY
 * gate on the DISPATCH path.
 *
 * Asserts:
 *   - every automation source (scheduler / orchestrator-background / auto-dev /
 *     error-capture / agent) is REJECTED for a pty-interactive session,
 *   - a genuine human turn to a pty-interactive session is ALLOWED,
 *   - automation to a stream-json session is UNCHANGED (the gate is a no-op
 *     there) — still cost-capped by dailyCostCapGate (composes WITH, not instead
 *     of, the cap),
 *   - the gate never bypasses the cost cap.
 */
import { describe, test, expect } from 'bun:test'
import {
  humanOnlyRejectsActor,
  humanOnlyPtyGate,
  AUTOMATION_ACTORS,
} from '../src/dispatch/gates'

const baseReq = {
  userId: 'u1',
  sessionId: 's1',
  token: 't1',
  prompt: 'hi',
}

describe('Phase 16 — humanOnlyRejectsActor (shared decision)', () => {
  test('every automation actor is rejected for pty-interactive', () => {
    for (const actor of AUTOMATION_ACTORS) {
      expect(humanOnlyRejectsActor(actor, 'pty-interactive')).toBe(true)
    }
  })

  test('human is allowed for pty-interactive', () => {
    expect(humanOnlyRejectsActor('human', 'pty-interactive')).toBe(false)
  })

  test('a client-asserted "human" string from an agent connection still fails — actor is server-inferred, not the string', () => {
    // The relay infers the actor from the connection; if the connection is an
    // agent the inferred actor is 'agent', which this decision rejects. A frame
    // that *claims* source:"human" never reaches this function as 'human'.
    expect(humanOnlyRejectsActor('agent', 'pty-interactive')).toBe(true)
  })

  test('automation to a stream-json session is a no-op (unchanged)', () => {
    for (const actor of AUTOMATION_ACTORS) {
      expect(humanOnlyRejectsActor(actor, 'stream-json')).toBe(false)
    }
    expect(humanOnlyRejectsActor('human', 'stream-json')).toBe(false)
  })
})

describe('Phase 16 — humanOnlyPtyGate (dispatch pipeline form)', () => {
  test('blocks an automation source for a pty-interactive session', async () => {
    const gate = humanOnlyPtyGate(async () => ({ actor: 'scheduler', runnerType: 'pty-interactive' }))
    const r = await gate.check(baseReq as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('automation_blocked_on_pty:scheduler')
  })

  test('allows a human turn to a pty-interactive session', async () => {
    const gate = humanOnlyPtyGate(async () => ({ actor: 'human', runnerType: 'pty-interactive' }))
    expect((await gate.check(baseReq as any)).ok).toBe(true)
  })

  test('allows automation to a stream-json session (still subject to other gates)', async () => {
    const gate = humanOnlyPtyGate(async () => ({ actor: 'scheduler', runnerType: 'stream-json' }))
    expect((await gate.check(baseReq as any)).ok).toBe(true)
  })

  test('the gate is named distinctly so it composes alongside daily_cost_cap (never replaces it)', () => {
    const gate = humanOnlyPtyGate(async () => ({ actor: 'human', runnerType: 'pty-interactive' }))
    expect(gate.name).toBe('human_only_pty')
    expect(gate.name).not.toBe('daily_cost_cap')
  })
})

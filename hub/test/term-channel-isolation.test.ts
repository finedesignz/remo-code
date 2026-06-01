/**
 * Phase 15 — raw-terminal channel isolation (R-PTY-03).
 *
 * Static assertions that the term.* channel is provably isolated from the
 * structured agent-protocol / RunnerEvent pipeline:
 *   1. term-protocol.ts imports neither agent-protocol nor protocol, and never
 *      references the RunnerEvent union.
 *   2. The relay branches in agent.ts and client.ts short-circuit (early
 *      `return`) for term.* frames BEFORE the structured *Inbound.safeParse,
 *      so a term frame can never reach the agent-protocol handler or create a
 *      `messages` row.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const WS = join(import.meta.dir, '..', 'src', 'ws')
const read = (f: string) => readFileSync(join(WS, f), 'utf-8')

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n')
}

describe('Phase 15 — term channel isolation (R-PTY-03)', () => {
  test('term-protocol.ts does not import agent-protocol/protocol or reference RunnerEvent', () => {
    const code = stripComments(read('term-protocol.ts'))
    expect(/from\s+['"]\.\/agent-protocol['"]/.test(code)).toBe(false)
    expect(/from\s+['"]\.\/protocol['"]/.test(code)).toBe(false)
    expect(code.includes('RunnerEvent')).toBe(false)
  })

  test('agent.ts relays term.* and returns BEFORE AgentInbound.safeParse', () => {
    const code = stripComments(read('agent.ts'))
    const termIdx = code.indexOf('isTermFrameType(parsed)')
    const safeParseIdx = code.indexOf('AgentInbound.safeParse')
    expect(termIdx).toBeGreaterThan(-1)
    expect(safeParseIdx).toBeGreaterThan(-1)
    expect(termIdx).toBeLessThan(safeParseIdx) // term branch comes first
    // The term branch ends with a `return` (short-circuit) before the structured path.
    const branch = code.slice(termIdx, safeParseIdx)
    expect(/\breturn\b/.test(branch)).toBe(true)
  })

  test('client.ts relays term.* and returns BEFORE ClientInbound.safeParse', () => {
    const code = stripComments(read('client.ts'))
    const termIdx = code.indexOf('isTermFrameType(parsed)')
    const safeParseIdx = code.indexOf('ClientInbound.safeParse')
    expect(termIdx).toBeGreaterThan(-1)
    expect(safeParseIdx).toBeGreaterThan(-1)
    expect(termIdx).toBeLessThan(safeParseIdx)
    const branch = code.slice(termIdx, safeParseIdx)
    expect(/\breturn\b/.test(branch)).toBe(true)
    // term.input is gated by the license check (mutation), like send_message.
    expect(branch.includes('isLicenseActive')).toBe(true)
  })

  test('the term relay never calls insertMessage (no messages persistence)', () => {
    for (const f of ['agent.ts', 'client.ts']) {
      const code = stripComments(read(f))
      const termIdx = code.indexOf('isTermFrameType(parsed)')
      const end = code.indexOf('.safeParse', termIdx)
      const branch = code.slice(termIdx, end)
      expect(branch.includes('insertMessage')).toBe(false)
      expect(branch.includes('appendToMessage')).toBe(false)
    }
  })
})

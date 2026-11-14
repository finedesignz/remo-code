// CORCH-04 (CORCH-R1.15): table-driven candidate derivation from gsd-console board JSON.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect } from 'bun:test'
import { deriveCandidate, comparePhaseNumbers, type BoardDetail, type BoardSummary } from '../src/corch/gsdc-derive.ts'

const SLUG = 'acme/app'
const ok: BoardSummary = { id: 'p1', slug: SLUG, stale: false, divergent: false, active_runs: 0 }
const ph = (number: string, name: string | null = null, goal: string | null = null) => ({ number, name, goal })

function board(cols: Partial<Record<'done' | 'current' | 'backlog' | 'pending', ReturnType<typeof ph>[]>>, over: Partial<BoardDetail> = {}): BoardDetail {
  return {
    position: { milestone: { version: 'v1.2', heading: 'Milestone v1.2' } },
    snapshot: { state: 'ready', stale: false },
    columns: { done: [], current: [], backlog: [], pending: [], ...cols },
    ...over,
  }
}

describe('deriveCandidate', () => {
  test('current phase wins over pending', () => {
    const d = deriveCandidate(SLUG, ok, board({ current: [ph('4', 'Four', 'goal four')], pending: [ph('5')] }))
    expect(d).toMatchObject({ kind: 'apply', candidate: { sourceRef: 'acme/app:v1.2:4', title: 'Phase 4: Four', body: 'goal four' } })
  })

  test('no current: lowest-numbered pending, numeric not lexicographic', () => {
    const d = deriveCandidate(SLUG, ok, board({ pending: [ph('10'), ph('2'), ph('3.1'), ph('3')] }))
    expect(d).toMatchObject({ kind: 'apply', candidate: { sourceRef: 'acme/app:v1.2:2' } })
  })

  test('backlog (999.x) is ignored; only backlog => no candidate', () => {
    const d = deriveCandidate(SLUG, ok, board({ backlog: [ph('999.1')] }))
    expect(d).toEqual({ kind: 'apply', candidate: null, doneRefs: [] })
  })

  test('done phases are reported as doneRefs with the same identity scheme', () => {
    const d = deriveCandidate(SLUG, ok, board({ done: [ph('1'), ph('2')], pending: [ph('3')] }))
    expect(d).toMatchObject({ kind: 'apply', doneRefs: ['acme/app:v1.2:1', 'acme/app:v1.2:2'] })
  })

  test.each([
    ['active_runs', { ...ok, active_runs: 1 }, board({ current: [ph('1')] })],
    ['stale', { ...ok, stale: true }, board({ current: [ph('1')] })],
    ['divergent', { ...ok, divergent: true }, board({ current: [ph('1')] })],
    ['snapshot_not_ready', ok, board({ current: [ph('1')] }, { snapshot: { state: 'pending', stale: false } })],
    ['snapshot_not_ready', ok, board({ current: [ph('1')] }, { snapshot: { state: 'ready', stale: true } })],
    ['snapshot_not_ready', ok, board({}, { snapshot: null, columns: null })],
  ])('skip: %s (no candidate AND no done refs)', (reason, summary, b) => {
    expect(deriveCandidate(SLUG, summary as BoardSummary, b)).toEqual({ kind: 'skip', reason: reason as any })
  })

  test('milestone falls back to heading, then to none', () => {
    const h = deriveCandidate(SLUG, ok, board({ current: [ph('1')] }, { position: { milestone: { version: null, heading: 'Launch' } } }))
    expect(h).toMatchObject({ candidate: { sourceRef: 'acme/app:Launch:1' } })
    const n = deriveCandidate(SLUG, ok, board({ current: [ph('1')] }, { position: null }))
    expect(n).toMatchObject({ candidate: { sourceRef: 'acme/app:none:1' } })
  })

  test('comparePhaseNumbers', () => {
    expect(['10', '2', '2.5', '2.10', '1'].sort(comparePhaseNumbers)).toEqual(['1', '2', '2.5', '2.10', '10'])
  })
})

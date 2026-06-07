/**
 * Phase 26 (auto-dev-orchestrator) — gap-scan dimension wheel + LRU rotation.
 *
 *   1. nextGapDimensions LRU correctness: empty log → wheel head; after a dimension is
 *      used it becomes the LAST to repeat; a full 8-cycle covers every dimension before
 *      any repeats; count>1; deterministic tie-break; junk run-log rows ignored.
 *   2. DIMENSION_AGENTS completeness: every wheel dimension maps to a specialist agent.
 *
 * Reqs: R-ADO-17 (wheel + LRU), R-ADO-18 (dimension → specialist agent). Decision D7.
 */
import { describe, test, expect } from 'bun:test'
import {
  GAP_DIMENSIONS,
  DIMENSION_AGENTS,
  nextGapDimensions,
  agentForDimension,
  isGapDimension,
  type GapDimension,
  type GapRunLogLike,
} from '../src/orchestrator/gap-rotation.ts'

const log = (...dims: Array<string | null>): GapRunLogLike[] =>
  // run-log is NEWEST-FIRST; callers list newest → oldest.
  dims.map((d) => ({ command: 'gap-scan', gap_dimension: d }))

describe('GAP_DIMENSIONS — the fixed wheel (D7)', () => {
  test('is exactly the 8 SPEC dimensions in order', () => {
    expect([...GAP_DIMENSIONS]).toEqual([
      'security',
      'performance',
      'accessibility',
      'test-coverage',
      'dependency-hygiene',
      'error-handling',
      'docs-drift',
      'type-safety',
    ])
  })
})

describe('DIMENSION_AGENTS — completeness (R-ADO-18)', () => {
  test('every dimension maps to a non-empty specialist agent', () => {
    for (const dim of GAP_DIMENSIONS) {
      const agent = agentForDimension(dim)
      expect(typeof agent).toBe('string')
      expect(agent.length).toBeGreaterThan(0)
      expect(DIMENSION_AGENTS[dim]).toBe(agent)
    }
    expect(Object.keys(DIMENSION_AGENTS).length).toBe(GAP_DIMENSIONS.length)
  })
})

describe('nextGapDimensions — LRU rotation (R-ADO-17)', () => {
  test('empty log → wheel head (security)', () => {
    expect(nextGapDimensions([], 1)).toEqual(['security'])
    expect(nextGapDimensions(undefined as any, 1)).toEqual(['security'])
  })

  test('after security is used, security becomes the LAST to repeat', () => {
    const picks = nextGapDimensions(log('security'), 1)
    expect(picks).not.toContain('security') // most-recently-used ⇒ not picked
    // the never-used wheel head after security is performance (tie-break by wheel order)
    expect(picks).toEqual(['performance'])
  })

  test('full 8-cycle covers every dimension before any repeats', () => {
    const order: GapDimension[] = []
    // simulate ticks: each pick is prepended to the run log (newest-first)
    let runlog: GapRunLogLike[] = []
    for (let i = 0; i < GAP_DIMENSIONS.length; i++) {
      const [dim] = nextGapDimensions(runlog, 1)
      order.push(dim)
      runlog = [...log(dim), ...runlog]
    }
    // every dimension appears exactly once across the first full cycle
    expect(new Set(order).size).toBe(GAP_DIMENSIONS.length)
    expect([...order].sort()).toEqual([...GAP_DIMENSIONS].sort())
  })

  test('9th tick repeats the FIRST-used dimension (oldest = most stale)', () => {
    // used newest→oldest: ...,security was the OLDEST use ⇒ next pick after a full
    // cycle is the oldest-used (the very first one). Build a full-cycle log.
    const cycle: GapDimension[] = []
    let runlog: GapRunLogLike[] = []
    for (let i = 0; i < GAP_DIMENSIONS.length; i++) {
      const [dim] = nextGapDimensions(runlog, 1)
      cycle.push(dim)
      runlog = [...log(dim), ...runlog]
    }
    const ninth = nextGapDimensions(runlog, 1)[0]
    expect(ninth).toBe(cycle[0]) // wheel wraps to the least-recently-used
  })

  test('count>1 returns that many distinct stale dimensions', () => {
    const picks = nextGapDimensions(log('security', 'performance'), 3)
    expect(picks.length).toBe(3)
    expect(new Set(picks).size).toBe(3)
    // security/performance are the two most-recent ⇒ excluded from the first 3 picks
    expect(picks).not.toContain('security')
    expect(picks).not.toContain('performance')
  })

  test('count is clamped to [1, 8]', () => {
    expect(nextGapDimensions([], 0).length).toBe(1)
    expect(nextGapDimensions([], -5).length).toBe(1)
    expect(nextGapDimensions([], 99).length).toBe(GAP_DIMENSIONS.length)
  })

  test('junk / null gap_dimension rows are ignored', () => {
    const picks = nextGapDimensions(log(null, 'not-a-real-dim', 'security'), 1)
    expect(picks).not.toContain('security')
    expect(isGapDimension('security')).toBe(true)
    expect(isGapDimension('bogus')).toBe(false)
    expect(isGapDimension(null)).toBe(false)
  })

  test('deterministic across repeated calls', () => {
    const a = nextGapDimensions(log('accessibility', 'security'), 4)
    const b = nextGapDimensions(log('accessibility', 'security'), 4)
    expect(a).toEqual(b)
  })
})

/**
 * PTYCAP-08 plan 10: doc-consistency guard. The specs must agree with the locked
 * verdict (F1-A1: no QC token ceiling; F1-A6: no stale "cost is unmeasurable"
 * rationale) and with the shipped three-kind safe-fix allowlist. Reads the
 * planning files relative to the repo root; each failure names file and line.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const P8 = '.planning/phases/PTYCAP-08-task-qc'
const P9 = '.planning/phases/PTYCAP-09-cap-hit-qc-trigger'
const FILES = {
  spec8: `${P8}/08-SPEC.md`,
  forks8: `${P8}/08-FORKS.md`,
  ctx8: `${P8}/08-CONTEXT.md`,
  spec9: `${P9}/09-SPEC.md`,
}

const KNOB = 'REMO_TASK_QC_TOKEN_CAP'
const ALLOWLIST = ['normalize_timezone', 'backfill_payload_from_sibling', 'rebind_dead_session']

function lines(rel: string): string[] {
  return readFileSync(join(ROOT, rel), 'utf8').split(/\r?\n/)
}

function offenders(rel: string, pred: (l: string) => boolean): string[] {
  return lines(rel)
    .map((l, i) => (pred(l) ? `${rel}:${i + 1}: ${l.slice(0, 120)}` : ''))
    .filter(Boolean)
}

describe('verdict F1-A1: no QC token ceiling in the specs', () => {
  test('09-SPEC never mentions the dropped knob', () => {
    expect(offenders(FILES.spec9, (l) => l.includes(KNOB))).toEqual([])
  })

  test('08-SPEC mentions the dropped knob only on a line that says superseded', () => {
    expect(offenders(FILES.spec8, (l) => l.includes(KNOB) && !/superseded/i.test(l))).toEqual([])
  })

  test('09-SPEC AR-3 row and CQ-04 describe the deterministic engine', () => {
    const l9 = lines(FILES.spec9)
    const ar3 = l9.filter((l) => l.startsWith('| **AR-3**'))
    expect(ar3.length).toBe(1)
    expect(/deterministic/i.test(ar3[0]!)).toBe(true)
    const start = l9.findIndex((l) => l.startsWith('### CQ-04'))
    expect(start).toBeGreaterThan(-1)
    const end = l9.findIndex((l, i) => i > start && l.startsWith('### '))
    const body = l9.slice(start, end === -1 ? undefined : end).join('\n')
    expect(/deterministic/i.test(body)).toBe(true)
  })
})

describe('verdict F1-A6: stale cost-unmeasurable rationale is gone', () => {
  const STALE = (l: string) =>
    /unmeasurable/i.test(l) || /\bNULL\s+(on\s+)?100\s*%/i.test(l) || /100\s*%\s+NULL/i.test(l)
  for (const [name, rel] of Object.entries(FILES)) {
    test(`${name} has no stale cost rationale`, () => {
      expect(offenders(rel, STALE)).toEqual([])
    })
  }
})

describe('three-kind allowlist', () => {
  test('08-SPEC TQC-03 table has exactly the three shipped fix kinds', () => {
    const l8 = lines(FILES.spec8)
    const start = l8.findIndex((l) => l.startsWith('### TQC-03'))
    const end = l8.findIndex((l, i) => i > start && l.startsWith('### TQC-04'))
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const kinds = l8
      .slice(start, end)
      .map((l) => /^\s*\|\s*`([a-z_]+)`\s*\|/.exec(l)?.[1])
      .filter((k): k is string => !!k)
    expect([...kinds].sort()).toEqual([...ALLOWLIST].sort())
  })

  test('09-SPEC lists no off-allowlist fix kind as an available fix', () => {
    expect(offenders(FILES.spec9, (l) => l.includes('recompute_next_run_at'))).toEqual([])
  })

  test('08-CONTEXT records dated planner decisions', () => {
    const body = lines(FILES.ctx8).join('\n')
    expect(body).toMatch(/Planner decisions \(2026-10-13\)/)
    expect(body).toMatch(/recompute_next_run_at/)
  })
})

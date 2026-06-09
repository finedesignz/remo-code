/**
 * Milestone TMAC — Phase TMAC-02: task_type → macro prompt registry.
 * Pure, no DB. Reqs: R-TMAC-02.
 */
import { describe, test, expect } from 'bun:test'
import {
  renderMacro,
  isTaskType,
  TASK_TYPES,
  type MacroContext,
} from '../src/orchestrator/task-macros.ts'

const CTX: MacroContext = {
  repo_path: '/srv/repos/acme',
  repo_ident: 'github://acme/acme',
  lifecycle_stage: 'development',
}

describe('task-macros — registry', () => {
  test('TASK_TYPES holds the four locked types', () => {
    expect([...TASK_TYPES].sort()).toEqual(
      ['brainstorming', 'dev', 'maintenance', 'security'].sort(),
    )
  })

  test('isTaskType discriminates', () => {
    expect(isTaskType('dev')).toBe(true)
    expect(isTaskType('bogus')).toBe(false)
    expect(isTaskType(null)).toBe(false)
  })
})

describe('task-macros — DEV prompt', () => {
  const r = renderMacro('dev', CTX)

  test('dev is complete', () => {
    expect(r.task_type).toBe('dev')
    expect(r.complete).toBe(true)
  })

  test('substitutes all three placeholders (none left unresolved)', () => {
    expect(r.prompt).toContain('/srv/repos/acme')
    expect(r.prompt).toContain('github://acme/acme')
    // lifecycle_stage substituted in the header AND retained in conditional clauses
    expect(r.prompt).toContain('lifecycle stage = development')
    expect(r.prompt).not.toContain('{repo_path}')
    expect(r.prompt).not.toContain('{repo_ident}')
    expect(r.prompt).not.toContain('{lifecycle_stage}')
  })

  test('carries the canonical SPEC §4 structure (steps + sentinels + hard rules)', () => {
    for (const needle of [
      'STEP 0 — ORIENT',
      'STEP 1 — CONDITIONAL LIFECYCLE',
      'STEP 2 — PARALLEL BUILD',
      'STEP 3 — GATES',
      'STEP 4 — RELEASE',
      'STEP 5 — RECORD',
      '<<STATE',
      '<<GATE',
      '<<NOTIFY',
      'daily cost cap is non-bypassable',
      '/gsd-run finish milestone and ship',
    ]) {
      expect(r.prompt).toContain(needle)
    }
    // line-wrapped phrase: assert on whitespace-collapsed text
    expect(r.prompt.replace(/\s+/g, ' ')).toContain('one phase = one branch = one PR')
  })
})

describe('task-macros — stubs', () => {
  test('maintenance/security/brainstorming resolve but flag incomplete', () => {
    for (const t of ['maintenance', 'security', 'brainstorming'] as const) {
      const r = renderMacro(t, CTX)
      expect(r.task_type).toBe(t)
      expect(r.complete).toBe(false)
      expect(r.prompt.length).toBeGreaterThan(50)
      expect(r.prompt).toContain('/srv/repos/acme')
    }
  })

  test('stubs forbid new features and require STATE block', () => {
    const m = renderMacro('maintenance', CTX).prompt
    expect(m).toContain('NEVER introduce new features')
    expect(m).toContain('<<STATE>>')
  })
})

describe('task-macros — unknown type', () => {
  test('coerces unknown to dev (safe fully-specified routine)', () => {
    const r = renderMacro('nope', CTX)
    expect(r.task_type).toBe('dev')
    expect(r.complete).toBe(true)
  })
})

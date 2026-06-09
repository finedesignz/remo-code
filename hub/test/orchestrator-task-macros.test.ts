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

// Shared SPEC §6 envelope: every full prompt carries the same orient → flow →
// gate ladder → stage-aware notify → 3 sentinel blocks → record structure.
const ENVELOPE_NEEDLES = [
  'STEP 0 — ORIENT',
  'STEP 3 — GATES',
  'STEP 5 — RECORD',
  '<<STATE',
  '<<GATE',
  '<<NOTIFY',
  'daily cost cap is non-bypassable',
]

describe('task-macros — all four types complete', () => {
  test('maintenance/security/brainstorming resolve, substitute, flag complete', () => {
    for (const t of ['maintenance', 'security', 'brainstorming'] as const) {
      const r = renderMacro(t, CTX)
      expect(r.task_type).toBe(t)
      expect(r.complete).toBe(true)
      expect(r.prompt.length).toBeGreaterThan(500)
      expect(r.prompt).toContain('/srv/repos/acme')
      expect(r.prompt).toContain('github://acme/acme')
      expect(r.prompt).not.toContain('{repo_path}')
      expect(r.prompt).not.toContain('{lifecycle_stage}')
    }
  })

  test('each carries the shared orient/gate/notify/sentinel envelope', () => {
    for (const t of ['maintenance', 'security', 'brainstorming'] as const) {
      const p = renderMacro(t, CTX).prompt
      const flat = p.replace(/\s+/g, ' ')
      for (const needle of ENVELOPE_NEEDLES) {
        // collapse whitespace so line-wrapped phrases still match
        expect(flat).toContain(needle.replace(/\s+/g, ' '))
      }
    }
  })

  test('every full prompt carries the stage-conditional clauses (§3 matrix)', () => {
    for (const t of ['dev', 'maintenance', 'security'] as const) {
      const p = renderMacro(t, CTX).prompt
      expect(p).toContain('development:')
      expect(p).toContain('beta:')
      expect(p).toContain('production')
    }
  })
})

describe('task-macros — MAINTENANCE', () => {
  const p = renderMacro('maintenance', CTX).prompt
  test('never ships new features; driven by gsd-audit-fix + gsd-verify-work', () => {
    expect(p).toContain('NEVER introduce new features')
    expect(p).toContain('/gsd-audit-fix')
    expect(p).toContain('/gsd-verify-work')
  })
  test('release is a PATCH bump', () => {
    expect(p.replace(/\s+/g, ' ')).toContain('PATCH bump')
  })
})

describe('task-macros — SECURITY-HARDENING', () => {
  const p = renderMacro('security', CTX).prompt
  test('consults the Security Engineer specialist + opens fix PRs', () => {
    expect(p).toContain('Security Engineer')
    expect(p.replace(/\s+/g, ' ')).toContain('fix PR')
  })
  test('treats auth/cost-cap/PTY invariants as a mandatory gate at every stage', () => {
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).toContain('NEVER weaken')
    expect(flat).toContain('cost-cap')
    expect(flat).toContain('API key')
    expect(flat).toContain('every stage')
  })
})

describe('task-macros — BRAINSTORMING always gates for approval', () => {
  const p = renderMacro('brainstorming', CTX).prompt
  test('is human-in-the-loop and never autonomously builds', () => {
    const flat = p.replace(/\s+/g, ' ')
    expect(flat).toContain('HUMAN-IN-THE-LOOP')
    expect(flat).toContain('DO NOT build')
  })
  test('ALWAYS gates for approval — overriding the silent-development default', () => {
    const flat = p.replace(/\s+/g, ' ')
    // requires human approval before any idea becomes a dev milestone
    expect(flat).toContain('human approval before')
    expect(flat).toContain('dev milestone')
    // explicitly at every stage including development (overrides silent-dev)
    expect(flat).toContain('every stage, including development')
    expect(flat).toContain('OVERRIDES the silent-development default')
    // emits the blocking notify + approval gate
    expect(p).toContain('<<NOTIFY level=blocking channel=all')
    expect(p).toContain('<<GATE reason="approval"')
  })
})

describe('task-macros — unknown type', () => {
  test('coerces unknown to dev (safe fully-specified routine)', () => {
    const r = renderMacro('nope', CTX)
    expect(r.task_type).toBe('dev')
    expect(r.complete).toBe(true)
  })
})

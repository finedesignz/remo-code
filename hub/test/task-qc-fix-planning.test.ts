/**
 * PTYCAP-08 plan 04 Task 3: planFix is pure; a fix exists only when exactly one
 * safe candidate does, everything else is a proposal.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { planFix } from '../src/task-qc/fix-plans.ts'
import { SAFE_FIXES } from '../src/task-qc/safe-fixes.ts'

const mk = (fixCandidate: any, over: Record<string, unknown> = {}): any => ({
  detector: 'X',
  taskId: 't1',
  taskName: 'n',
  taskType: 'dev',
  severity: 'warn',
  evidence: {},
  proposal: { kind: 'fix_timezone', params: { taskId: 't1' } },
  ...(fixCandidate ? { fixCandidate } : {}),
  ...over,
})
const tzFinding = () => mk('normalize_timezone')
const payloadFinding = () => mk('backfill_payload_from_sibling', { proposal: { kind: 'fix_payload', params: { taskId: 't1', field: 'application_uuid' } } })
const sessionFinding = (sid = 's-dead') =>
  mk('rebind_dead_session', { evidence: { reason: 'offline_stale', sessionId: sid }, proposal: { kind: 'rebind_session', params: { taskId: 't1', staleSessionId: sid } } })

describe('normalize_timezone', () => {
  test('target is the user timezone when valid', () => {
    expect(planFix(tzFinding(), { autofix: true, taskTimezone: 'Mars/Base', userTimezone: 'America/Los_Angeles' })).toEqual({
      kind: 'fix',
      fix: { kind: 'normalize_timezone', timezone: 'America/Los_Angeles' },
    })
  })
  test('falls back to UTC when the user timezone is missing or invalid', () => {
    for (const userTimezone of [null, undefined, '', 'Not/AZone']) {
      expect(planFix(tzFinding(), { autofix: true, taskTimezone: 'Mars/Base', userTimezone })).toEqual({
        kind: 'fix',
        fix: { kind: 'normalize_timezone', timezone: 'UTC' },
      })
    }
  })
  test('an already valid task timezone yields no fix', () => {
    const r = planFix(tzFinding(), { autofix: true, taskTimezone: 'America/New_York', userTimezone: 'UTC' })
    expect(r.kind).toBe('proposal')
    expect((r as any).reason).toBe('no_candidate')
  })
})

describe('backfill_payload_from_sibling', () => {
  test('exactly one distinct uuid gives a fix', () => {
    expect(planFix(payloadFinding(), { autofix: true, siblingApplicationUuids: ['abc'] })).toEqual({
      kind: 'fix',
      fix: { kind: 'backfill_payload_from_sibling', applicationUuid: 'abc' },
    })
  })
  test('two siblings carrying the SAME uuid count as one candidate', () => {
    const r = planFix(payloadFinding(), { autofix: true, siblingApplicationUuids: ['abc', 'abc', ' abc '] })
    expect(r).toEqual({ kind: 'fix', fix: { kind: 'backfill_payload_from_sibling', applicationUuid: 'abc' } })
  })
  test('two siblings with DIFFERENT uuids are ambiguous: a proposal, never a guess', () => {
    const r: any = planFix(payloadFinding(), { autofix: true, siblingApplicationUuids: ['abc', 'def'] })
    expect(r.kind).toBe('proposal')
    expect(r.reason).toBe('ambiguous_candidate')
    expect(r.proposal.params.candidates).toBe(2)
  })
  test('zero or only blank uuids is no_candidate', () => {
    for (const siblingApplicationUuids of [undefined, [], ['', '  ', null as any]]) {
      const r: any = planFix(payloadFinding(), { autofix: true, siblingApplicationUuids })
      expect(r.kind).toBe('proposal')
      expect(r.reason).toBe('no_candidate')
    }
  })
})

describe('rebind_dead_session', () => {
  test('exactly one live candidate gives a fix carrying old and new ids', () => {
    expect(planFix(sessionFinding(), { autofix: true, deadSessionRepoKey: 'org/repo', liveSessionIds: ['s-new'] })).toEqual({
      kind: 'fix',
      fix: { kind: 'rebind_dead_session', oldSessionId: 's-dead', newSessionId: 's-new' },
    })
  })
  test('zero live candidates is no_candidate; two or more is ambiguous', () => {
    const none: any = planFix(sessionFinding(), { autofix: true, deadSessionRepoKey: 'org/repo', liveSessionIds: [] })
    expect(none.reason).toBe('no_candidate')
    const two: any = planFix(sessionFinding(), { autofix: true, deadSessionRepoKey: 'org/repo', liveSessionIds: ['a', 'b'] })
    expect(two.kind).toBe('proposal')
    expect(two.reason).toBe('ambiguous_candidate')
    expect(two.proposal.params.candidates).toBe(2)
  })
  test('the dead session itself is never a candidate', () => {
    const r: any = planFix(sessionFinding(), { autofix: true, deadSessionRepoKey: 'org/repo', liveSessionIds: ['s-dead'] })
    expect(r.reason).toBe('no_candidate')
  })
  test('a dead session with a NULL repo_key yields no_candidate even with live sessions supplied', () => {
    for (const deadSessionRepoKey of [null, undefined, '', '  ']) {
      const r: any = planFix(sessionFinding(), { autofix: true, deadSessionRepoKey, liveSessionIds: ['s-new'] })
      expect(r.kind).toBe('proposal')
      expect(r.reason).toBe('no_candidate')
    }
  })
})

describe('autofix off and findings without a fix candidate', () => {
  test('autofix false turns every fixCandidate finding into a proposal that records the would-fix kind', () => {
    const cases: Array<[any, any]> = [
      [tzFinding(), { taskTimezone: 'Mars/Base' }],
      [payloadFinding(), { siblingApplicationUuids: ['abc'] }],
      [sessionFinding(), { deadSessionRepoKey: 'org/repo', liveSessionIds: ['s-new'] }],
    ]
    for (const [finding, ctx] of cases) {
      const r: any = planFix(finding, { autofix: false, ...ctx })
      expect(r.kind).toBe('proposal')
      expect(r.reason).toBe('autofix_off')
      expect(r.proposal.params.would_fix).toBe(finding.fixCandidate)
      expect(r.proposal.kind).toBe(finding.proposal.kind)
    }
  })
  test('a finding without a fixCandidate yields no_fix_candidate with its own proposal', () => {
    const f = mk(null, { proposal: { kind: 'propose_disable', params: { taskId: 't1' } } })
    expect(planFix(f, { autofix: true })).toEqual({ kind: 'proposal', reason: 'no_fix_candidate', proposal: { kind: 'propose_disable', params: { taskId: 't1' } } })
    expect((planFix(f, { autofix: false }) as any).reason).toBe('no_fix_candidate')
  })
  test('the planner does not mutate the finding', () => {
    const f = payloadFinding()
    const snapshot = JSON.stringify(f)
    planFix(f, { autofix: false })
    planFix(f, { autofix: true, siblingApplicationUuids: ['a', 'b'] })
    expect(JSON.stringify(f)).toBe(snapshot)
  })
})

describe('closed output', () => {
  test('across generated findings and contexts, a fix kind is always on the SAFE_FIXES list', () => {
    const findings = [tzFinding(), payloadFinding(), sessionFinding(), mk(null), mk('disable_task'), mk('recompute_next_run_at')]
    const ctxs: any[] = [
      { autofix: true, taskTimezone: 'Mars/Base', userTimezone: 'UTC', siblingApplicationUuids: ['x'], liveSessionIds: ['n'], deadSessionRepoKey: 'k' },
      { autofix: true, siblingApplicationUuids: ['x', 'y'], liveSessionIds: ['a', 'b'], deadSessionRepoKey: 'k' },
      { autofix: false },
      { autofix: true },
    ]
    let fixes = 0
    for (const f of findings) {
      for (const c of ctxs) {
        let r: any
        try {
          r = planFix(f, c)
        } catch {
          continue
        }
        if (r.kind === 'fix') {
          fixes++
          expect(SAFE_FIXES.has(r.fix.kind)).toBe(true)
        }
      }
    }
    expect(fixes).toBeGreaterThan(0)
  })

  test('an unlisted fixCandidate never becomes a fix', () => {
    for (const bad of ['disable_task', 'recompute_next_run_at', 'edit_prompt']) {
      const r: any = planFix(mk(bad), { autofix: true, taskTimezone: 'Mars/Base', siblingApplicationUuids: ['x'], liveSessionIds: ['n'], deadSessionRepoKey: 'k' })
      expect(r.kind).toBe('proposal')
      expect(r.reason).toBe('no_fix_candidate')
    }
  })

  test('fix-plans.ts imports no database module', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'task-qc', 'fix-plans.ts'), 'utf8')
    const imports = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]!).sort()
    expect(imports).toEqual(['../scheduler/cron.ts', './safe-fixes.ts', './types.ts'])
    expect(src).not.toMatch(/postgres|process\.env|Date\.now/)
  })
})

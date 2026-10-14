/** PTYCAP-08 plan 02: pure detector fixtures (DB-free). */
import { describe, expect, test } from 'bun:test'
import {
  detectFailing,
  detectSkipForever,
  isAuditable,
} from '../src/task-qc/detectors.ts'
import { safeText } from '../src/task-qc/types.ts'
import type { AuditTaskInput, RunInput } from '../src/task-qc/types.ts'

const NOW = new Date('2026-10-13T12:00:00.000Z')
const CFG = { failStreak: 3 }

function task(over: Partial<AuditTaskInput> = {}): AuditTaskInput {
  return {
    id: 't1',
    user_id: 'u1',
    name: 'Nightly dev',
    task_type: 'dev',
    enabled: true,
    schedule_kind: 'cron',
    cron_expr: '0 9 * * *',
    timezone: 'UTC',
    created_at: '2026-10-01T00:00:00.000Z',
    last_fire_at: null,
    next_fire_at: '2026-10-14T09:00:00.000Z',
    target_kind: 'session',
    target_id: 's1',
    session_id: null,
    prompt: 'do the thing',
    payload: {},
    teab_repo_ident: null,
    ...over,
  }
}

/** statuses newest first; started_at descends one hour per row. */
function runs(statuses: string[], error: string | ((i: number) => string | null) | null = null, taskId = 't1'): RunInput[] {
  return statuses.map((status, i) => ({
    id: `r${i}`,
    task_id: taskId,
    status,
    error: typeof error === 'function' ? error(i) : status === 'failed' || status.startsWith('skipped') ? error : null,
    started_at: new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(),
    finished_at: new Date(NOW.getTime() - (i + 1) * 3_600_000 + 1000).toISOString(),
    output_snippet: null,
  }))
}

describe('safeText', () => {
  test('strips control chars, folds non-ascii, collapses whitespace, truncates', () => {
    expect(safeText('a\u0000b\nc\t d')).toBe('a b c d')
    expect(safeText('café 😀')).toBe('caf? ?')
    expect(safeText('x'.repeat(500)).length).toBe(120)
    expect(safeText('x'.repeat(500), 10).length).toBe(10)
    expect(safeText(null)).toBe('')
  })
})

describe('isAuditable (D-03, F2-B7)', () => {
  test('plain enabled cron task is auditable', () => {
    expect(isAuditable(task())).toBe(true)
    expect(isAuditable(task({ schedule_kind: undefined }))).toBe(true)
  })
  test('disabled, task_qc, orchestrator, internal anchor and once are not', () => {
    expect(isAuditable(task({ enabled: false }))).toBe(false)
    expect(isAuditable(task({ task_type: 'task_qc' }))).toBe(false)
    expect(isAuditable(task({ task_type: 'orchestrator' }))).toBe(false)
    expect(isAuditable(task({ name: '__internal_anchor_x' }))).toBe(false)
    expect(isAuditable(task({ name: '__internal_anchor_x', enabled: false }))).toBe(false)
    expect(isAuditable(task({ schedule_kind: 'once' }))).toBe(false)
  })
})

describe('FAILING (D-08)', () => {
  test('3 failed fires with warn + propose_disable and no fixCandidate', () => {
    const f = detectFailing(task(), runs(['failed', 'failed', 'failed'], 'boom'), CFG)
    expect(f).not.toBeNull()
    expect(f!.detector).toBe('FAILING')
    expect(f!.severity).toBe('warn')
    expect(f!.proposal.kind).toBe('propose_disable')
    expect(f!.fixCandidate).toBeUndefined()
    expect(f!.evidence.streak).toBe(3)
    expect(f!.evidence.errorSignatures).toEqual(['boom'])
    expect(f!.evidence.errorCounts).toEqual([3])
    expect((f!.evidence.runIds as string[]).length).toBe(3)
    expect(f!.evidence.lastStartedAt).toBe(new Date(NOW.getTime() - 3_600_000).toISOString())
    expect(f!.evidence.firstStartedAt).toBe(new Date(NOW.getTime() - 3 * 3_600_000).toISOString())
  })
  test('failed,failed,success does not fire', () => {
    expect(detectFailing(task(), runs(['failed', 'failed', 'success']), CFG)).toBeNull()
  })
  test('failed,failed,skipped does not fire', () => {
    expect(detectFailing(task(), runs(['failed', 'failed', 'skipped']), CFG)).toBeNull()
  })
  test('a running run is not terminal and is not counted', () => {
    expect(detectFailing(task(), runs(['running', 'failed', 'failed']), CFG)).toBeNull()
    expect(detectFailing(task(), runs(['running', 'failed', 'failed', 'failed']), CFG)).not.toBeNull()
  })
  test('cancelled is ignored (neither breaks nor counts)', () => {
    expect(detectFailing(task(), runs(['failed', 'cancelled', 'failed', 'failed']), CFG)).not.toBeNull()
  })
  test('2 failed with N=3 does not fire', () => {
    expect(detectFailing(task(), runs(['failed', 'failed']), CFG)).toBeNull()
  })
  test('severity high at 10x streak', () => {
    const f = detectFailing(task(), runs(Array(30).fill('failed'), 'x'), CFG)
    expect(f!.severity).toBe('high')
    const w = detectFailing(task(), runs(Array(29).fill('failed'), 'x'), CFG)
    expect(w!.severity).toBe('warn')
  })
  test('500-failure fixture (full window) is high; evidence stays bounded', () => {
    const f = detectFailing(task(), runs(Array(500).fill('failed'), (i) => `err ${i} é`), CFG)
    expect(f!.severity).toBe('high')
    expect((f!.evidence.runIds as string[]).length).toBe(5)
    expect((f!.evidence.errorSignatures as string[]).length).toBeLessThanOrEqual(5)
    for (const s of f!.evidence.errorSignatures as string[]) expect(/^[\x20-\x7e]*$/.test(s)).toBe(true)
  })
  test('full small window is high even below 10x', () => {
    const f = detectFailing(task(), runs(Array(8).fill('failed'), 'x'), { failStreak: 5, windowSize: 8 })
    expect(f!.severity).toBe('high')
  })
  test('error text is sanitised and capped', () => {
    const f = detectFailing(task(), runs(['failed', 'failed', 'failed'], 'bad\u0000\nthingé' + 'z'.repeat(300)), CFG)
    const sig = (f!.evidence.errorSignatures as string[])[0]!
    expect(sig.length).toBeLessThanOrEqual(120)
    expect(/^[\x20-\x7e]*$/.test(sig)).toBe(true)
  })
})

describe('SKIP_FOREVER (D-09)', () => {
  test('3 skips on no_application_uuid fires', () => {
    const f = detectSkipForever(task(), runs(['skipped', 'skipped', 'skipped'], 'no_application_uuid'), CFG)
    expect(f).not.toBeNull()
    expect(f!.detector).toBe('SKIP_FOREVER')
    expect(f!.fixCandidate).toBeUndefined()
    expect(f!.evidence.skipRuns).toBe(3)
    expect(f!.evidence.reason).toBe('no_application_uuid')
  })
  test('3 skips on no_errors_detected does NOT fire (benign)', () => {
    expect(detectSkipForever(task(), runs(['skipped', 'skipped', 'skipped'], 'no_errors_detected'), CFG)).toBeNull()
  })
  test('every benign reason is ignored', () => {
    for (const r of [
      'orchestrator_due_tick_owned',
      'orchestrator_disabled',
      'replayed_on_reconnect',
      'automation_halted:kill_switch',
      'lifetime_inject_exhausted:cap',
    ]) {
      expect(detectSkipForever(task(), runs(['skipped', 'skipped', 'skipped'], r), CFG)).toBeNull()
    }
  })
  test('two different reasons do not fire', () => {
    const rs = runs(['skipped', 'skipped', 'skipped'], (i) => (i === 0 ? 'reason_a' : 'reason_b'))
    expect(detectSkipForever(task(), rs, CFG)).toBeNull()
  })
  test('skipped_quota with a varying utilization figure still groups', () => {
    const rs = runs(['skipped_quota', 'skipped_quota', 'skipped_quota'], (i) => `quota_exceeded 9${i}%`)
    const f = detectSkipForever(task(), rs, CFG)
    expect(f).not.toBeNull()
  })
  test('mixed skipped and skipped_quota with same signature fires', () => {
    expect(detectSkipForever(task(), runs(['skipped', 'skipped_quota', 'skipped'], 'no_application_uuid'), CFG)).not.toBeNull()
  })
  test('a success or failed in the newest N breaks it; fewer than N does not fire', () => {
    expect(detectSkipForever(task(), runs(['skipped', 'success', 'skipped'], 'no_application_uuid'), CFG)).toBeNull()
    expect(detectSkipForever(task(), runs(['skipped', 'skipped'], 'no_application_uuid'), CFG)).toBeNull()
  })
  test('non-terminal runs are ignored', () => {
    const rs = runs(['running', 'skipped', 'skipped', 'skipped'], 'no_application_uuid')
    expect(detectSkipForever(task(), rs, CFG)).not.toBeNull()
  })
})

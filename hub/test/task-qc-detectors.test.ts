/** PTYCAP-08 plan 02: pure detector fixtures (DB-free). */
import { describe, expect, test } from 'bun:test'
import {
  detectDeadSession,
  detectFailing,
  detectMisconfigured,
  detectNeverFired,
  detectSkipForever,
  isAuditable,
} from '../src/task-qc/detectors.ts'
import { safeText } from '../src/task-qc/types.ts'
import type { AuditTaskInput, RunInput, SessionInput } from '../src/task-qc/types.ts'

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

const DAY = 86_400_000
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()
const fromNow = (ms: number) => new Date(NOW.getTime() + ms).toISOString()

describe('NEVER_FIRED (D-10)', () => {
  test('daily task created 3 days ago with no runs fires, reregister_job, no fixCandidate', () => {
    const f = detectNeverFired(task({ created_at: ago(3 * DAY), next_fire_at: fromNow(DAY / 2) }), [], NOW)
    expect(f).not.toBeNull()
    expect(f!.detector).toBe('NEVER_FIRED')
    expect(f!.evidence.reasons).toEqual(['no_runs'])
    expect(f!.proposal.kind).toBe('reregister_job')
    expect(f!.proposal.params).toEqual({ taskId: 't1', enabled: true })
    expect(f!.fixCandidate).toBeUndefined()
  })
  test('same task created 1 hour ago does not fire', () => {
    expect(detectNeverFired(task({ created_at: ago(3_600_000), next_fire_at: null }), [], NOW)).toBeNull()
  })
  test('enabled task with future next_fire_at and recent runs does not fire', () => {
    expect(detectNeverFired(task({ next_fire_at: fromNow(DAY / 2) }), runs(['success']), NOW)).toBeNull()
  })
  test('NULL next_fire_at on an old task with runs fires (not armed)', () => {
    const f = detectNeverFired(task({ next_fire_at: null }), runs(['success']), NOW)
    expect(f!.evidence.reasons).toEqual(['next_fire_missing'])
    expect(f!.proposal.kind).toBe('reregister_job')
    expect(f!.fixCandidate).toBeUndefined()
  })
  test('stale next_fire_at fires only beyond 2 intervals', () => {
    expect(detectNeverFired(task({ next_fire_at: ago(5 * DAY) }), runs(['success']), NOW)!.evidence.reasons).toEqual(['next_fire_stale'])
    expect(detectNeverFired(task({ next_fire_at: ago(DAY) }), runs(['success']), NOW)).toBeNull()
  })
  test('NULL next_fire_at on a brand-new task does not fire (age gate)', () => {
    expect(detectNeverFired(task({ created_at: ago(3_600_000), next_fire_at: null }), runs(['success']), NOW)).toBeNull()
  })
  test('invalid timezone fires with the normalize_timezone candidate', () => {
    const f = detectNeverFired(task({ timezone: 'Mars/Olympus' }), runs(['success']), NOW)
    expect(f!.evidence.reasons).toEqual(['timezone_invalid'])
    expect(f!.fixCandidate).toBe('normalize_timezone')
    expect(f!.proposal.kind).toBe('fix_timezone')
  })
  test('unparseable cron is reported once under (a), no fixCandidate, skips (b)/(c)', () => {
    const f = detectNeverFired(task({ cron_expr: 'not a cron', next_fire_at: null, created_at: ago(9 * DAY) }), [], NOW)
    expect(f!.evidence.reasons).toEqual(['cron_invalid'])
    expect(f!.fixCandidate).toBeUndefined()
  })
  test('cron falls back to cron_expression when cron_expr is NULL', () => {
    expect(detectNeverFired(task({ cron_expr: null, cron_expression: '0 9 * * *', next_fire_at: fromNow(DAY / 2) }), runs(['success']), NOW)).toBeNull()
  })
  test('a disabled task and an internal anchor never fire', () => {
    expect(detectNeverFired(task({ enabled: false, next_fire_at: null, created_at: ago(9 * DAY) }), [], NOW)).toBeNull()
    expect(detectNeverFired(task({ name: '__internal_x', next_fire_at: null, created_at: ago(9 * DAY), cron_expr: '0 0 31 2 *' }), [], NOW)).toBeNull()
  })
})

describe('MISCONFIGURED (D-11)', () => {
  test('log_check with no payload uuid and unresolvable app FIRES (the real observed case)', () => {
    const f = detectMisconfigured(
      task({ task_type: 'log_check', payload: {}, resolvedAppUuid: null }),
      runs(['skipped', 'skipped'], 'no_application_uuid'),
    )
    expect(f).not.toBeNull()
    expect(f!.detector).toBe('MISCONFIGURED')
    expect(f!.evidence.skipEvidence).toBe(2)
    expect(f!.fixCandidate).toBe('backfill_payload_from_sibling')
  })
  test('log_check with no payload uuid but a mapped repo_key (resolved uuid) does NOT fire', () => {
    expect(detectMisconfigured(task({ task_type: 'log_check', payload: {}, resolvedAppUuid: 'uuid-from-repo-key' }), [])).toBeNull()
  })
  test('log_check with a payload uuid does not fire', () => {
    expect(detectMisconfigured(task({ task_type: 'log_check', payload: { application_uuid: 'u' }, resolvedAppUuid: 'u' }), [])).toBeNull()
  })
  test('log_pull is covered like log_check; an uncomputed resolver (undefined) never fires', () => {
    expect(detectMisconfigured(task({ task_type: 'log_pull', resolvedAppUuid: null }), [])!.fixCandidate).toBe('backfill_payload_from_sibling')
    expect(detectMisconfigured(task({ task_type: 'log_check' }), [])).toBeNull()
  })
  test('teab without repo fires (blank too), with repo does not; no fixCandidate', () => {
    expect(detectMisconfigured(task({ task_type: 'teab', teab_repo_ident: null }), [])!.proposal.kind).toBe('set_teab_repo')
    expect(detectMisconfigured(task({ task_type: 'teab', teab_repo_ident: '   ' }), [])).not.toBeNull()
    expect(detectMisconfigured(task({ task_type: 'teab', teab_repo_ident: 'o/r' }), [])).toBeNull()
    expect(detectMisconfigured(task({ task_type: 'teab', teab_repo_ident: null }), [])!.fixCandidate).toBeUndefined()
  })
  test('every other type, including work, never fires', () => {
    for (const t of ['dev', 'work', 'qc', 'triage', 'security']) {
      expect(detectMisconfigured(task({ task_type: t, resolvedAppUuid: null, teab_repo_ident: null }), [])).toBeNull()
    }
  })
})

describe('DEAD_SESSION (D-12)', () => {
  const sess = (over: Partial<SessionInput> = {}): SessionInput => ({
    id: 's1',
    status: 'online',
    deleted_at: null,
    last_activity: ago(1000),
    created_at: ago(30 * DAY),
    ...over,
  })
  test('deleted session fires', () => {
    const f = detectDeadSession(task(), { s1: sess({ deleted_at: ago(DAY) }) }, NOW)
    expect(f!.detector).toBe('DEAD_SESSION')
    expect(f!.evidence.reason).toBe('deleted')
    expect(f!.fixCandidate).toBe('rebind_dead_session')
  })
  test('missing session (stale target_id) fires', () => {
    expect(detectDeadSession(task(), {}, NOW)!.evidence.reason).toBe('missing')
    expect(detectDeadSession(task(), { s1: null }, NOW)!.evidence.reason).toBe('missing')
  })
  test('offline 8 days fires; offline 2 days does not; online does not', () => {
    expect(detectDeadSession(task(), { s1: sess({ status: 'offline', last_activity: ago(8 * DAY) }) }, NOW)!.evidence.reason).toBe('offline_stale')
    expect(detectDeadSession(task(), { s1: sess({ status: 'offline', last_activity: ago(2 * DAY) }) }, NOW)).toBeNull()
    expect(detectDeadSession(task(), { s1: sess() }, NOW)).toBeNull()
  })
  test('offline with NULL last_activity falls back to created_at', () => {
    expect(detectDeadSession(task(), { s1: sess({ status: 'offline', last_activity: null, created_at: ago(10 * DAY) }) }, NOW)).not.toBeNull()
  })
  test('effective session is target_id, else session_id', () => {
    const t = task({ target_id: null, session_id: 's9' })
    expect(detectDeadSession(t, { s9: sess({ id: 's9', deleted_at: ago(DAY) }) }, NOW)).not.toBeNull()
    expect(detectDeadSession(t, { s1: sess({ deleted_at: ago(DAY) }) }, NOW)!.evidence.reason).toBe('missing')
  })
  test('supervisor-kind and session-less tasks never fire', () => {
    expect(detectDeadSession(task({ target_kind: 'supervisor', target_id: 'x' }), {}, NOW)).toBeNull()
    expect(detectDeadSession(task({ target_id: null, session_id: null }), {}, NOW)).toBeNull()
  })
})

/**
 * PTYCAP-04-07 Task 1: orphan-resume kill-switch deferral (D-09b, panel F-4 / S4).
 *
 * ONLY orchestrator orphans are deferred during a halt, and they are deferred WITHOUT being
 * finalized (the open row stays open, so the release-time sweep can resume it). Non-orchestrator
 * orphans (human or machine, indistinguishable) are never deferred. The sacred user_stopped and
 * restart-cap guards still run first. Fake `sql` tag + leaf mocks; DB-free, per-file process.
 */
import { describe, test, expect, beforeEach, mock } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const s = {
  orphans: [] as any[],
  lastExitReason: null as string | null,
  updates: [] as string[],
  haltedSessions: null as null | Set<string> | 'all',
  haltCalls: [] as Array<{ userId: string; sessionId?: string }>,
  orchestratorCalls: [] as any[],
  launchResult: null as any,
  sent: [] as any[],
}

function fakeSql(strings: TemplateStringsArray, ...vals: any[]): Promise<any[]> {
  const text = strings.join('?')
  if (/UPDATE session_runs/.test(text) && /ended_at = NULL/.test(text)) {
    s.updates.push(`restored:${vals[vals.length - 1]}`)
    return Promise.resolve([])
  }
  if (/UPDATE session_runs/.test(text)) {
    const reason = /exit_reason = '(\w+)'/.exec(text)?.[1] ?? 'unknown'
    s.updates.push(`${reason}:${vals[vals.length - 1]}`)
    return Promise.resolve([])
  }
  if (/FROM session_runs r/.test(text)) return Promise.resolve(s.orphans)
  if (/SELECT exit_reason/.test(text)) {
    return Promise.resolve(s.lastExitReason ? [{ exit_reason: s.lastExitReason }] : [])
  }
  return Promise.resolve([])
}

mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))
mock.module('../src/dispatch/automation-controls.ts', () => ({
  isAutomationHalted: async (a: { userId: string; sessionId?: string }) => {
    s.haltCalls.push(a)
    if (s.haltedSessions === 'all') return { halted: true, scope: 'user' }
    if (s.haltedSessions && a.sessionId && s.haltedSessions.has(a.sessionId)) return { halted: true, scope: 'session' }
    return { halted: false }
  },
}))
mock.module('../src/sessions/budget.ts', () => ({
  reserveSessionSlot: async () => ({ ok: true, run: { id: 'new-run' } }),
}))
mock.module('../src/ws/supervisor-registry.ts', () => ({
  listOnlineSupervisorIdsForUser: () => ['sup-1'],
  getSupervisor: (id: string) => ({ userId: id === 'sup-z' ? 'u9' : 'u1', ws: { send: (m: string) => s.sent.push(JSON.parse(m)) } }),
  listSupervisors: () => [{ id: 'sup-1' }, { id: 'sup-z' }],
}))
mock.module('../src/db/dal.ts', () => ({ getSessionSkipPermissionsByRepo: async () => false }))
mock.module('../src/orchestrator/auto-launch.ts', () => ({
  launchOrchestrator: async (a: any) => {
    s.orchestratorCalls.push(a)
    if (s.launchResult) return s.launchResult
    return { ok: true, sessionId: 'sess-o', runId: 'orch-run', supervisorId: 'sup-1', cwd: '/r', reused: true }
  },
}))

const { resumeOrphansForSupervisor, listOnlineSupervisorsForRelease } = await import('../src/orchestrator/orphan-resume.ts')

function orphan(id: string, sessionId: string, isOrch: boolean, restartCount = 0) {
  return {
    id,
    session_id: sessionId,
    supervisor_id: 'sup-1',
    repo_path: '/r/' + id,
    branch: null,
    restart_count: restartCount,
    started_at: new Date(),
    is_orchestrator: isOrch,
  }
}

beforeEach(() => {
  s.orphans = []
  s.lastExitReason = null
  s.updates = []
  s.haltedSessions = null
  s.haltCalls = []
  s.orchestratorCalls = []
  s.launchResult = null
  s.sent = []
})

describe('orphan-resume halt deferral', () => {
  test('halted + orchestrator orphan: no reboot UPDATE, run id in skipped_halted, nothing relaunched', async () => {
    s.orphans = [orphan('run-o', 'sess-o', true)]
    s.haltedSessions = 'all'
    const r = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(r.skipped_halted).toEqual(['run-o'])
    expect(s.updates.filter((u) => u.startsWith('reboot'))).toHaveLength(0)
    expect(s.updates.filter((u) => u.includes('run-o'))).toHaveLength(0)
    expect(s.orchestratorCalls).toHaveLength(0)
    expect(r.resumed).toHaveLength(0)
  })

  test('halted + NON-orchestrator orphan: still resumed exactly as today (predicate not consulted)', async () => {
    s.orphans = [orphan('run-p', 'sess-p', false)]
    s.haltedSessions = 'all'
    const r = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(r.resumed).toEqual(['new-run'])
    expect(r.skipped_halted).toHaveLength(0)
    expect(s.updates).toContain('reboot:run-p')
    expect(s.sent[0].type).toBe('session.start')
    expect(s.haltCalls).toHaveLength(0)
  })

  test('user_stopped and restart-cap guards run first for the orchestrator orphan (finalizations unchanged)', async () => {
    s.haltedSessions = 'all'
    s.orphans = [orphan('run-a', 'sess-o', true)]
    s.lastExitReason = 'user_stopped'
    const a = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(a.skipped_user_stopped).toEqual(['sess-o'])
    expect(a.skipped_halted).toHaveLength(0)
    expect(s.updates).toContain('user_stopped:run-a')

    s.updates = []
    s.lastExitReason = null
    s.orphans = [orphan('run-b', 'sess-o', true, 10)]
    const b = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(b.skipped_max_restarts).toEqual(['run-b'])
    expect(b.skipped_halted).toHaveLength(0)
    expect(s.updates).toContain('max_restarts_exceeded:run-b')
  })

  test('not halted: orchestrator orphan ended as reboot and relaunched with machine true', async () => {
    s.orphans = [orphan('run-o', 'sess-o', true)]
    const r = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(s.updates).toContain('reboot:run-o')
    expect(s.orchestratorCalls).toHaveLength(1)
    expect(s.orchestratorCalls[0].machine).toBe(true)
    expect(r.resumed).toEqual(['orch-run'])
    expect(r.skipped_halted).toHaveLength(0)
  })

  test('session-scope halt defers only that session orchestrator orphan, evaluated with its own ids', async () => {
    s.orphans = [orphan('run-1', 'sess-1', true), orphan('run-2', 'sess-2', true)]
    s.haltedSessions = new Set(['sess-1'])
    const r = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(r.skipped_halted).toEqual(['run-1'])
    expect(r.resumed).toEqual(['orch-run'])
    expect(s.haltCalls).toEqual([
      { userId: 'u1', sessionId: 'sess-1' },
      { userId: 'u1', sessionId: 'sess-2' },
    ])
    expect(s.updates).toContain('reboot:run-2')
    expect(s.updates).not.toContain('reboot:run-1')
  })
})

describe('listOnlineSupervisorsForRelease (release-time sweep targets)', () => {
  test('global enumerates every online supervisor with its own owner id', async () => {
    expect(await listOnlineSupervisorsForRelease({ scope: 'global', userId: 'admin' })).toEqual([
      { supervisorId: 'sup-1', userId: 'u1' },
      { supervisorId: 'sup-z', userId: 'u9' },
    ])
  })

  test('user and session scopes sweep only the releasing owner supervisors', async () => {
    for (const scope of ['user', 'session'] as const) {
      expect(await listOnlineSupervisorsForRelease({ scope, userId: 'u1' })).toEqual([{ supervisorId: 'sup-1', userId: 'u1' }])
    }
  })
})

describe('QC M1: the original orchestrator orphan is not consumed when no replacement is created', () => {
  test('a halt landing between the reboot UPDATE and the launch: the orphan is reopened and deferred', async () => {
    s.orphans = [orphan('run-o', 'sess-o', true)]
    s.launchResult = { ok: false, reason: 'automation_halted' }
    const r = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(s.updates.filter((u) => !u.startsWith('stale:'))).toEqual(['reboot:run-o', 'restored:run-o'])
    expect(r.skipped_halted).toEqual(['run-o'])
    expect(r.resumed).toHaveLength(0)
  })

  test.each(['at_capacity', 'no_online_supervisor', 'supervisor_has_no_roots'])('%s: no replacement run exists -> orphan reopened', async (reason) => {
    s.orphans = [orphan('run-o', 'sess-o', true)]
    s.launchResult = { ok: false, reason, running: 1, cap: 1 }
    await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(s.updates.filter((u) => !u.startsWith('stale:'))).toEqual(['reboot:run-o', 'restored:run-o'])
  })

  test.each(['send_failed', 'internal_error', 'already_running', 'disabled'])('%s: stays consumed (a replacement row may exist / user disabled)', async (reason) => {
    s.orphans = [orphan('run-o', 'sess-o', true)]
    s.launchResult = { ok: false, reason, error: 'x', sessionId: 'sess-o' }
    await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(s.updates.filter((u) => !u.startsWith('stale:'))).toEqual(['reboot:run-o'])
  })

  test('success: consumed, never reopened', async () => {
    s.orphans = [orphan('run-o', 'sess-o', true)]
    const r = await resumeOrphansForSupervisor({ userId: 'u1', supervisorId: 'sup-1' })
    expect(s.updates.filter((u) => !u.startsWith('stale:'))).toEqual(['reboot:run-o'])
    expect(r.resumed).toEqual(['orch-run'])
  })
})


/**
 * PTYCAP-08-07 Task 2 (D-21, D-22, F2-B6): the task_qc sender reserves exactly one lifetime
 * counter slot per run under taskqc:<userId> BEFORE the engine, skips (engine never starts)
 * when the counter is exhausted, releases a thrown pass, hands the engine an injected
 * kill-switch check anchored on the user only, and sends the digest even when halted.
 * Engine, controls, email and finalizeRun are mocked; no database is reachable.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'
import type { Finding, TaskQcResult } from '../src/task-qc/types.ts'

const USER = '00000000-0000-0000-0000-0000000000a1'
const RUN = 'run-77'
const TASK = { id: 'qc-task-1', user_id: USER } as any

const fake = createTaskQcFakeSql()
const events: string[] = []
const reserveCalls: any[] = []
const releaseCalls: any[] = []
const haltCalls: any[] = []
const emails: any[] = []
const finalized: any[] = []
const engineCalls: any[] = []
let reserveResult: any = { ok: true, count: 1 }
let haltResult: any = { ok: true }
let engine: (args: any) => Promise<TaskQcResult> = async () => empty()
let emailOk = true
const warns: any[] = []

mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
mock.module('../src/dispatch/automation-controls.ts', () => ({
  reserveInject: async (a: any) => {
    events.push('reserve')
    reserveCalls.push(a)
    return reserveResult
  },
  releaseInject: async (a: any) => {
    events.push('release')
    releaseCalls.push(a)
  },
  haltBeforeMachineSend: async (a: any) => {
    haltCalls.push(a)
    return haltResult
  },
}))
mock.module('../src/lib/email.ts', () => ({
  sendEmail: async (i: any) => {
    emails.push(i)
    return emailOk
  },
}))
mock.module('../src/task-qc/engine.ts', () => ({
  runTaskQcPass: async (a: any) => {
    events.push('engine')
    engineCalls.push(a)
    return engine(a)
  },
}))
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (id: string, status: string, error?: string | null, fields: any = {}) => {
    finalized.push({ id, status, error: error ?? null, ...fields })
  },
}))
mock.module('../src/observability/logger', () => ({
  log: { debug() {}, info() {}, warn: (...a: any[]) => warns.push(a), error() {} },
}))
afterAll(() => mock.restore())

const { sendTaskQcTask } = await import(`../src/scheduler/senders/task-qc.ts?counter=${Date.now()}`)

const finding = (over: Partial<Finding> = {}): Finding => ({
  detector: 'FAILING',
  taskId: 'audited-1',
  taskName: 'Nightly sweep',
  taskType: 'dev',
  severity: 'high',
  evidence: { failedRuns: 4 },
  proposal: { kind: 'propose_disable', params: { taskId: 'audited-1' } },
  ...over,
})
function empty(): TaskQcResult {
  return { findings: [], applied: [], proposals: [], truncated: false }
}
const withFinding = (): TaskQcResult => {
  const f = finding()
  return { findings: [f], applied: [], proposals: [f], truncated: false }
}

beforeEach(() => {
  fake.reset()
  fake.onSelect('FROM users', [{ email: 'owner@example.com' }])
  events.length = 0
  for (const a of [reserveCalls, releaseCalls, haltCalls, emails, finalized, engineCalls, warns]) a.length = 0
  reserveResult = { ok: true, count: 1 }
  haltResult = { ok: true }
  engine = async () => empty()
  emailOk = true
})

describe('lifetime counter reservation (D-22)', () => {
  test('reserves exactly once with the exact argument object, before the engine', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(reserveCalls).toEqual([
      { userId: USER, sessionId: `taskqc:${USER}`, token: RUN, counterKey: `taskqc:${USER}`, actor: 'task-qc' },
    ])
    expect('enforceRate' in reserveCalls[0]).toBe(false)
    expect(events).toEqual(['reserve', 'engine'])
    expect(releaseCalls).toHaveLength(0)
  })

  test('an exhausted counter finalizes skipped with the returned reason; engine never starts; no email', async () => {
    reserveResult = { ok: false, reason: 'lifetime_inject_exhausted:50>=50' }
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(engineCalls).toHaveLength(0)
    expect(emails).toHaveLength(0)
    expect(finalized).toHaveLength(1)
    expect(finalized[0]).toMatchObject({ id: RUN, status: 'skipped', error: 'lifetime_inject_exhausted:50>=50' })
    expect(releaseCalls).toHaveLength(0)
  })

  test('a counter error (fail closed) also skips before the engine', async () => {
    reserveResult = { ok: false, reason: 'lifetime_counter_error' }
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(engineCalls).toHaveLength(0)
    expect(finalized[0]).toMatchObject({ status: 'skipped', error: 'lifetime_counter_error' })
  })

  test('a thrown pass releases the same key and token; a completed pass does not', async () => {
    engine = async () => {
      throw new Error('statement timeout')
    }
    fake.onInsert(/INSERT INTO task_qc_findings/, [{ id: 'e1' }])
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(releaseCalls).toEqual([{ counterKey: `taskqc:${USER}`, token: RUN }])
    expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('engine'))
    releaseCalls.length = 0
    engine = async () => withFinding()
    await sendTaskQcTask(TASK, { runId: 'run-78', userId: USER })
    expect(releaseCalls).toHaveLength(0)
  })

  test('the sender takes no per-session rate: reservation is not rate enforced and uses the user key as the session id', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(reserveCalls[0].sessionId).toBe(reserveCalls[0].counterKey)
  })
})

describe('injected kill-switch check (D-21, F2-B6)', () => {
  test('the engine gets a halt check anchored on the user only (null session anchor)', async () => {
    engine = async (a) => {
      const r = await a.deps.haltCheck()
      expect(r).toEqual({ halted: false })
      return empty()
    }
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(haltCalls).toEqual([{ userId: USER }])
    expect('sessionId' in haltCalls[0]).toBe(false)
  })

  test('halted mid-run: the engine is told it is halted and the digest is still sent; sender writes nothing', async () => {
    haltResult = { ok: false, reason: 'automation_halted:global', scope: 'global' }
    let seen: any = null
    engine = async (a) => {
      seen = await a.deps.haltCheck()
      return withFinding()
    }
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(seen).toEqual({ halted: true })
    expect(emails).toHaveLength(1)
    expect(finalized[0]).toMatchObject({ status: 'success' })
    expect(fake.state.writes()).toHaveLength(0)
  })

  test('origin follows the trigger', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER, isManual: true })
    await sendTaskQcTask(TASK, { runId: 'r2', userId: USER })
    expect(engineCalls.map((c) => c.origin)).toEqual(['run_now', 'schedule'])
  })
})

describe('digest and finalize', () => {
  test('a run with findings sends one digest and finalizes success with counts only', async () => {
    engine = async () => withFinding()
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(emails).toHaveLength(1)
    expect(emails[0].to).toBe('owner@example.com')
    expect(finalized).toHaveLength(1)
    expect(finalized[0].status).toBe('success')
    expect(JSON.parse(finalized[0].output_snippet)).toEqual({ findings: 1, proposals: 1, digest_delivered: true })
    expect(finalized[0].only_if_active).toBe(true)
  })

  test('zero findings: zero emails, success', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(emails).toHaveLength(0)
    expect(JSON.parse(finalized[0].output_snippet)).toEqual({ findings: 0, proposals: 0, digest_delivered: false })
  })

  test('an applied fix is reported in the digest even though it is not a proposal', async () => {
    const f = finding({ detector: 'MISCONFIGURED', fixCandidate: 'normalize_timezone', proposal: { kind: 'fix_timezone', params: { taskId: 'audited-1' } } })
    engine = async () => ({
      findings: [f],
      proposals: [],
      truncated: false,
      applied: [{ finding: f, fix: 'normalize_timezone', taskId: 'audited-1', before: { timezone: 'X' }, after: { timezone: 'UTC' }, rollbackSql: "UPDATE scheduled_tasks SET timezone = 'X' WHERE id = 'audited-1'" }],
    })
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(emails).toHaveLength(1)
    expect(emails[0].text).toContain("UPDATE scheduled_tasks SET timezone = 'X'")
  })

  test('email returning false finalizes success with digest_delivered false and a warn; no retry', async () => {
    engine = async () => withFinding()
    emailOk = false
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(emails).toHaveLength(1)
    expect(finalized[0].status).toBe('success')
    expect(JSON.parse(finalized[0].output_snippet).digest_delivered).toBe(false)
    expect(warns.length).toBeGreaterThan(0)
  })
})

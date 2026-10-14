/**
 * PTYCAP-08-03 shared harness for the task_qc fire-path suites. Installs the
 * process-global mock.module set (call BEFORE the dynamic import of the
 * dispatcher) and returns the recording state. Not a test file.
 *
 * Real: dispatcher, run-claim, sender, engine, detectors, findings, digest.
 * Mocked: postgres (strict fake sql), the scheduled-tasks DAL (as in
 * scheduler-halt.test.ts: the DAL composes sql fragments the fake cannot model),
 * kill switch, threshold, cost cap, target resolution, registries, email.
 */
import { mock } from 'bun:test'
import { createTaskQcFakeSql } from './task-qc-fake-sql.ts'
import { automationControlsLeaf } from './automation-controls-leaf.ts'

export const USER = '00000000-0000-0000-0000-0000000000a1'
export const QC_ID = 'qc-task-1'
export const CONTROL_ID = 'control-1'
export const AUDITED_ID = 'audited-1'
export const OWNER_EMAIL = 'owner@example.com'

export function qcTaskRow(over: Record<string, unknown> = {}) {
  return {
    id: QC_ID,
    user_id: USER,
    session_id: null,
    name: 'Task quality audit',
    enabled: true,
    task_type: 'task_qc',
    target_kind: 'session',
    target_id: null,
    payload: {},
    timezone: 'UTC',
    schedule_rules: null,
    schedule_kind: 'cron',
    run_at: null,
    email_summary: false,
    ...over,
  }
}

export function controlTaskRow(over: Record<string, unknown> = {}) {
  return {
    id: CONTROL_ID,
    user_id: USER,
    session_id: 'sess-1',
    name: 'Control',
    enabled: true,
    task_type: 'dev',
    target_kind: 'session',
    target_id: 'sess-1',
    payload: {},
    timezone: 'UTC',
    schedule_rules: null,
    schedule_kind: 'cron',
    run_at: null,
    ...over,
  }
}

export function auditedTaskRow(over: Record<string, unknown> = {}) {
  return {
    id: AUDITED_ID,
    user_id: USER,
    name: 'Nightly sweep',
    task_type: 'dev',
    enabled: true,
    schedule_kind: 'cron',
    cron_expr: '0 3 * * *',
    cron_expression: '0 3 * * *',
    timezone: 'UTC',
    created_at: '2026-09-01T00:00:00.000Z',
    // relative to now so NEVER_FIRED stays quiet whenever the suite runs
    last_fire_at: new Date(Date.now() - 23 * 3_600_000).toISOString(),
    next_fire_at: new Date(Date.now() + 3_600_000).toISOString(),
    target_kind: 'session',
    target_id: 'sess-1',
    session_id: 'sess-1',
    prompt: 'do the thing',
    payload: {},
    teab_repo_ident: null,
    ...over,
  }
}

export function failedRuns(taskId = AUDITED_ID, n = 3) {
  return Array.from({ length: n }, (_, i) => ({
    id: `r${i + 1}`,
    task_id: taskId,
    status: 'failed',
    error: 'boom',
    started_at: new Date(Date.UTC(2026, 9, 12 - i, 3, 0, 0)).toISOString(),
    finished_at: new Date(Date.UTC(2026, 9, 12 - i, 3, 1, 0)).toISOString(),
    output_snippet: null,
  }))
}

export function setupFireHarness() {
  const fake = createTaskQcFakeSql()
  const h = {
    fake,
    tasks: {} as Record<string, any>,
    halt: { halted: false } as { halted: boolean; scope?: string },
    auditedTasks: [auditedTaskRow()] as any[],
    auditedRuns: failedRuns() as any[],
    openRuns: [] as any[],
    /** rows the audit-session SELECT yields (the audited task's session is live by default) */
    sessionRows: [] as any[],
    /** rows the findings INSERT ... RETURNING yields ([] = ON CONFLICT DO NOTHING) */
    findingRows: [{ id: 'finding-1' }] as any[],
    claimed: [] as any[],
    insertedRuns: [] as any[],
    finalized: [] as Array<{ id: string; status: string; error: string | null; output_snippet: string | null }>,
    timestampCalls: [] as string[],
    emails: [] as any[],
    /** what sendEmail returns (false simulates a failed digest send) */
    emailOk: true,
    broadcasts: [] as any[],
    afterRunCalls: [] as any[],
    getTaskCalls: [] as string[],
    listActionsCalls: 0,
    /** rows listActionsForTask yields (malformed-data tests) */
    actionRows: [] as any[],
    thresholdCalls: 0,
    costCapCalls: 0,
    resolveTargetsCalls: 0,
    /** optional gate the audited-task SELECT awaits (concurrency test) */
    engineGate: null as null | Promise<void>,
    /** lifetime-counter reservations the sender made, and what reserveInject answers */
    reservations: [] as any[],
    reserveResult: { ok: true, count: 1 } as any,
    /** rows listEnabledTasks yields (registry loadAll / catchup suites, PTYCAP-08-08) */
    enabledTasks: [] as any[],
  }

  const reset = () => {
    fake.reset()
    h.tasks = { [QC_ID]: qcTaskRow(), [CONTROL_ID]: controlTaskRow() }
    h.halt = { halted: false }
    h.auditedTasks = [auditedTaskRow()]
    h.auditedRuns = failedRuns()
    h.openRuns = []
    h.sessionRows = [{ id: 'sess-1', status: 'online', deleted_at: null, last_activity: null, created_at: null, repo_key: null }]
    h.findingRows = [{ id: 'finding-1' }]
    h.claimed = []
    h.insertedRuns = []
    h.finalized = []
    h.timestampCalls = []
    h.emails = []
    h.emailOk = true
    h.broadcasts = []
    h.afterRunCalls = []
    h.getTaskCalls = []
    h.listActionsCalls = 0
    h.actionRows = []
    h.thresholdCalls = 0
    h.costCapCalls = 0
    h.resolveTargetsCalls = 0
    h.engineGate = null
    h.reservations = []
    h.reserveResult = { ok: true, count: 1 }
    h.enabledTasks = []

    fake.onSelect('FROM users', [{ email: OWNER_EMAIL }])
    fake.onSelect(/FROM scheduled_tasks WHERE user_id/, (async () => {
      if (h.engineGate) await h.engineGate
      return h.auditedTasks
    }) as any)
    fake.onSelect(/ROW_NUMBER/, () => h.auditedRuns)
    fake.onSelect(/FROM sessions WHERE user_id/, () => h.sessionRows)
    fake.onSelect(/FROM scheduled_task_runs WHERE task_id = \? AND status IN/, () => h.openRuns)
    fake.onInsert(/INSERT INTO scheduled_task_runs/, (values) => {
      const row = { id: `claim-${h.claimed.length + 1}`, task_id: values[0], user_id: values[1], status: 'pending' }
      h.claimed.push(row)
      h.openRuns.push({ id: row.id })
      return [row]
    })
    fake.onInsert(/INSERT INTO task_qc_findings/, () => h.findingRows)
    fake.on(/^UPDATE task_qc_findings SET digest_sent_at/, [])
  }
  reset()

  mock.module('../../src/db/postgres.ts', () => ({ sql: fake.sql }))
  mock.module('../../src/dispatch/automation-controls.ts', () => ({
    ...automationControlsLeaf(),
    isAutomationHalted: async () => (h.halt.halted ? { halted: true, scope: h.halt.scope ?? 'global' } : { halted: false }),
    // PTYCAP-08-07: the sender reserves one lifetime slot per run and injects a kill-switch check
    reserveInject: async (a: any) => { h.reservations.push(a); return h.reserveResult },
    haltBeforeMachineSend: async () =>
      h.halt.halted ? { ok: false, reason: `automation_halted:${h.halt.scope ?? 'global'}`, scope: h.halt.scope ?? 'global' } : { ok: true },
  }))
  mock.module('../../src/db/scheduled-tasks-dal.ts', () => ({
    listEnabledTasks: async () => h.enabledTasks,
    getTaskById: async (id: string) => { h.getTaskCalls.push(id); return h.tasks[id] ?? null },
    listActionsForTask: async () => { h.listActionsCalls++; return h.actionRows },
    getRun: async () => null,
    findQcReviewSnippetForRun: async () => null,
    insertRunV2: async (input: any) => {
      const run = { id: `run-${h.insertedRuns.length + 1}`, ...input }
      h.insertedRuns.push(run)
      return run
    },
    updateRunStatus: async (id: string, f: any) => {
      h.finalized.push({ id, status: f.status, error: f.error ?? null, output_snippet: f.output_snippet ?? null })
      h.openRuns = h.openRuns.filter((r) => r.id !== id)
      return { id, user_id: USER, task_id: QC_ID }
    },
    setTaskFireTimestamps: async (id: string) => { h.timestampCalls.push(id) },
    countFiresForTask: async () => 0,
    disableTaskWithReason: async () => {},
    claimOnceTask: async () => true,
    rearmOnceTask: async () => true,
  }))
  mock.module('../../src/usage/threshold.ts', () => ({
    checkUserThreshold: async () => { h.thresholdCalls++; return { allowed: true } },
  }))
  mock.module('../../src/dispatch/gates.ts', () => ({ isOverCostCap: async () => { h.costCapCalls++; return false } }))
  mock.module('../../src/scheduler/targets.ts', () => ({ resolveTargets: async () => { h.resolveTargetsCalls++; return [] } }))
  mock.module('../../src/ws/registry.ts', () => ({
    broadcastScheduledRun: (_u: string, ev: any) => { h.broadcasts.push(ev) },
    broadcastToUser: () => {},
    broadcastToSubscribers: () => {},
    getChannel: () => null,
  }))
  mock.module('../../src/scheduler/registry.ts', () => ({ unregister: () => {}, nextRunFor: () => null }))
  mock.module('../../src/lib/email.ts', () => ({
    sendEmail: async (input: any) => { h.emails.push(input); return h.emailOk },
  }))

  return { h, reset }
}

export const flush = () => new Promise((r) => setTimeout(r, 20))

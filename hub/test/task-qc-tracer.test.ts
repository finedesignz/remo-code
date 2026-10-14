/**
 * PTYCAP-08-03 Task 1 TRACER: a flag-on task_qc cron fire claims ONE null-session
 * run, audits a seeded failing task through the FAILING detector, writes one
 * proposed finding, sends exactly one digest email, performs zero auditor writes
 * to scheduled_tasks and finalizes the run success. Production code end to end;
 * only the database, transports and kill switch are faked.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { setupFireHarness, flush, QC_ID, USER, AUDITED_ID, OWNER_EMAIL, failedRuns } from './fixtures/task-qc-fire-harness.ts'

const { h, reset } = setupFireHarness()
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async (input: any) => { h.afterRunCalls.push(input) },
}))

const { fire } = await import('../src/scheduler/dispatcher.ts')
const { runTaskQcPass } = await import('../src/task-qc/engine.ts')
const { claimTaskQcRun } = await import('../src/task-qc/run-claim.ts')

beforeEach(() => {
  reset()
  process.env.REMO_TASK_QC_ENABLED = '1'
})
afterEach(() => {
  delete process.env.REMO_TASK_QC_ENABLED
})
afterAll(() => mock.restore())

const inserts = (re: RegExp) => h.fake.state.statements.filter((s) => s.kind === 'insert' && re.test(s.text))

describe('task_qc tracer (flag on)', () => {
  test('a cron fire yields one null-session run, one finding, one digest email, zero scheduled_tasks writes', async () => {
    await fire(QC_ID)
    await flush()

    // exactly one claimed null-session pending run
    const runInserts = inserts(/INSERT INTO scheduled_task_runs/)
    expect(runInserts).toHaveLength(1)
    expect(runInserts[0]!.text).toContain("'pending'")
    expect(runInserts[0]!.text).toMatch(/VALUES \( \?, \?, NULL, 'pending'/)
    expect(h.claimed).toHaveLength(1)
    expect(h.fake.state.lockCalls).toBe(1)
    expect(h.insertedRuns).toHaveLength(0) // the claim, not insertRunV2, created the run

    // exactly one proposed FAILING finding with sig + day
    const findingInserts = inserts(/INSERT INTO task_qc_findings/)
    expect(findingInserts).toHaveLength(1)
    const v = findingInserts[0]!.values
    expect(v).toContain('FAILING')
    expect(v).toContain('proposed')
    expect(v.some((x: any) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x))).toBe(true)
    expect(v.some((x: any) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x))).toBe(true)

    // exactly one digest email naming the audited task and a proposal
    expect(h.emails).toHaveLength(1)
    expect(h.emails[0].to).toBe(OWNER_EMAIL)
    expect(h.emails[0].text).toContain('Nightly sweep')
    expect(h.emails[0].text).toContain(AUDITED_ID)
    expect(h.emails[0].text).toMatch(/propos/i)

    // zero UPDATE scheduled_tasks (the auditor writes nothing; fire timestamps go through the mocked DAL helper)
    expect(h.fake.state.updatesTo('scheduled_tasks')).toHaveLength(0)
    expect(h.timestampCalls).toEqual([QC_ID])
    // nothing touches messages / token_usage
    expect(h.fake.state.statements.filter((s) => /\b(messages|token_usage)\b/.test(s.text))).toHaveLength(0)

    // finalized success with a counts-only snippet
    expect(h.finalized).toHaveLength(1)
    expect(h.finalized[0]!.status).toBe('success')
    const snippet = JSON.parse(h.finalized[0]!.output_snippet as string)
    expect(snippet).toEqual({ findings: 1, proposals: 1, digest_delivered: true })

    // generic gates never ran for task_qc
    expect(h.thresholdCalls).toBe(0)
    expect(h.costCapCalls).toBe(0)
    expect(h.resolveTargetsCalls).toBe(0)
    h.fake.assertNoUnknown()
  })

  test('zero findings: run finalizes success, zero emails', async () => {
    h.auditedRuns = failedRuns().map((r) => ({ ...r, status: 'success', error: null }))
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(0)
    expect(h.finalized[0]!.status).toBe('success')
    expect(JSON.parse(h.finalized[0]!.output_snippet as string)).toEqual({ findings: 0, proposals: 0, digest_delivered: false })
    expect(inserts(/INSERT INTO task_qc_findings/)).toHaveLength(0)
  })

  test('zero audited tasks: success, zero emails', async () => {
    h.auditedTasks = []
    h.auditedRuns = []
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(0)
    expect(h.finalized[0]!.status).toBe('success')
  })

  test('an already-recorded finding (idempotent conflict) sends no second email', async () => {
    h.findingRows = []
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(0)
    expect(h.finalized[0]!.status).toBe('success')
  })
})

describe('digest delivery marks findings (QC round 1: failed send / same-day rerun must not lose findings)', () => {
  const marks = () => h.fake.state.updatesTo('task_qc_findings')

  test('proposals are recorded report-until-delivered (ON CONFLICT re-returns an undelivered row)', async () => {
    await fire(QC_ID)
    await flush()
    const ins = inserts(/INSERT INTO task_qc_findings/)[0]!
    expect(ins.text).toMatch(/DO UPDATE SET .* WHERE task_qc_findings\.digest_sent_at IS NULL RETURNING id/)
  })

  test('a delivered digest marks exactly the reported rows as sent', async () => {
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(1)
    expect(marks()).toHaveLength(1)
    expect(marks()[0]!.values).toContainEqual(['finding-1'])
    expect(marks()[0]!.values).toContain(USER)
  })

  test('a failed digest send marks NOTHING as mailed, so the next run reports the findings again', async () => {
    h.emailOk = false
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(1)
    expect(marks()).toHaveLength(0)
    expect(JSON.parse(h.finalized[0]!.output_snippet as string).digest_delivered).toBe(false)
  })

  test('a row already delivered (conflict returns no row) is neither re-mailed nor re-marked', async () => {
    h.findingRows = []
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(0)
    expect(marks()).toHaveLength(0)
  })
})

describe('round 2: the digest send and the delivery mark share the run deadline', () => {
  const realNow = Date.now

  afterEach(() => {
    Date.now = realNow
  })

  test('the email request is bounded by the time left in the pass', async () => {
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(1)
    expect(h.emails[0].timeoutMs).toBeGreaterThan(0)
    expect(h.emails[0].timeoutMs).toBeLessThanOrEqual(60_000)
  })

  test('the delivery mark runs in a transaction with its own statement_timeout', async () => {
    await fire(QC_ID)
    await flush()
    const st = h.fake.state.statements
    const at = st.findIndex((s) => s.kind === 'update' && /task_qc_findings/.test(s.text))
    expect(at).toBeGreaterThan(0)
    expect(st[at - 1]!.kind).toBe('set_local')
    expect(st[at - 1]!.text).toMatch(/^SET LOCAL statement_timeout = \d+$/)
  })

  test('a run whose pass used its whole budget starts no email and marks nothing; the run still finalizes', async () => {
    // the wall clock jumps past the deadline once the pass has recorded its finding
    Date.now = () =>
      realNow() + (h.fake.state.statements.some((s) => s.kind === 'insert' && /INSERT INTO task_qc_findings/.test(s.text)) ? 10 * 60_000 : 0)
    await fire(QC_ID)
    await flush()
    expect(h.emails).toHaveLength(0)
    expect(h.fake.state.updatesTo('task_qc_findings')).toHaveLength(0)
    expect(h.finalized[0]!.status).toBe('success')
    expect(JSON.parse(h.finalized[0]!.output_snippet as string).digest_delivered).toBe(false)
  })
})

describe('runTaskQcPass final signature', () => {
  test('returns { findings, applied, proposals, truncated } with applied empty; scope narrows only', async () => {
    const res = await runTaskQcPass({ userId: USER, origin: 'schedule' })
    expect(Object.keys(res).sort()).toEqual(['applied', 'findings', 'proposals', 'recordedIds', 'truncated'])
    expect(res.applied).toEqual([])
    expect(res.findings).toHaveLength(1)
    expect(res.proposals).toHaveLength(1)
    expect(res.truncated).toBe(false)

    const none = await runTaskQcPass({ userId: USER, origin: 'run_now', scope: { taskIds: ['someone-else'] } })
    expect(none.findings).toHaveLength(0)
    const noDet = await runTaskQcPass({ userId: USER, origin: 'run_now', scope: { detectors: ['OPTIMIZE'] } })
    expect(noDet.findings).toHaveLength(0)
  })
})

describe('claimTaskQcRun', () => {
  test('takes the advisory lock first, then inserts; returns null while any run is non-terminal', async () => {
    const first = await claimTaskQcRun({ taskId: QC_ID, userId: USER, scheduledFor: new Date() })
    expect(first).not.toBeNull()
    const kinds = h.fake.state.statements.map((s) => s.kind)
    expect(kinds[0]).toBe('lock')
    expect(h.fake.state.statements[0]!.text).toContain('pg_advisory_xact_lock')
    expect(h.fake.state.statements[0]!.values[0]).toBe(`taskqc:${USER}`)
    expect(kinds.indexOf('lock')).toBeLessThan(kinds.indexOf('insert'))
    expect(h.fake.state.beginCalls).toBe(1)

    // first run still open -> second claim is refused and inserts nothing
    const second = await claimTaskQcRun({ taskId: QC_ID, userId: USER, scheduledFor: new Date() })
    expect(second).toBeNull()
    expect(inserts(/INSERT INTO scheduled_task_runs/)).toHaveLength(1)
  })

  test('the open-run probe only counts runs with no finish/completion timestamp', async () => {
    await claimTaskQcRun({ taskId: QC_ID, userId: USER, scheduledFor: new Date() })
    const probe = h.fake.state.statements.find((s) => s.kind === 'select')!
    expect(probe.text).toMatch(/finished_at IS NULL/)
    expect(probe.text).toMatch(/completed_at IS NULL/)
    expect(probe.text).toMatch(/status IN \('running', ?'pending', ?'in_flight'\)/)
  })
})

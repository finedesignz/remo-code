/**
 * PTYCAP-08-07 Task 2 (D-20, T-08-34/35/37): a thrown engine pass is never silent -- ONE plain
 * failure email per user per UTC day (ENGINE claim row), the run finalizes failed with a typed
 * code, and the raw exception text never reaches the email.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'
import { createTaskQcFakeSql } from './fixtures/task-qc-fake-sql.ts'

const USER = '00000000-0000-0000-0000-0000000000a1'
const RUN = 'run-91'
const TASK = { id: 'qc-task-1', user_id: USER } as any
const SECRET_MESSAGE = 'password authentication failed for user admin, password=hunter2, host=db.internal'

const fake = createTaskQcFakeSql()
const emails: any[] = []
const finalized: any[] = []
const errors: any[] = []
const warns: any[] = []
let thrown: unknown = new Error(SECRET_MESSAGE)
let sendImpl: (i: any) => Promise<boolean> = async () => true

mock.module('../src/db/postgres.ts', () => ({ sql: fake.sql }))
mock.module('../src/dispatch/automation-controls.ts', () => ({
  reserveInject: async () => ({ ok: true, count: 1 }),
  releaseInject: async () => {},
  haltBeforeMachineSend: async () => ({ ok: true }),
}))
mock.module('../src/lib/email.ts', () => ({
  sendEmail: async (i: any) => {
    emails.push(i)
    return sendImpl(i)
  },
}))
mock.module('../src/task-qc/engine.ts', () => ({
  runTaskQcPass: async () => {
    throw thrown
  },
}))
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (id: string, status: string, error?: string | null, fields: any = {}) => {
    finalized.push({ id, status, error: error ?? null, ...fields })
  },
}))
mock.module('../src/observability/logger', () => ({
  log: { debug() {}, info() {}, warn: (...a: any[]) => warns.push(a), error: (...a: any[]) => errors.push(a) },
}))
afterAll(() => mock.restore())

const { sendTaskQcTask } = await import(`../src/scheduler/senders/task-qc.ts?failure=${Date.now()}`)

let claimFirst = true
beforeEach(() => {
  fake.reset()
  fake.onSelect('FROM users', [{ email: 'owner@example.com' }])
  claimFirst = true
  fake.onInsert(/INSERT INTO task_qc_findings/, () => (claimFirst ? [{ id: 'eng-1' }] : []))
  for (const a of [emails, finalized, errors, warns]) a.length = 0
  thrown = new Error(SECRET_MESSAGE)
  sendImpl = async () => true
})

const utcToday = () => new Date().toISOString().slice(0, 10)

describe('engine failure visibility (D-20)', () => {
  test('first failure of the UTC day: one ENGINE claim row, one plain email, run failed with a typed code', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    const claims = fake.state.writes().filter((s) => /INSERT INTO task_qc_findings/.test(s.text))
    expect(claims).toHaveLength(1)
    expect(claims[0]!.values).toContain('ENGINE')
    expect(claims[0]!.values).toContain(USER)
    expect(claims[0]!.values).toContain(TASK.id)
    expect(claims[0]!.values).toContain(utcToday())
    expect(emails).toHaveLength(1)
    expect(emails[0].to).toBe('owner@example.com')
    expect(emails[0].text).toContain(RUN)
    expect(emails[0].text).toContain(TASK.id)
    expect(emails[0].text).toContain('engine_error')
    expect(finalized).toHaveLength(1)
    expect(finalized[0]).toMatchObject({ id: RUN, status: 'failed', error: 'task_qc_engine_error:engine_error' })
  })

  test('the raw exception message never appears in the email (text or html) or the run error', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    for (const part of [emails[0].text, emails[0].html, emails[0].subject, finalized[0].error]) {
      expect(part).not.toContain('hunter2')
      expect(part).not.toContain('db.internal')
      expect(part).not.toContain('authentication')
    }
  })

  test('the raw message is logged at error level only', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(JSON.stringify(errors)).toContain('hunter2')
    expect(JSON.stringify(warns)).not.toContain('hunter2')
  })

  test('a second failure the same UTC day sends no email but still finalizes failed', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    claimFirst = false
    await sendTaskQcTask(TASK, { runId: 'run-92', userId: USER })
    expect(emails).toHaveLength(1)
    expect(finalized.map((f) => [f.id, f.status])).toEqual([[RUN, 'failed'], ['run-92', 'failed']])
  })

  const codes: Array<[string, string]> = [
    ['canceling statement due to statement timeout', 'statement_timeout'],
    ['halt_check_required', 'halt_check_required'],
    ['connect ECONNREFUSED 127.0.0.1:5432', 'db_unavailable'],
    ['terminating connection due to administrator command', 'db_unavailable'],
    ['TypeError: x is not a function', 'engine_error'],
  ]
  for (const [message, code] of codes) {
    test(`maps "${message}" to the typed code ${code}`, async () => {
      thrown = new Error(message)
      await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
      expect(finalized[0].error).toBe(`task_qc_engine_error:${code}`)
      expect(emails[0].text).toContain(code)
      expect(emails[0].text).not.toContain(message === code ? '\u0000' : message)
    })
  }

  test('a non-Error throw maps to engine_error', async () => {
    thrown = 'a string with secret=abc123'
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(finalized[0].error).toBe('task_qc_engine_error:engine_error')
    expect(emails[0].text).not.toContain('abc123')
  })

  test('a throw inside the failure email path is caught and the run still finalizes failed', async () => {
    sendImpl = async () => {
      throw new Error('smtp exploded')
    }
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(finalized).toHaveLength(1)
    expect(finalized[0]).toMatchObject({ status: 'failed', error: 'task_qc_engine_error:engine_error' })
  })

  test('a failing claim insert sends no email, is logged, and the run still finalizes failed', async () => {
    fake.failOn(/INSERT INTO task_qc_findings/, new Error('claim insert down'))
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(emails).toHaveLength(0)
    expect(finalized).toHaveLength(1)
    expect(finalized[0].status).toBe('failed')
    expect(errors.length).toBeGreaterThan(0)
  })

  test('the failure email is plain: no digest content, no task text', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(emails[0].subject).toMatch(/^Task quality audit failed/)
    expect([...emails[0].text].every((c: string) => c === '\n' || (c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126))).toBe(true)
  })
})

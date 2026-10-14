/**
 * PTYCAP-08 repair (post-BLOCKED): the task_qc sender's whole-run deadline is HARD. It starts at run
 * claim, the pooled-connection wait is raced against it, the remaining time is re-evaluated inside the
 * acquired transaction callback (no write after expiry), and the run is always finalized.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

const realFlags = await import('../src/task-qc/flags.ts')
const BUDGET = 300
const realClamp = realFlags.clampBounds
const realFlagsCopy = { ...realFlags }
mock.module('../src/task-qc/flags.ts', () => ({
  ...realFlagsCopy,
  clampBounds: (r: any = {}) => ({ ...realClamp(r), passTimeoutMs: BUDGET }),
}))

const USER = '00000000-0000-0000-0000-0000000000b1'
const RUN = 'run-dl-1'
const TASK = { id: 'qc-task-dl', user_id: USER } as any

const finalized: any[] = []
const stmts: string[] = []
const released: any[] = []
let beginDelayMs = 0
let selectDelayMs = 0
let reserveDelayMs = 0

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function fakeSql(strings: TemplateStringsArray) {
  const text = strings.join('?')
  stmts.push(text)
  return (async () => {
    if (/FROM users/.test(text)) {
      await sleep(selectDelayMs)
      return [{ email: 'owner@example.com' }]
    }
    return []
  })()
}
fakeSql.begin = async (cb: (tx: any) => Promise<any>) => {
  await sleep(beginDelayMs)
  const tx: any = (s: TemplateStringsArray) => {
    stmts.push('TX:' + s.join('?'))
    return Promise.resolve([])
  }
  tx.unsafe = async (t: string) => {
    stmts.push('TX:' + t)
    return []
  }
  return cb(tx)
}

mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))
mock.module('../src/dispatch/automation-controls.ts', () => ({
  reserveInject: async () => {
    await sleep(reserveDelayMs)
    return { ok: true, count: 1 }
  },
  releaseInject: async (a: any) => {
    released.push(a)
  },
  haltBeforeMachineSend: async () => ({ ok: true }),
}))
mock.module('../src/lib/email.ts', () => ({ sendEmail: async () => true }))
const finding = { kind: 'x' }
mock.module('../src/task-qc/engine.ts', () => ({
  runTaskQcPass: async () => ({
    findings: [finding],
    proposals: [finding],
    applied: [],
    truncated: false,
    recorded: [{ id: 'f1', finding }],
  }),
}))
mock.module('../src/task-qc/digest.ts', () => ({
  deliverDigest: async () => ({ delivered: true, shown: [finding] }),
}))
mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (id: string, status: string, error?: string | null, fields: any = {}) => {
    finalized.push({ id, status, error: error ?? null, ...fields })
  },
}))
mock.module('../src/observability/logger', () => ({ log: { debug() {}, info() {}, warn() {}, error() {} } }))
afterAll(() => mock.restore())

const { sendTaskQcTask } = await import(`../src/scheduler/senders/task-qc.ts?deadline=${Date.now()}`)

beforeEach(() => {
  finalized.length = 0
  stmts.length = 0
  released.length = 0
  beginDelayMs = selectDelayMs = reserveDelayMs = 0
})

const updates = () => stmts.filter((s) => /UPDATE task_qc_findings/.test(s))

describe('task_qc sender whole-run deadline', () => {
  test('normal path unchanged: findings marked delivered, run finalized success', async () => {
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(updates()).toHaveLength(1)
    expect(stmts.some((s) => /SET LOCAL statement_timeout = \d+/.test(s))).toBe(true)
    expect(finalized).toHaveLength(1)
    expect(finalized[0].status).toBe('success')
  })

  test('slow pool acquisition past the deadline: no finding write, run still finalized', async () => {
    const budget = BUDGET
    beginDelayMs = budget + 400
    const t0 = Date.now()
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    await sleep(500) // let the late connection arrive; it must issue nothing
    expect(updates()).toHaveLength(0)
    expect(finalized).toHaveLength(1)
    expect(finalized[0].status).toBe('success')
    // the sender did not wait for the acquisition
    expect(Date.now() - t0).toBeLessThan(budget + 400 + 400)
  })

  test('slow recipient read past the deadline: run finalized failed, engine never started', async () => {
    selectDelayMs = BUDGET + 300
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(finalized).toHaveLength(1)
    expect(finalized[0].status).toBe('failed')
    expect(finalized[0].error).toBe('task_qc_engine_error:statement_timeout')
    expect(updates()).toHaveLength(0)
  })

  test('slow reservation past the deadline: run finalized failed and the late slot is released', async () => {
    reserveDelayMs = BUDGET + 300
    await sendTaskQcTask(TASK, { runId: RUN, userId: USER })
    expect(finalized).toHaveLength(1)
    expect(finalized[0].status).toBe('failed')
    await sleep(500)
    expect(released).toEqual([{ counterKey: `taskqc:${USER}`, token: RUN }])
  })
})

/**
 * TEAB end-to-end flow test (Milestone TEAB / Phase TEAB-08, success criterion #1).
 *
 * Drives the FULL TEAB wire with a mock supervisor socket — no real
 * `teab`/`claude`, no live Postgres, no live WS. Unlike the per-unit coverage
 * (teab-sender.test.ts proves routing; teab-poll.test.ts proves the poll loop in
 * isolation), this test wires the REAL dispatcher AND the REAL teab sender +
 * poll loop together and pushes a single due task all the way to a finalized run
 * with the post-run pipeline invoked:
 *
 *   due `task_type:'teab'` task (online supervisor for its `teab_repo_ident`)
 *     → dispatcher routes to `sendTeabTask`
 *     → a `run_command {command:'teab_run', args:[repoIdent]}` lands on that
 *       supervisor socket
 *     → the mock supervisor replies with the started-ack (internal teab run id),
 *       then `teab_status` polls return `running`, then `exited{exit_code:0}`
 *     → the REAL `finalizeRun(success=true)` fires exactly once
 *     → the post-run action pipeline (`afterRun`) is invoked exactly once
 *     → `teab_last_status` mirrors the terminal state.
 *
 * Negative path: `exited{exit_code:1}` → `finalizeRun(success=false)` + a single
 * `afterRun` with status `failed`.
 *
 * Determinism: poll cadence + max-run ceiling are set huge so the production
 * `setInterval` never fires mid-test; every supervisor reply is driven
 * explicitly through `handleTeabRunEvent` (the same seam `ws/agent.ts` calls on a
 * real run-event). NO wall-clock sleeps. Terminal-once is asserted directly.
 *
 * Bun mock.module hygiene (project memory feedback_bun_mock_pollution):
 * afterAll(mock.restore); this file is run in its own process by check-baseline.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

// Production interval/ceiling set huge so the real setInterval never fires and
// the deadline never lapses mid-test; replies are driven explicitly.
process.env.REMO_TEAB_POLL_INTERVAL_MS = '999999999'
process.env.REMO_TEAB_MAX_RUN_MS = '999999999'

const state: {
  task: any
  inserted: Array<{ status: string; error: string | null }>
  runStatusUpdates: Array<{ runId: string; fields: any }>
  frames: any[]
  frameCursor: number
  lastStatuses: string[]
  afterRunCalls: Array<{ runId: string; status: string; error: string | null }>
  online: string[]
  capExceeded: boolean
  thresholdAllowed: boolean
} = {
  task: null,
  inserted: [],
  runStatusUpdates: [],
  frames: [],
  frameCursor: 0,
  lastStatuses: [],
  afterRunCalls: [],
  online: ['sup-1'],
  capExceeded: false,
  thresholdAllowed: true,
}

let runSeq = 0

// ── leaf-dep mocks (everything except dispatcher.ts + senders/teab.ts) ────────
mock.module('../src/db/postgres.ts', () => ({
  // Tagged-template `sql`. setTeabLastStatus interpolates the status FIRST
  // (`teab_last_status = ${status}`), so vals[0] is the mirrored status word.
  // The dispatch-time `teab_last_status = 'started'` UPDATE uses a literal, so
  // its only interpolated value is task.id — harmless noise we filter out below.
  sql: (_strings: TemplateStringsArray, ...vals: any[]) => {
    if (vals.length > 0) state.lastStatuses.push(String(vals[0]))
    return Promise.resolve([])
  },
}))

const realDal = await import(`../src/db/scheduled-tasks-dal.ts?bust=${Date.now()}`)
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realDal,
  getTaskById: async (id: string) => (state.task && state.task.id === id ? state.task : null),
  insertRunV2: async (input: any) => {
    state.inserted.push({ status: input.status, error: input.error ?? null })
    return { id: `run-${++runSeq}`, user_id: input.user_id, task_id: input.task_id }
  },
  updateRunStatus: async (runId: string, fields: any) => {
    state.runStatusUpdates.push({ runId, fields })
    return { id: runId, user_id: 'user-1', task_id: state.task?.id ?? 'task-1' }
  },
  setTaskFireTimestamps: async () => {},
  countFiresForTask: async () => 0,
  disableTaskWithReason: async () => {},
}))

mock.module('../src/dispatch/gates.ts', () => ({
  isOverCostCap: async () => state.capExceeded,
}))

mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => ({
    allowed: state.thresholdAllowed,
    reason: 'five_hour',
    utilization_pct: 10,
    threshold_pct: 90,
  }),
}))

mock.module('../src/ws/registry.ts', () => ({
  getChannel: () => null,
  broadcastScheduledRun: () => {},
  broadcastToUser: () => {},
  broadcastToSubscribers: () => {},
}))

mock.module('../src/ws/supervisor-registry.ts', () => ({
  listOnlineSupervisorIdsForUser: () => state.online,
  getSupervisor: (id: string) =>
    state.online.includes(id)
      ? { ws: { send: (f: string) => state.frames.push(JSON.parse(f)) } }
      : undefined,
  getUserInventory: () => undefined,
}))

// Post-run action pipeline — capture every invocation so we can prove it fires
// exactly once on the terminal state (the whole point of the e2e: a teab build
// finishing actually triggers the email/telegram/webhook fan-out).
mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
  afterRun: async (input: any) => {
    state.afterRunCalls.push({ runId: input.runId, status: input.status, error: input.error ?? null })
  },
}))

mock.module('../src/observability/logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

// Import AFTER mocks. Dispatcher + teab sender/poll are BOTH real (same module
// instance the dispatcher dynamically imports).
const { runNow } = await import('../src/scheduler/dispatcher.ts')
const teab = await import('../src/scheduler/senders/teab.ts')

const REPO = 'github://finedesignz/titanium-edge-autobuilder'
const TEAB_TASK = (over: any = {}) => ({
  id: 'task-teab-1',
  user_id: 'user-1',
  task_type: 'teab',
  teab_repo_ident: REPO,
  timezone: 'America/Los_Angeles',
  payload: {},
  schedule_rules: [],
  enabled: true,
  ...over,
})

// Mock supervisor reply builders (mirror the TEAB-01 wire contract).
const ack = (runId: string, teabRunId: string) => ({
  type: 'run_finished',
  run_id: runId,
  exit_code: 0,
  snippet: JSON.stringify({ run_id: teabRunId, started: true, pid: 4242 }),
})
const statusReply = (runId: string, stateVal: string, exitCode: number | null = null) => ({
  type: 'run_finished',
  run_id: runId,
  exit_code: 0,
  snippet: JSON.stringify({ state: stateVal, exit_code: exitCode, events_tail: [`evt-${stateVal}`] }),
})

// Flush pending microtasks so the dispatcher's `void sendTeabTask(...)` (and its
// resolved-promise awaits) settle before we inspect the supervisor socket.
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }

beforeEach(() => {
  state.inserted = []
  state.runStatusUpdates = []
  state.frames = []
  state.frameCursor = 0
  state.lastStatuses = []
  state.afterRunCalls = []
  state.online = ['sup-1']
  state.capExceeded = false
  state.thresholdAllowed = true
  state.task = TEAB_TASK()
  runSeq = 0
  teab._resetTeabPolls()
})

afterAll(() => {
  teab._resetTeabPolls()
  mock.restore()
})

/** The emitted scheduled-run id (the run_command run_id == finalize key). */
function dispatchedRunId(): string {
  const frame = state.frames.find((f) => f.command === 'teab_run')
  expect(frame).toBeTruthy()
  return frame.run_id as string
}

describe('TEAB e2e flow (Phase TEAB-08)', () => {
  test('due teab task → run_command teab_run → poll → exited(0) → finalize success + post-run once', async () => {
    // (1) Dispatch the due task through the REAL dispatcher.
    await runNow('task-teab-1', 'user-1')
    await flush()

    // (2) Routed to the teab sender: exactly one run_command teab_run with the
    //     repo ident, NOT an agent/session user_message.
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0].status).toBe('pending')
    const teabRunFrames = state.frames.filter((f) => f.command === 'teab_run')
    expect(teabRunFrames).toHaveLength(1)
    expect(teabRunFrames[0].type).toBe('run_command')
    expect(teabRunFrames[0].args).toEqual([REPO])
    expect(typeof teabRunFrames[0].run_id).toBe('string')
    const runId = dispatchedRunId()

    // Run recorded in-flight by the sender before the build starts.
    expect(state.runStatusUpdates.some((u) => u.fields.status === 'in_flight')).toBe(true)

    // (3) Mock supervisor replies with the started-ack (internal teab run id).
    //     The ack kicks an immediate teab_status poll (real poll loop).
    await teab.handleTeabRunEvent('sup-1', 'user-1', ack(runId, 'teab_internal_1'))
    await flush()
    const statusFrame = state.frames.find((f) => f.command === 'teab_status')
    expect(statusFrame).toBeTruthy()
    expect(statusFrame.args).toEqual(['teab_internal_1'])
    expect(statusFrame.run_id).toBe(runId)

    // (4) Status polls: running, then exited(0).
    await teab.handleTeabRunEvent('sup-1', 'user-1', statusReply(runId, 'running'))
    await teab.handleTeabRunEvent('sup-1', 'user-1', statusReply(runId, 'exited', 0))
    await flush()

    // (5) finalizeRun(success) → post-run pipeline fired EXACTLY ONCE.
    expect(state.afterRunCalls).toHaveLength(1)
    expect(state.afterRunCalls[0]).toMatchObject({ runId, status: 'success', error: null })

    // (6) teab_last_status mirrored terminal success across the poll.
    expect(state.lastStatuses).toContain('running')
    expect(state.lastStatuses).toContain('exited')

    // Poll cleaned up — no leaked timer/registry entry.
    expect(teab._getTeabPoll(runId)).toBeUndefined()

    // Terminal-once: a late stray status reply must NOT double-finalize.
    const handled = await teab.handleTeabRunEvent('sup-1', 'user-1', statusReply(runId, 'exited', 0))
    await flush()
    expect(handled).toBe(false)
    expect(state.afterRunCalls).toHaveLength(1)
  })

  test('negative path: exited(1) → finalize failed + a single post-run with status failed', async () => {
    await runNow('task-teab-1', 'user-1')
    await flush()
    const runId = dispatchedRunId()

    await teab.handleTeabRunEvent('sup-1', 'user-1', ack(runId, 'teab_internal_2'))
    await flush()
    await teab.handleTeabRunEvent('sup-1', 'user-1', statusReply(runId, 'exited', 1))
    await flush()

    // finalizeRun(failed) fired the post-run pipeline exactly once.
    expect(state.afterRunCalls).toHaveLength(1)
    expect(state.afterRunCalls[0]).toMatchObject({ runId, status: 'failed' })
    // The failing run row was finalized as failed with the exit-coded reason.
    const failed = state.runStatusUpdates.find((u) => u.fields.status === 'failed')
    expect(failed).toBeTruthy()
    expect(failed!.fields.error).toBe('teab_exit_1')
    expect(teab._getTeabPoll(runId)).toBeUndefined()
  })
})

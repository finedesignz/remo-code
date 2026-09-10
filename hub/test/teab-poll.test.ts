/**
 * TEAB poll-to-terminal tests (Milestone TEAB / Phase TEAB-05).
 *
 * Proves the hub-driven background poll loop drives a long TEAB run to terminal
 * WITHOUT a blocking turn (no subscriber dependency → idle-teardown-safe) and
 * fires `finalizeRun` (→ post-run action pipeline) exactly once:
 *
 *   (a) ack → status running → status exited(0) → finalizeRun(success) once.
 *   (b) status exited(≠0) → finalizeRun(failed).
 *   (c) a terminal `run_finished` short-circuits the poll; a late status reply
 *       does NOT double-finalize (terminal-once).
 *   (d) max-duration ceiling → finalize(timeout) + interval cleared.
 *   (e) `teab_last_status` is updated across polls.
 *
 * Leaf deps are mocked (supervisor ws send, DB `sql` UPDATE, the DAL, and the
 * dispatcher's `finalizeRun`) so no live Postgres / WS is needed. Ticks are
 * driven deterministically via the `_teabPollTick` test seam — NO real
 * wall-clock sleeps (the production interval is set huge so it never fires).
 *
 * Bun mock.module hygiene (feedback_bun_mock_pollution): afterAll(mock.restore);
 * this file is run in its own process by check-baseline.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

// Production interval set huge so the real setInterval never fires mid-test;
// ticks are driven explicitly via `_teabPollTick`.
process.env.REMO_TEAB_POLL_INTERVAL_MS = '999999999'

const state: {
  frames: any[]
  lastStatuses: string[]
  finalizeCalls: Array<{ runId: string; status: string; error: string | null; fields: any }>
  supervisorOnline: boolean
} = {
  frames: [],
  lastStatuses: [],
  finalizeCalls: [],
  supervisorOnline: true,
}

// ── leaf-dep mocks ──────────────────────────────────────────────────────────
mock.module('../src/db/postgres.ts', () => ({
  // Tagged-template `sql`. The only call from the poll path is the
  // `teab_last_status = ${status}` UPDATE → status is the first interpolated val.
  sql: (_strings: TemplateStringsArray, ...vals: any[]) => {
    if (vals.length > 0) state.lastStatuses.push(String(vals[0]))
    return Promise.resolve([])
  },
}))

mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  updateRunStatus: async () => ({}),
}))

mock.module('../src/ws/supervisor-registry.ts', () => ({
  listOnlineSupervisorIdsForUser: () => (state.supervisorOnline ? ['sup-1'] : []),
  getSupervisor: (id: string) =>
    state.supervisorOnline && id === 'sup-1'
      ? { ws: { send: (f: string) => state.frames.push(JSON.parse(f)) } }
      : undefined,
  getUserInventory: () => undefined,
}))

mock.module('../src/scheduler/dispatcher.ts', () => ({
  finalizeRun: async (runId: string, status: string, error: string | null, fields: any = {}) => {
    state.finalizeCalls.push({ runId, status, error: error ?? null, fields })
  },
}))

mock.module('../src/observability/logger', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}))

// Import AFTER mocks. The poll machinery is REAL.
const teab = await import('../src/scheduler/senders/teab.ts')

const ack = (runId: string, teabRunId = 'teab_1') => ({
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

beforeEach(() => {
  state.frames = []
  state.lastStatuses = []
  state.finalizeCalls = []
  state.supervisorOnline = true
  teab._resetTeabPolls()
})

afterAll(() => {
  teab._resetTeabPolls()
  mock.restore()
})

describe('TEAB poll-to-terminal (Phase TEAB-05)', () => {
  test('(a) ack → running → exited(0) finalizes success exactly once', async () => {
    const rec = teab.startTeabPoll({ runId: 'run-a', taskId: 'task-a', userId: 'u1', supervisorId: 'sup-1' })

    // started-ack: capture internal teab run id + kick an immediate status poll.
    await teab.handleTeabRunEvent('sup-1', 'u1', ack('run-a', 'teab_a'))
    expect(rec.teabRunId).toBe('teab_a')
    const statusFrame = state.frames.find((f) => f.command === 'teab_status')
    expect(statusFrame).toBeTruthy()
    expect(statusFrame.args).toEqual(['teab_a'])
    expect(statusFrame.run_id).toBe('run-a')

    // running poll, then exited(0).
    await teab.handleTeabRunEvent('sup-1', 'u1', statusReply('run-a', 'running'))
    await teab.handleTeabRunEvent('sup-1', 'u1', statusReply('run-a', 'exited', 0))

    expect(state.finalizeCalls).toHaveLength(1)
    expect(state.finalizeCalls[0]).toMatchObject({ runId: 'run-a', status: 'success', error: null })
    // poll cleaned up — no leaked timer/registry entry.
    expect(teab._getTeabPoll('run-a')).toBeUndefined()
  })

  test('(a2) finalize is claim-guarded (only_if_active) — losing the reaper race is a no-op', async () => {
    // fix/sched-qc: the stale-run reaper can race this poller on a long build.
    // Every TEAB finalize must claim-then-write, so whichever finalizer loses
    // gets no row back (WHERE … AND status IN ('pending','in_flight')) and
    // neither clobbers the terminal row nor re-fires the post-run chain.
    teab.startTeabPoll({ runId: 'run-a2', taskId: 'task-a2', userId: 'u1', supervisorId: 'sup-1' })
    await teab.handleTeabRunEvent('sup-1', 'u1', ack('run-a2'))
    await teab.handleTeabRunEvent('sup-1', 'u1', statusReply('run-a2', 'exited', 0))

    expect(state.finalizeCalls).toHaveLength(1)
    expect(state.finalizeCalls[0].fields.only_if_active).toBe(true)
  })

  test('(b) exited(non-zero) finalizes failed', async () => {
    teab.startTeabPoll({ runId: 'run-b', taskId: 'task-b', userId: 'u1', supervisorId: 'sup-1' })
    await teab.handleTeabRunEvent('sup-1', 'u1', ack('run-b'))
    await teab.handleTeabRunEvent('sup-1', 'u1', statusReply('run-b', 'exited', 7))

    expect(state.finalizeCalls).toHaveLength(1)
    expect(state.finalizeCalls[0].status).toBe('failed')
    expect(state.finalizeCalls[0].error).toBe('teab_exit_7')
  })

  test('(c) terminal run_finished short-circuits; late status does NOT double-finalize', async () => {
    teab.startTeabPoll({ runId: 'run-c', taskId: 'task-c', userId: 'u1', supervisorId: 'sup-1' })
    await teab.handleTeabRunEvent('sup-1', 'u1', ack('run-c'))

    // Build-exit push: clean run_finished (no status snippet) AFTER the ack.
    await teab.handleTeabRunEvent('sup-1', 'u1', { type: 'run_finished', run_id: 'run-c', exit_code: 0 })
    expect(state.finalizeCalls).toHaveLength(1)
    expect(state.finalizeCalls[0].status).toBe('success')

    // A late status reply for the now-removed poll is ignored — no second finalize.
    const handled = await teab.handleTeabRunEvent('sup-1', 'u1', statusReply('run-c', 'exited', 0))
    expect(handled).toBe(false)
    expect(state.finalizeCalls).toHaveLength(1)
  })

  test('(d) max-duration ceiling finalizes timeout + clears the interval', async () => {
    const rec = teab.startTeabPoll({ runId: 'run-d', taskId: 'task-d', userId: 'u1', supervisorId: 'sup-1' })
    await teab.handleTeabRunEvent('sup-1', 'u1', ack('run-d'))
    state.finalizeCalls = [] // ignore any ack-time activity

    // Force the deadline into the past, then drive a tick.
    rec.deadline = Date.now() - 1
    await teab._teabPollTick('run-d')

    expect(state.finalizeCalls).toHaveLength(1)
    expect(state.finalizeCalls[0].status).toBe('failed')
    expect(state.finalizeCalls[0].error).toBe('teab_run_timeout')
    expect(state.lastStatuses).toContain('timeout')
    expect(rec.interval).toBeNull()
    expect(teab._getTeabPoll('run-d')).toBeUndefined()
  })

  test('(e) teab_last_status is updated across polls', async () => {
    teab.startTeabPoll({ runId: 'run-e', taskId: 'task-e', userId: 'u1', supervisorId: 'sup-1' })
    await teab.handleTeabRunEvent('sup-1', 'u1', ack('run-e'))            // → 'running'
    await teab.handleTeabRunEvent('sup-1', 'u1', statusReply('run-e', 'running'))  // → 'running'
    await teab.handleTeabRunEvent('sup-1', 'u1', statusReply('run-e', 'exited', 0)) // → 'exited'

    expect(state.lastStatuses).toContain('running')
    expect(state.lastStatuses).toContain('exited')
    // ordering: a running status precedes the terminal exited status.
    expect(state.lastStatuses.indexOf('running')).toBeLessThan(state.lastStatuses.lastIndexOf('exited'))
  })
})

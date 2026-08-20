/**
 * fix/disabled-task-dispatch — runNow() must not dispatch a disabled task
 * except via the explicit human "Run Now" button (isManual: true).
 *
 * Bug: fire() (cron path) correctly guards `if (!task.enabled) return`, but
 * runNow() had no such guard, so a disabled task could still be dispatched
 * via chain_task (hub/src/scheduler/post-run/chain.ts), the grace-buffer
 * replay on supervisor reconnect (dispatcher.ts fire()'s offline branch),
 * and the manual run-now API route — all three call runNow(). The fix adds
 * one guard keyed off `opts.isManual`, which only the manual route sets.
 *
 * Bun mock.module hygiene (per project memory feedback_bun_mock_pollution):
 * cache-bust real modules, afterAll(mock.restore).
 */
import { describe, test, expect, afterAll, mock } from 'bun:test'

const DISABLED_TASK: any = {
  id: 'task-disabled',
  user_id: 'user-1',
  enabled: false,
  target_kind: 'session',
  target_id: 'sess-1',
  payload: {},
}

const realStDal = await import(`../src/db/scheduled-tasks-dal.ts?bust=${Date.now()}`)
mock.module('../src/db/scheduled-tasks-dal.ts', () => ({
  ...realStDal,
  getTaskById: async (id: string) => (id === DISABLED_TASK.id ? DISABLED_TASK : null),
  // If runNow proceeds past the guard it will call insertRunV2 — fail loudly
  // so a regression is unmistakable rather than silently passing gates.
  insertRunV2: async () => {
    throw new Error('insertRunV2 should not be called for a disabled task dispatched non-manually')
  },
}))

// Threshold + cost-cap gates pass-through so the isManual test can reach the
// (mocked) insertRunV2 marker instead of failing on unrelated DB deps.
mock.module('../src/usage/threshold.ts', () => ({
  checkUserThreshold: async () => ({ allowed: true }),
}))
mock.module('../src/dispatch/gates.ts', () => ({
  isOverCostCap: async () => false,
}))

const { runNow } = await import(`../src/scheduler/dispatcher.ts?bust=${Date.now()}`)

describe('runNow — disabled task guard', () => {
  afterAll(() => mock.restore())

  test('chain_task-style call (no isManual) does NOT dispatch a disabled task', async () => {
    const res = await runNow(DISABLED_TASK.id, DISABLED_TASK.user_id, {
      triggeredByRunId: 'parent-run-1',
      chainDepth: 1,
    })
    expect(res.runIds).toEqual([])
  })

  test('grace-buffer replay-style call (no isManual) does NOT dispatch a disabled task', async () => {
    const res = await runNow(DISABLED_TASK.id, DISABLED_TASK.user_id, {})
    expect(res.runIds).toEqual([])
  })

  test('manual run-now (isManual: true) bypasses the disabled guard and proceeds to dispatch', async () => {
    // The disabled guard must NOT short-circuit this call — it should reach
    // the (mocked) insertRunV2 marker instead of returning { runIds: [] }.
    await expect(
      runNow(DISABLED_TASK.id, DISABLED_TASK.user_id, { isManual: true }),
    ).rejects.toThrow('insertRunV2 should not be called for a disabled task dispatched non-manually')
  })
})

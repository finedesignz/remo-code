/**
 * fix/dispatch-stale-lock-reaper — stale in-memory SessionQueue lock recovery.
 * DB-free: all IO behind injected StaleLockReaperDeps (SessionQueue itself is
 * real — it's the thing under test — but loadTasks/appendRunLog/fanOut are spies).
 */
import { describe, test, expect, beforeEach } from 'bun:test'

import {
  reapStaleOrchestratorLocks,
  STALE_LOCK_MS,
  _resetReapNotifyCooldown,
  type StaleLockTask,
} from '../src/orchestrator/stale-lock-reaper.ts'
import { SessionQueue } from '../src/dispatch/session-queue.ts'

beforeEach(() => {
  _resetReapNotifyCooldown()
})

function task(over: Partial<StaleLockTask> = {}): StaleLockTask {
  return {
    id: 't1',
    session_id: 's1',
    user_id: 'u1',
    timezone: 'UTC',
    ...over,
  }
}

function spyDeps(tasks: StaleLockTask[], queue: SessionQueue) {
  const log = { runLogs: [] as any[], notifies: [] as any[] }
  const deps = {
    loadTasks: async () => tasks,
    getQueue: () => queue,
    appendRunLog: (async (e: any) => {
      log.runLogs.push(e)
      return { id: 'rl', ...e, created_at: '' }
    }) as any,
    fanOut: (async (input: any) => {
      log.notifies.push(input)
      return { delivered: [] }
    }) as any,
  }
  return { deps, log }
}

describe('reapStaleOrchestratorLocks', () => {
  test('reaps a session whose lock age >= threshold', async () => {
    const q = new SessionQueue()
    // enqueue stamps inFlightSince = Date.now(); simulate staleness by
    // reaping with a synthetic `now` STALE_LOCK_MS+ ahead of the real stamp.
    q.enqueue('s1', 'r1')
    const futureNow = Date.now() + STALE_LOCK_MS + 1
    const { deps, log } = spyDeps([task()], q)

    const reaped = await reapStaleOrchestratorLocks(futureNow, deps)

    expect(reaped).toEqual(['s1'])
    expect(q.currentInFlight('s1')).toBe(null) // abandon() cleared it
    expect(log.runLogs).toHaveLength(1)
    expect(log.runLogs[0].command).toBe('reaper')
    expect(log.runLogs[0].outcome).toBe('failed')
    expect(log.runLogs[0].decision_rationale).toContain('reaped stale in-flight lock')
    expect(log.notifies).toHaveLength(1)
    expect(log.notifies[0].event).toBe('failure')
    expect(log.notifies[0].detail).toContain('s1')
  })

  test('does not reap a fresh lock (age < threshold)', async () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1')
    const now = Date.now() + 1_000 // barely aged
    const { deps, log } = spyDeps([task()], q)

    const reaped = await reapStaleOrchestratorLocks(now, deps)

    expect(reaped).toEqual([])
    expect(q.currentInFlight('s1')).toBe('r1') // untouched
    expect(log.runLogs).toHaveLength(0)
    expect(log.notifies).toHaveLength(0)
  })

  test('notify is suppressed within cooldown but reap still happens', async () => {
    const q1 = new SessionQueue()
    q1.enqueue('s1', 'r1')
    const realStamp1 = Date.now()
    const futureNow1 = realStamp1 + STALE_LOCK_MS + 1
    const { deps: deps1, log: log1 } = spyDeps([task()], q1)
    await reapStaleOrchestratorLocks(futureNow1, deps1)
    expect(log1.notifies).toHaveLength(1) // first reap notifies

    // Second wedged session (fresh queue instance, same sessionId) reaped
    // moments later — inside the cooldown window relative to the first.
    const q2 = new SessionQueue()
    q2.enqueue('s1', 'r1')
    const futureNow2 = futureNow1 + 1_000 // well within REAP_NOTIFY_COOLDOWN_MS
    const { deps: deps2, log: log2 } = spyDeps([task()], q2)
    const reaped2 = await reapStaleOrchestratorLocks(futureNow2, deps2)

    expect(reaped2).toEqual(['s1']) // still reaped
    expect(log2.runLogs).toHaveLength(1) // still logged
    expect(log2.notifies).toHaveLength(0) // notify suppressed by cooldown
  })

  test('empty task list is a no-op', async () => {
    const q = new SessionQueue()
    const { deps, log } = spyDeps([], q)
    const reaped = await reapStaleOrchestratorLocks(Date.now(), deps)
    expect(reaped).toEqual([])
    expect(log.runLogs).toHaveLength(0)
    expect(log.notifies).toHaveLength(0)
  })

  test('no in-flight lock for the session is a no-op', async () => {
    const q = new SessionQueue()
    // no enqueue — no lock held for s1
    const { deps, log } = spyDeps([task()], q)
    const reaped = await reapStaleOrchestratorLocks(Date.now() + STALE_LOCK_MS + 1, deps)
    expect(reaped).toEqual([])
    expect(log.runLogs).toHaveLength(0)
    expect(log.notifies).toHaveLength(0)
  })

  test('a task with no in-flight lock is skipped (mixed with a stale one)', async () => {
    const q = new SessionQueue()
    q.enqueue('s1', 'r1') // will be stale
    // s2 never enqueued — no lock
    const futureNow = Date.now() + STALE_LOCK_MS + 1
    const { deps, log } = spyDeps(
      [task({ id: 't1', session_id: 's1' }), task({ id: 't2', session_id: 's2' })],
      q,
    )
    const reaped = await reapStaleOrchestratorLocks(futureNow, deps)
    expect(reaped).toEqual(['s1'])
    expect(log.runLogs).toHaveLength(1)
    expect(log.notifies).toHaveLength(1)
  })
})

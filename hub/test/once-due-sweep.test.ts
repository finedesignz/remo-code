/**
 * Milestone once — the DURABLE once-due sweep (ai-review finding #2).
 *
 * The sweep is the tick-based source of truth for one-time tasks: it must
 * dispatch a due+enabled `schedule_kind='once'` row WITHOUT any in-process
 * setTimeout in play (a restart, a lost timer, a thrown fire). These tests drive
 * `sweepDueOnceTasks` directly with injected deps — there is NO setTimeout and NO
 * registry timer anywhere — proving the sweep alone re-arms and fires.
 */
import { describe, test, expect } from 'bun:test'
import { sweepDueOnceTasks } from '../src/scheduler/once-due-sweep.ts'

describe('once-due sweep — durable dispatch with NO setTimeout', () => {
  test('fires every DUE once task exactly once via dispatcher.fire (the timer never ran)', async () => {
    const fired: string[] = []
    const ids = await sweepDueOnceTasks(Date.now(), {
      listDueOnceTasks: async () => ['once-1', 'once-2'],
      fire: async (id) => { fired.push(id) },
    })
    // Both due rows dispatched by the SWEEP — no setTimeout, no registry involved.
    expect(fired).toEqual(['once-1', 'once-2'])
    expect(ids).toEqual(['once-1', 'once-2'])
  })

  test('a simulated restart (row still due+enabled because the prior fire never claimed) re-fires it', async () => {
    // The row is returned again because claimOnceTask never committed (crash before
    // claim). The sweep picks it up on the next tick — this is the silent-drop fix.
    const fired: string[] = []
    let listedTimes = 0
    const listDue = async () => { listedTimes++; return listedTimes === 1 ? ['work-once'] : [] }
    await sweepDueOnceTasks(Date.now(), { listDueOnceTasks: listDue, fire: async (id) => { fired.push(id) } })
    // Second tick: the fire (mocked here) claimed it, so it's no longer due.
    await sweepDueOnceTasks(Date.now(), { listDueOnceTasks: listDue, fire: async (id) => { fired.push(id) } })
    expect(fired).toEqual(['work-once']) // fired exactly once across the two ticks
  })

  test('a thrown fire does NOT drop siblings and does NOT crash the pass (retried next tick)', async () => {
    const fired: string[] = []
    const ids = await sweepDueOnceTasks(Date.now(), {
      listDueOnceTasks: async () => ['bad', 'good'],
      fire: async (id) => {
        if (id === 'bad') throw new Error('fire boom')
        fired.push(id)
      },
    })
    // 'good' still fired; the pass returned both ids (both were attempted). 'bad'
    // stays enabled (claim never committed) → the next tick retries it.
    expect(fired).toEqual(['good'])
    expect(ids).toEqual(['bad', 'good'])
  })

  test('a due-load failure is swallowed to an empty pass (never throws out of the timer)', async () => {
    const ids = await sweepDueOnceTasks(Date.now(), {
      listDueOnceTasks: async () => { throw new Error('db down') },
      fire: async () => { throw new Error('should not be called') },
    })
    expect(ids).toEqual([])
  })
})

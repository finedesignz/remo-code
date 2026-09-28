/**
 * fix/revanote-stall-alert — owner-visible alert when revanote intake stalls.
 *
 * All ~23 revanote client sites map to ONE session; a wedged session stalls
 * every client with no signal. This sweep fans out at most once per user per
 * cooldown when annotations sit parked/rejected/target-offline past threshold,
 * or an annotation_run sits in_flight past its own (shorter) threshold.
 */
import { describe, test, expect } from 'bun:test'
import {
  sweepRevanoteStalls,
  STALL_PARKED_MAX_MS,
  STALL_RUN_MAX_MS,
  STALL_COOLDOWN_MS,
  type UserStallSummary,
} from '../src/revanote/stall-alert.ts'

const NOW = 1_800_000_000_000

function deps(overrides: Partial<{
  summaries: UserStallSummary[]
  lastAlertAt: Record<string, number | null>
  notifyCalls: any[]
  recordCalls: any[]
}> = {}) {
  const notifyCalls = overrides.notifyCalls ?? []
  const recordCalls = overrides.recordCalls ?? []
  const lastAlertAt = overrides.lastAlertAt ?? {}
  return {
    loadStalledPerUser: async () => overrides.summaries ?? [],
    getLastAlertAt: async (userId: string) => lastAlertAt[userId] ?? null,
    recordAlert: async (userId: string, now: number) => {
      recordCalls.push([userId, now])
    },
    notify: async (input: any) => {
      notifyCalls.push(input)
      return { delivered: ['inapp'] }
    },
  }
}

describe('sweepRevanoteStalls', () => {
  test('fires when parked annotations exceed the threshold', async () => {
    const notifyCalls: any[] = []
    const recordCalls: any[] = []
    const alerted = await sweepRevanoteStalls(
      NOW,
      deps({
        summaries: [
          {
            user_id: 'u1',
            parked_count: 5,
            parked_oldest_ms: NOW - STALL_PARKED_MAX_MS - 60_000,
            stuck_run_count: 0,
            stuck_run_oldest_ms: null,
          },
        ],
        notifyCalls,
        recordCalls,
      }),
    )
    expect(alerted).toEqual(['u1'])
    expect(notifyCalls).toHaveLength(1)
    expect(notifyCalls[0].userId).toBe('u1')
    expect(notifyCalls[0].detail).toContain('5 revanote annotation')
    expect(recordCalls).toEqual([['u1', NOW]])
  })

  test('fires when an annotation_run is stuck in_flight past its threshold', async () => {
    const notifyCalls: any[] = []
    const alerted = await sweepRevanoteStalls(
      NOW,
      deps({
        summaries: [
          {
            user_id: 'u2',
            parked_count: 0,
            parked_oldest_ms: null,
            stuck_run_count: 1,
            stuck_run_oldest_ms: NOW - STALL_RUN_MAX_MS - 1000,
          },
        ],
        notifyCalls,
      }),
    )
    expect(alerted).toEqual(['u2'])
    expect(notifyCalls[0].detail).toContain('stuck in-flight')
  })

  test('does NOT fire below threshold (loader already filters, but zero-count rows are also skipped)', async () => {
    const notifyCalls: any[] = []
    const alerted = await sweepRevanoteStalls(
      NOW,
      deps({
        summaries: [
          { user_id: 'u3', parked_count: 0, parked_oldest_ms: null, stuck_run_count: 0, stuck_run_oldest_ms: null },
        ],
        notifyCalls,
      }),
    )
    expect(alerted).toEqual([])
    expect(notifyCalls).toHaveLength(0)
  })

  test('no summaries at all -> no-op, no throw', async () => {
    const alerted = await sweepRevanoteStalls(NOW, deps({ summaries: [] }))
    expect(alerted).toEqual([])
  })

  test('cooldown: does not re-alert a user alerted within STALL_COOLDOWN_MS', async () => {
    const notifyCalls: any[] = []
    const alerted = await sweepRevanoteStalls(
      NOW,
      deps({
        summaries: [
          { user_id: 'u4', parked_count: 3, parked_oldest_ms: NOW - STALL_PARKED_MAX_MS - 1, stuck_run_count: 0, stuck_run_oldest_ms: null },
        ],
        lastAlertAt: { u4: NOW - STALL_COOLDOWN_MS + 60_000 },
        notifyCalls,
      }),
    )
    expect(alerted).toEqual([])
    expect(notifyCalls).toHaveLength(0)
  })

  test('cooldown: DOES re-alert once the cooldown has fully elapsed', async () => {
    const notifyCalls: any[] = []
    const alerted = await sweepRevanoteStalls(
      NOW,
      deps({
        summaries: [
          { user_id: 'u5', parked_count: 2, parked_oldest_ms: NOW - STALL_PARKED_MAX_MS - 1, stuck_run_count: 0, stuck_run_oldest_ms: null },
        ],
        lastAlertAt: { u5: NOW - STALL_COOLDOWN_MS - 1 },
        notifyCalls,
      }),
    )
    expect(alerted).toEqual(['u5'])
    expect(notifyCalls).toHaveLength(1)
  })

  test('dedup: never alerted before -> fires once', async () => {
    const notifyCalls: any[] = []
    const alerted = await sweepRevanoteStalls(
      NOW,
      deps({
        summaries: [
          { user_id: 'u6', parked_count: 1, parked_oldest_ms: NOW - STALL_PARKED_MAX_MS - 1, stuck_run_count: 0, stuck_run_oldest_ms: null },
        ],
        lastAlertAt: { u6: null },
        notifyCalls,
      }),
    )
    expect(alerted).toEqual(['u6'])
  })

  test('one user failing to notify never aborts the pass for others', async () => {
    const notifyCalls: any[] = []
    const d = deps({
      summaries: [
        { user_id: 'boom', parked_count: 1, parked_oldest_ms: NOW - STALL_PARKED_MAX_MS - 1, stuck_run_count: 0, stuck_run_oldest_ms: null },
        { user_id: 'ok', parked_count: 1, parked_oldest_ms: NOW - STALL_PARKED_MAX_MS - 1, stuck_run_count: 0, stuck_run_oldest_ms: null },
      ],
      notifyCalls,
    })
    d.notify = async (input: any) => {
      if (input.userId === 'boom') throw new Error('send failed')
      notifyCalls.push(input)
      return { delivered: ['inapp'] }
    }
    const alerted = await sweepRevanoteStalls(NOW, d)
    expect(alerted).toEqual(['ok'])
    expect(notifyCalls).toHaveLength(1)
  })

  test('a load failure is fail-open (empty sweep, no throw)', async () => {
    const alerted = await sweepRevanoteStalls(NOW, {
      loadStalledPerUser: async () => {
        throw new Error('db down')
      },
    })
    expect(alerted).toEqual([])
  })
})

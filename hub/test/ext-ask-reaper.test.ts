/**
 * Milestone ASK — the stale-ask reaper (same discipline as scheduler/run-reaper).
 *
 * The load-bearing property: `finalizeAsk` is a CONDITIONAL update, so a reply that
 * lands the instant after a reap does NOT double-finalize. We model that with a
 * fake DAL whose finalize only "wins" while the row is non-terminal.
 */
import { describe, test, expect } from 'bun:test'
import { reapStaleAsks, askMaxMs } from '../src/ask/reaper.ts'

function fakeStore(rows: Array<{ id: string; created_at_ms: number; status: string }>) {
  const calls: Array<{ id: string; status: string; won: boolean }> = []
  return {
    calls,
    deps: {
      loadOpenAsks: async () =>
        rows
          .filter((r) => r.status === 'queued' || r.status === 'dispatched')
          .map((r) => ({ id: r.id, created_at_ms: r.created_at_ms })),
      finalizeAsk: async (id: string, status: any) => {
        const row = rows.find((r) => r.id === id)!
        const terminal = row.status !== 'queued' && row.status !== 'dispatched'
        if (!terminal) row.status = status
        calls.push({ id, status, won: !terminal })
        return !terminal
      },
    },
  }
}

describe('reapStaleAsks', () => {
  const now = 1_000_000_000_000

  test('finalizes an ask older than REMO_ASK_MAX_MS as timeout', async () => {
    const s = fakeStore([
      { id: 'old', created_at_ms: now - askMaxMs() - 1, status: 'dispatched' },
      { id: 'fresh', created_at_ms: now - 1_000, status: 'queued' },
    ])
    const reaped = await reapStaleAsks(now, s.deps as any)
    expect(reaped).toEqual(['old'])
    expect(s.calls).toEqual([{ id: 'old', status: 'timeout', won: true }])
  })

  test('a reply that already answered the ask is NOT double-finalized', async () => {
    // The row raced to `answered` between load and finalize.
    const rows = [{ id: 'raced', created_at_ms: now - askMaxMs() - 1, status: 'dispatched' }]
    const s = fakeStore(rows)
    const loaded = s.deps.loadOpenAsks
    s.deps.loadOpenAsks = async () => {
      const out = await loaded()
      rows[0].status = 'answered' // the late reply wins the race
      return out
    }
    const reaped = await reapStaleAsks(now, s.deps as any)
    expect(reaped).toEqual([]) // conditional UPDATE wrote nothing
    expect(rows[0].status).toBe('answered')
    expect(s.calls[0].won).toBe(false)
  })

  test('a load failure never throws (best-effort sweep)', async () => {
    const reaped = await reapStaleAsks(now, {
      loadOpenAsks: async () => {
        throw new Error('db down')
      },
    } as any)
    expect(reaped).toEqual([])
  })
})

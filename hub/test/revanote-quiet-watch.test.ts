/**
 * fix/revanote-quiet-alert — alert when every client site goes quiet. DB-free.
 */
import { describe, test, expect, beforeEach } from 'bun:test'

import {
  checkRevanoteQuiet,
  classifyQuiet,
  QUIET_ALERT_COOLDOWN_MS,
  _resetQuietWatchState,
  type QuietStats,
} from '../src/revanote/quiet-watch.ts'

function stats(over: Partial<QuietStats> = {}): QuietStats {
  return {
    userId: 'u1',
    sites: 3,
    resolvedInWindow: 0,
    receivedInWindow: 0,
    receivedInBaseline: 0,
    backlog: 0,
    oldestBacklogAt: null,
    ...over,
  }
}

beforeEach(() => _resetQuietWatchState())

describe('classifyQuiet', () => {
  test('backlog waiting and nothing resolved on any site → stalled', () => {
    expect(classifyQuiet(stats({ backlog: 43, receivedInWindow: 5 }))).toBe('stalled')
  })
  test('no intake and nothing resolved, but sites were active before → silent', () => {
    expect(classifyQuiet(stats({ receivedInBaseline: 12 }))).toBe('silent')
  })
  test('any resolved comment on any site → healthy', () => {
    expect(classifyQuiet(stats({ backlog: 43, resolvedInWindow: 1 }))).toBe(null)
  })
  test('no sites, or never had traffic → nothing to alert', () => {
    expect(classifyQuiet(stats({ sites: 0, backlog: 5 }))).toBe(null)
    expect(classifyQuiet(stats())).toBe(null)
  })
})

describe('checkRevanoteQuiet', () => {
  test('alerts once per cooldown, re-arms after recovery', async () => {
    const sent: any[] = []
    let current = stats({ backlog: 4 })
    const deps = {
      loadStats: async () => [current],
      notify: (async (input: any) => {
        sent.push(input)
        return { delivered: [] }
      }) as any,
    }
    const t0 = 5_000_000
    expect(await checkRevanoteQuiet(t0, deps)).toEqual([{ userId: 'u1', kind: 'stalled' }])
    expect(sent[0].detail).toContain('4 client comment(s) waiting')
    expect(sent[0].level).toBe('blocking')

    expect(await checkRevanoteQuiet(t0 + 1, deps)).toEqual([]) // cooldown
    expect(await checkRevanoteQuiet(t0 + QUIET_ALERT_COOLDOWN_MS, deps)).toHaveLength(1)

    current = stats({ backlog: 4, resolvedInWindow: 2 })
    expect(await checkRevanoteQuiet(t0 + QUIET_ALERT_COOLDOWN_MS + 1, deps)).toEqual([])
    current = stats({ backlog: 4 })
    expect(await checkRevanoteQuiet(t0 + QUIET_ALERT_COOLDOWN_MS + 2, deps)).toHaveLength(1)
  })

  test('stats load failure never throws', async () => {
    const out = await checkRevanoteQuiet(0, {
      loadStats: async () => {
        throw new Error('db down')
      },
    })
    expect(out).toEqual([])
  })
})

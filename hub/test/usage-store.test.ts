import { describe, expect, test, beforeEach } from 'bun:test'
// Cache-bust: sibling tests install process-global
// `mock.module('../src/usage/store', …)` partial stubs that only expose
// `getUsage`, so a plain import of `clearUsage` / `setUsage` /
// `_resetUsageStoreForTests` fails with SyntaxError when those siblings load
// first. See feedback_bun_mock_pollution.md.
import type { UsagePayload } from '../src/usage/store'
const {
  setUsage, getUsage, clearUsage, _resetUsageStoreForTests,
} = await import(`../src/usage/store.ts?bust=${Date.now()}`)

const PAYLOAD: UsagePayload = {
  five_hour: { utilization: 42.5, resets_at: '2026-05-25T20:00:00Z' },
  seven_day: { utilization: 12.0, resets_at: '2026-06-01T00:00:00Z' },
  seven_day_opus: null,
  seven_day_oauth_apps: { utilization: 5, resets_at: '2026-06-01T00:00:00Z' },
}

describe('usage store', () => {
  beforeEach(() => { _resetUsageStoreForTests() })

  test('getUsage returns null when nothing stored', () => {
    expect(getUsage('user-1')).toBeNull()
  })

  test('setUsage stores + getUsage returns the snapshot', () => {
    const snap = setUsage('user-1', PAYLOAD)
    expect(snap.usage).toBe(PAYLOAD)
    expect(snap.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(getUsage('user-1')).toEqual(snap)
  })

  test('setUsage overwrites previous snapshot for same user', () => {
    setUsage('user-1', PAYLOAD)
    const next: UsagePayload = {
      ...PAYLOAD,
      five_hour: { utilization: 99, resets_at: PAYLOAD.five_hour.resets_at },
    }
    const snap = setUsage('user-1', next)
    expect(snap.usage.five_hour.utilization).toBe(99)
    expect(getUsage('user-1')!.usage.five_hour.utilization).toBe(99)
  })

  test('snapshots are per-user', () => {
    setUsage('user-1', PAYLOAD)
    const other: UsagePayload = {
      ...PAYLOAD,
      five_hour: { utilization: 1, resets_at: PAYLOAD.five_hour.resets_at },
    }
    setUsage('user-2', other)
    expect(getUsage('user-1')!.usage.five_hour.utilization).toBe(42.5)
    expect(getUsage('user-2')!.usage.five_hour.utilization).toBe(1)
  })

  test('clearUsage removes the snapshot', () => {
    setUsage('user-1', PAYLOAD)
    clearUsage('user-1')
    expect(getUsage('user-1')).toBeNull()
  })
})

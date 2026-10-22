import { describe, test, expect } from 'bun:test'
import { shouldNotifyIncident } from '../src/revanote/alert-state.ts'

describe('Revanote incident notifications', () => {
  test('unchanged incident stays quiet after cooldown and process restart', () => {
    expect(shouldNotifyIncident({ fingerprint: 'same-records', notifiedAt: 1 }, 'same-records', 99_000_000, 3600)).toBe(false)
  })
  test('new membership alerts even if the record count is unchanged', () => {
    expect(shouldNotifyIncident({ fingerprint: 'old-records', notifiedAt: 1 }, 'new-records', 10_000, 3600)).toBe(true)
  })
  test('changed incident still respects cooldown', () => {
    expect(shouldNotifyIncident({ fingerprint: 'old', notifiedAt: 5000 }, 'new', 5001, 3600)).toBe(false)
  })
  test('recovery clears state so recurrence alerts', () => {
    expect(shouldNotifyIncident(null, 'same-records', 10, 3600)).toBe(true)
  })
})

/**
 * PTYCAP-07-04 Task 3 (D-03): the ghost-aware liveness predicate lives in
 * hub/src/sessions/liveness.ts (moved verbatim from the orchestrator inject seam).
 * mock.module is process-global: this file runs in its own bun process and restores on exit.
 */
import { describe, test, expect, beforeEach, afterAll, mock } from 'bun:test'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

const s = {
  channel: null as any,
  rows: [] as any[],
  dbThrows: false,
}

mock.module('../src/ws/registry.ts', () => ({
  getChannel: () => s.channel,
}))
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => {
    if (s.dbThrows) throw new Error('db read failed')
    return s.rows
  },
}))

afterAll(() => {
  mock.restore()
})

const { isSessionLive } = await import('../src/sessions/liveness.ts')

beforeEach(() => {
  s.channel = { ws: {} }
  s.rows = [{ status: 'online', hostname: 'devbox' }]
  s.dbThrows = false
})

describe('isSessionLive (ghost-aware)', () => {
  test('no channel => false (never reads the DB)', async () => {
    s.channel = null
    s.dbThrows = true
    expect(await isSessionLive('s1')).toBe(false)
  })

  test('channel present and online with NULL hostname (ghost) => false', async () => {
    s.rows = [{ status: 'online', hostname: null }]
    expect(await isSessionLive('s1')).toBe(false)
  })

  test('channel present and healthy row => true', async () => {
    expect(await isSessionLive('s1')).toBe(true)
  })

  test('channel present, offline status with NULL hostname is NOT a ghost => true', async () => {
    s.rows = [{ status: 'offline', hostname: null }]
    expect(await isSessionLive('s1')).toBe(true)
  })

  test('channel present but no row => true', async () => {
    s.rows = []
    expect(await isSessionLive('s1')).toBe(true)
  })

  test('DB read error => true (fail-open preserved verbatim)', async () => {
    s.dbThrows = true
    expect(await isSessionLive('s1')).toBe(true)
  })
})

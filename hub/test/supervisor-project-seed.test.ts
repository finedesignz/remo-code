/**
 * B6 — ensureSupervisorProject(userId, hostname, sessionId) idempotency.
 *
 * The first supervisor.hello for (user, host) inserts an error_projects row
 * with name='supervisor:<host>' and a deterministic sentry_key prefix
 * (`sup_<host>_<rand>`). Subsequent hellos reuse the row — NEVER rotate the
 * sentry_key, because the supervisor caches it.
 *
 * Mocks the postgres tag so we never touch a real DB. We model the table
 * with a Map<name, ErrorProject>.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost/placeholder'

import { describe, test, expect, beforeEach, mock } from 'bun:test'

type Row = {
  id: string
  user_id: string
  name: string
  sentry_key: string
  session_id: string
  dedupe_window_seconds: number
  rate_limit_per_hour: number
  daily_dispatch_cap: number
  enabled: boolean
  created_at: string
  updated_at: string
}

const store = new Map<string, Row>()
let idCounter = 0

// Tagged-template-shaped mock. Matches on the SQL string body so we route to
// the right slice of the model.
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const body = strings.join('?').toLowerCase()
  // ensureSupervisorProject's initial SELECT by (user_id, name).
  if (body.includes('select * from error_projects') && body.includes('and name =')) {
    const [userId, name] = values as string[]
    const hit = Array.from(store.values()).find((r) => r.user_id === userId && r.name === name)
    return Promise.resolve(hit ? [hit] : [])
  }
  // ensureSupervisorProject's INSERT.
  if (body.includes('insert into error_projects')) {
    const [userId, name, sentryKey, sessionId] = values as string[]
    // Mimic ON CONFLICT (sentry_key) DO NOTHING — if another row with the
    // same sentry_key exists, return empty.
    if (Array.from(store.values()).some((r) => r.sentry_key === sentryKey)) {
      return Promise.resolve([])
    }
    const now = new Date().toISOString()
    const row: Row = {
      id: `proj_${++idCounter}`,
      user_id: userId,
      name,
      sentry_key: sentryKey,
      session_id: sessionId,
      dedupe_window_seconds: 60,
      rate_limit_per_hour: 20,
      daily_dispatch_cap: 50,
      enabled: true,
      created_at: now,
      updated_at: now,
    }
    store.set(row.id, row)
    return Promise.resolve([row])
  }
  return Promise.resolve([])
}

mock.module('../src/db/postgres.ts', () => ({
  sql: fakeSql,
}))

describe('ensureSupervisorProject', () => {
  let ensureSupervisorProject: typeof import('../src/db/error-capture-dal').ensureSupervisorProject

  beforeEach(async () => {
    store.clear()
    idCounter = 0
    // Re-import after mock to pick up the stubbed sql binding.
    const mod = await import('../src/db/error-capture-dal.ts')
    ensureSupervisorProject = mod.ensureSupervisorProject
  })

  test('first call inserts a new row with sup_<host>_ key prefix', async () => {
    const row = await ensureSupervisorProject('user_A', 'WORKSTATION-1', 'sess_root_a')
    expect(row.user_id).toBe('user_A')
    expect(row.name).toBe('supervisor:workstation-1')
    expect(row.sentry_key.startsWith('sup_workstation-1_')).toBe(true)
    expect(row.session_id).toBe('sess_root_a')
    expect(row.enabled).toBe(true)
    expect(store.size).toBe(1)
  })

  test('second call for same (user, host) returns the original row — same sentry_key', async () => {
    const a = await ensureSupervisorProject('user_A', 'WORKSTATION-1', 'sess_root_a')
    const b = await ensureSupervisorProject('user_A', 'WORKSTATION-1', 'sess_root_a')
    expect(b.id).toBe(a.id)
    expect(b.sentry_key).toBe(a.sentry_key)
    expect(store.size).toBe(1) // no duplicate insert
  })

  test('different host gets a different row + different key', async () => {
    const a = await ensureSupervisorProject('user_A', 'WORKSTATION-1', 'sess_a')
    const b = await ensureSupervisorProject('user_A', 'LAPTOP-2', 'sess_b')
    expect(b.id).not.toBe(a.id)
    expect(b.sentry_key).not.toBe(a.sentry_key)
    expect(b.name).toBe('supervisor:laptop-2')
    expect(store.size).toBe(2)
  })

  test('different user, same host gets a different row', async () => {
    const a = await ensureSupervisorProject('user_A', 'WORKSTATION-1', 'sess_a')
    const b = await ensureSupervisorProject('user_B', 'WORKSTATION-1', 'sess_b')
    expect(b.id).not.toBe(a.id)
    expect(b.user_id).toBe('user_B')
    expect(b.sentry_key).not.toBe(a.sentry_key)
    expect(store.size).toBe(2)
  })

  test('non-alphanumeric host chars are sanitized', async () => {
    const row = await ensureSupervisorProject('user_A', 'WS/EVIL\\\\PATH..!!', 'sess_a')
    expect(row.name).toMatch(/^supervisor:[a-z0-9._-]+$/)
    expect(row.sentry_key.startsWith('sup_')).toBe(true)
  })

  test('empty/garbage hostname falls back to unknown', async () => {
    const row = await ensureSupervisorProject('user_A', '!!!', 'sess_a')
    expect(row.name).toBe('supervisor:unknown')
  })
})

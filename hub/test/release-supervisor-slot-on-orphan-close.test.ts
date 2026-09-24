/**
 * Regression for the hub orphaned-run supervisor leak (owner-diagnosed
 * 2026-09-18 and 2026-09-24; the 09-24 incident stranded 23 revanote client
 * annotations, oldest 24 days).
 *
 * `finalizeOrphanedRunsForSupervisor` / `finalizeUnbackedOpenRunsForSupervisor`
 * close leaked `session_runs` rows (set `ended_at` / `exit_reason`) but never
 * touched `supervisors.state` / `current_run_id`. Normal run completion clears
 * the slot via `setSupervisorState` (the `supervisor.state` WS handler), but a
 * run that ends via either reconciler path bypassed that handler entirely — so
 * a supervisor whose last run was reaped stayed pinned at `state='running'`
 * with a stale `current_run_id` forever, heartbeating normally while every new
 * dispatch was rejected `session_busy` against a slot nothing was using.
 *
 * Gated on REMO_E2E_DB_URL because it exercises real Postgres. Skips cleanly.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
if (process.env.REMO_E2E_DB_URL) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}

import { describe, test, expect, beforeAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('releaseSupervisorSlotIfClosed (orphaned-run supervisor leak)', () => {
  let sql: any
  let finalizeOrphanedRunsForSupervisor: (id: string, live: string[]) => Promise<number>
  let releaseSupervisorSlotIfClosed: (id: string, closedRunIds: string[]) => Promise<boolean>
  let userId: string

  beforeAll(async () => {
    ;({ finalizeOrphanedRunsForSupervisor, releaseSupervisorSlotIfClosed } = await import(
      '../src/db/supervisor-dal.ts'
    ))
    ;({ sql } = await import('../src/db/postgres.ts'))

    const userRow = await sql`
      INSERT INTO users (email) VALUES (${`orphan-slot-${Date.now()}@test.local`})
      RETURNING id
    `
    userId = userRow[0].id
  })

  async function mkSession(id: string): Promise<string> {
    await sql`
      INSERT INTO sessions (id, user_id, name, token_hash)
      VALUES (${id}, ${userId}, ${`orphan-slot-${id}`}, ${`hash-${id}`})
      ON CONFLICT (id) DO NOTHING
    `
    return id
  }

  async function mkSupervisor(id: string): Promise<void> {
    const apiKeyId = `apikey_${id}`
    await sql`
      INSERT INTO api_keys (id, user_id, key_hash, capabilities, name, purpose)
      VALUES (${apiKeyId}, ${userId}, ${`hash-${id}`}, ${['supervisor']}::text[], 'orphan slot test', ${`purpose-${id}`})
      ON CONFLICT (id) DO NOTHING
    `
    await sql`
      INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots)
      VALUES (${id}, ${userId}, ${apiKeyId}, ${'orphan-slot-host'}, ARRAY[]::text[])
      ON CONFLICT (id) DO NOTHING
    `
  }

  // Test 1 (failing-first proof) --------------------------------------------
  test('a run closed via the orphan path leaves the supervisor idle with a null current_run_id', async () => {
    const supervisorId = `sup_slot_${Date.now()}`
    await mkSupervisor(supervisorId)
    const ghostSessionId = await mkSession(crypto.randomUUID())

    const runRow = await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${ghostSessionId}, ${supervisorId}, 'ghost', now() - interval '5 minutes')
      RETURNING id
    `
    const runId = runRow[0].id

    // Supervisor believes it is still actively running this exact run — this
    // is the state the reconciler is supposed to repair.
    await sql`UPDATE supervisors SET state = 'running', current_run_id = ${runId} WHERE id = ${supervisorId}`

    // session_id is NOT in the live inventory -> orphan reconciler closes it.
    const closed = await finalizeOrphanedRunsForSupervisor(supervisorId, [])
    expect(closed).toBe(1)

    const supRow = await sql`SELECT state, current_run_id FROM supervisors WHERE id = ${supervisorId}`
    expect(supRow[0].state).toBe('idle')
    expect(supRow[0].current_run_id).toBeNull()
  })

  // Test 2 (safety property) -------------------------------------------------
  test('a supervisor whose current_run_id has moved on to a NEW run is NOT reset when the old run is reconciled', async () => {
    const supervisorId = `sup_slot_safety_${Date.now()}`
    await mkSupervisor(supervisorId)
    const oldSessionId = await mkSession(crypto.randomUUID())
    const newSessionId = await mkSession(crypto.randomUUID())

    const oldRunRow = await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${oldSessionId}, ${supervisorId}, 'old-ghost', now() - interval '5 minutes')
      RETURNING id
    `
    const oldRunId = oldRunRow[0].id
    const newRunRow = await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${newSessionId}, ${supervisorId}, 'new-live', now())
      RETURNING id
    `
    const newRunId = newRunRow[0].id

    // Interleaving under test: between the old run being closed and the
    // reconciler's reset, a NEW run started on the same supervisor and moved
    // current_run_id forward.
    await sql`UPDATE supervisors SET state = 'running', current_run_id = ${newRunId} WHERE id = ${supervisorId}`

    // Directly exercise the release helper as if the old run had just been
    // closed by the reconciler (id no longer equals the supervisor's current
    // slot owner).
    const released = await releaseSupervisorSlotIfClosed(supervisorId, [oldRunId])
    expect(released).toBe(false)

    const supRow = await sql`SELECT state, current_run_id FROM supervisors WHERE id = ${supervisorId}`
    expect(supRow[0].state).toBe('running')
    expect(supRow[0].current_run_id).toBe(newRunId)
  })
})

describe('release-supervisor-slot-on-orphan-close — env gate', () => {
  test('e2e gated on REMO_E2E_DB_URL', () => {
    if (!HAS_TEST_DB) {
      console.log('[release-supervisor-slot] REMO_E2E_DB_URL not set — DB tests SKIPPED.')
    }
    expect(true).toBe(true)
  })
})

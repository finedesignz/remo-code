/**
 * Bundle 3 (TRIAGE-2026-05-28) — zombie session_runs cleanup on supervisor
 * socket close.
 *
 * Gated on REMO_E2E_DB_URL because it exercises real Postgres. Skips cleanly
 * when unset.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
if (process.env.REMO_E2E_DB_URL) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}

import { describe, test, expect, beforeAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('finalizeOpenRunsForSupervisor', () => {
  let finalizeOpenRunsForSupervisor: (id: string) => Promise<void>
  let sql: any
  let supervisorId: string
  let userId: string

  beforeAll(async () => {
    ;({ finalizeOpenRunsForSupervisor } = await import('../src/db/supervisor-dal.ts'))
    ;({ sql } = await import('../src/db/postgres.ts'))

    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`
    // Minimal users + supervisors + session_runs schema for the test.
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user'
      )
    `
    await sql`
      CREATE TABLE IF NOT EXISTS session_runs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        session_id UUID,
        supervisor_id TEXT NOT NULL,
        repo_path TEXT NOT NULL DEFAULT '',
        branch TEXT,
        pulled BOOLEAN NOT NULL DEFAULT false,
        initial_prompt TEXT,
        restart_of UUID,
        restart_count INT NOT NULL DEFAULT 0,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ended_at TIMESTAMPTZ,
        exit_code INT,
        exit_reason TEXT
      )
    `

    const userRow = await sql`
      INSERT INTO users (email) VALUES (${`finalize-${Date.now()}@test.local`})
      RETURNING id
    `
    userId = userRow[0].id
    supervisorId = `sup_finalize_${Date.now()}`

    // session_runs.supervisor_id is an FK → supervisors(id) in the real schema,
    // so every supervisor_id we reference needs a real parent row.
    await mkSupervisor(supervisorId)
  })

  // Each supervisor needs its own api_key: supervisors.api_key_id is uniquely
  // indexed (idx_supervisors_api_key) and the api_keys partial unique index
  // allows one active key per (user, purpose) — so use a distinct purpose too.
  async function mkSupervisor(id: string): Promise<void> {
    const apiKeyId = `apikey_${id}`
    await sql`
      INSERT INTO api_keys (id, user_id, key_hash, capabilities, name, purpose)
      VALUES (${apiKeyId}, ${userId}, ${`hash-${id}`}, ${['supervisor']}::text[], 'finalize test', ${`purpose-${id}`})
      ON CONFLICT (id) DO NOTHING
    `
    await sql`
      INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots)
      VALUES (${id}, ${userId}, ${apiKeyId}, ${'finalize-host'}, ARRAY[]::text[])
      ON CONFLICT (id) DO NOTHING
    `
  }

  test('updates only open rows for the given supervisor', async () => {
    // Two open + one already-ended row for this supervisor; one open row for
    // another supervisor (control).
    const otherSup = `sup_other_${Date.now()}`
    await mkSupervisor(otherSup)
    await sql`
      INSERT INTO session_runs (user_id, supervisor_id, repo_path)
      VALUES (${userId}, ${supervisorId}, 'a')
    `
    await sql`
      INSERT INTO session_runs (user_id, supervisor_id, repo_path)
      VALUES (${userId}, ${supervisorId}, 'b')
    `
    await sql`
      INSERT INTO session_runs (user_id, supervisor_id, repo_path, ended_at, exit_reason)
      VALUES (${userId}, ${supervisorId}, 'c', now(), 'normal')
    `
    await sql`
      INSERT INTO session_runs (user_id, supervisor_id, repo_path)
      VALUES (${userId}, ${otherSup}, 'd')
    `

    await finalizeOpenRunsForSupervisor(supervisorId)

    const ours = await sql`
      SELECT repo_path, ended_at, exit_reason
      FROM session_runs
      WHERE supervisor_id = ${supervisorId}
      ORDER BY repo_path
    `
    expect(ours.length).toBe(3)
    // 'a' + 'b' → finalized by helper.
    expect(ours[0].ended_at).not.toBeNull()
    expect(ours[0].exit_reason).toBe('socket_close')
    expect(ours[1].ended_at).not.toBeNull()
    expect(ours[1].exit_reason).toBe('socket_close')
    // 'c' was already ended with reason 'normal' — untouched.
    expect(ours[2].exit_reason).toBe('normal')

    // Control supervisor untouched.
    const other = await sql`
      SELECT ended_at FROM session_runs WHERE supervisor_id = ${otherSup}
    `
    expect(other[0].ended_at).toBeNull()
  })
})

describe('finalizeOpenRunsForSupervisor — env gate', () => {
  test('e2e gated on REMO_E2E_DB_URL', () => {
    if (!HAS_TEST_DB) {
      console.log('[finalize-open-runs] REMO_E2E_DB_URL not set — DB tests SKIPPED.')
    }
    expect(true).toBe(true)
  })
})

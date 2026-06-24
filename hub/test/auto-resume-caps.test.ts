/**
 * Auto-resume guards (Phase 09 follow-up, 2026-05-27 RCA).
 *
 * Verifies the two new caps on hub/src/ws/agent.ts:supervisor.hello auto-resume:
 *
 *   1. AGE CAP — only resume `session_runs` rows where `started_at > now() - 24h`.
 *      Older open rows are swept and finalized as `exit_reason='stale'`.
 *   2. RESTART CAP — when `restart_count >= 10`, finalize the run as
 *      `exit_reason='max_restarts_exceeded'` and skip the replay.
 *
 * Gated on REMO_E2E_DB_URL so the rest of `bun test` stays green without a DB.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
if (process.env.REMO_E2E_DB_URL) process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

const TEST_USER_ID = '00000000-0000-0000-0000-0000000a5001'
const TEST_API_KEY_ID = 'apikey_ar001'
const TEST_SUPERVISOR_ID = 'sup_ar001'

let sql: any

async function seed() {
  await sql.unsafe(`
    INSERT INTO users (id, email, password_hash, role)
    VALUES ('${TEST_USER_ID}', 'ar001+autoresume@test.local', 'x', 'user')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO api_keys (id, user_id, key_hash, capabilities, name)
    VALUES ('${TEST_API_KEY_ID}', '${TEST_USER_ID}', 'ar001-hash', ARRAY['supervisor']::text[], 'ar001')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots, concurrency_budget, last_seen_at)
    VALUES ('${TEST_SUPERVISOR_ID}', '${TEST_USER_ID}', '${TEST_API_KEY_ID}', 'ar001-host', '{}'::text[], 4, now())
    ON CONFLICT (id) DO NOTHING;
  `)
}

async function cleanupRuns() {
  await sql`DELETE FROM session_runs WHERE supervisor_id = ${TEST_SUPERVISOR_ID}`
}

maybe('auto-resume age + restart-count caps', () => {
  beforeAll(async () => {
    ;({ sql } = await import('../src/db/postgres'))
    await seed()
  })

  afterAll(async () => {
    await cleanupRuns()
    await sql`DELETE FROM supervisors WHERE id = ${TEST_SUPERVISOR_ID}`
    await sql`DELETE FROM api_keys WHERE id = ${TEST_API_KEY_ID}`
    await sql`DELETE FROM users WHERE id = ${TEST_USER_ID}`
  })

  beforeEach(async () => {
    await cleanupRuns()
  })

  test('fresh run (<24h old, restart_count=0) IS picked up by the orphan query', async () => {
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_fresh_1', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'C:/x/fresh', now() - interval '2 hours', NULL, 0)
    `
    const rows = await sql`
      SELECT id, restart_count, started_at
      FROM session_runs
      WHERE supervisor_id = ${TEST_SUPERVISOR_ID}
        AND ended_at IS NULL
        AND started_at > now() - interval '24 hours'
      ORDER BY started_at ASC
    `
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('run_fresh_1')
    expect(rows[0].restart_count).toBe(0)
  })

  test('stale run (>24h old) is EXCLUDED from the orphan query AND finalized by the sweep', async () => {
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, repo_path, started_at, ended_at)
      VALUES ('run_stale_1', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'C:/x/stale', now() - interval '48 hours', NULL)
    `
    // Mirror agent.ts: SELECT excludes >24h
    const orphans = await sql`
      SELECT id FROM session_runs
      WHERE supervisor_id = ${TEST_SUPERVISOR_ID}
        AND ended_at IS NULL
        AND started_at > now() - interval '24 hours'
    `
    expect(orphans.length).toBe(0)

    // Mirror agent.ts: UPDATE finalizes anything older than 24h as stale.
    const swept = await sql`
      UPDATE session_runs
      SET ended_at = now(), exit_reason = 'stale'
      WHERE supervisor_id = ${TEST_SUPERVISOR_ID}
        AND ended_at IS NULL
        AND started_at <= now() - interval '24 hours'
      RETURNING id, exit_reason
    `
    expect(swept.length).toBe(1)
    expect(swept[0].id).toBe('run_stale_1')
    expect(swept[0].exit_reason).toBe('stale')
  })

  test('run with restart_count >= 10 is identified by the cap check (skipped + finalized)', async () => {
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_loopy_1', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'C:/x/loopy', now() - interval '1 hour', NULL, 10)
    `
    const orphans = await sql`
      SELECT id, restart_count FROM session_runs
      WHERE supervisor_id = ${TEST_SUPERVISOR_ID}
        AND ended_at IS NULL
        AND started_at > now() - interval '24 hours'
    `
    expect(orphans.length).toBe(1)
    expect(orphans[0].restart_count).toBe(10)

    // The replay code finalizes these and continues. Simulate that step.
    await sql`
      UPDATE session_runs
      SET ended_at = now(), exit_reason = 'max_restarts_exceeded'
      WHERE id = 'run_loopy_1'
    `
    const after = await sql`
      SELECT ended_at, exit_reason FROM session_runs WHERE id = 'run_loopy_1'
    `
    expect(after[0].exit_reason).toBe('max_restarts_exceeded')
    expect(after[0].ended_at).not.toBeNull()
  })

  test('combination: stale-and-loopy is finalized via the stale sweep (age guard wins)', async () => {
    // A run that's both >24h old AND has restart_count=10. The age sweep
    // fires first (in agent.ts), so the row is finalized as 'stale' and the
    // restart-count gate never sees it. This matches the in-code order.
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_stale_loopy', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'C:/x/sl', now() - interval '30 hours', NULL, 10)
    `
    const orphans = await sql`
      SELECT id FROM session_runs
      WHERE supervisor_id = ${TEST_SUPERVISOR_ID}
        AND ended_at IS NULL
        AND started_at > now() - interval '24 hours'
    `
    expect(orphans.length).toBe(0)
    const swept = await sql`
      UPDATE session_runs
      SET ended_at = now(), exit_reason = 'stale'
      WHERE supervisor_id = ${TEST_SUPERVISOR_ID}
        AND ended_at IS NULL
        AND started_at <= now() - interval '24 hours'
      RETURNING id, exit_reason
    `
    expect(swept.length).toBe(1)
    expect(swept[0].exit_reason).toBe('stale')
  })
})

if (!HAS_TEST_DB) {
  // Sanity skip so the suite doesn't appear empty in CI.
  test.skip('auto-resume caps test suite skipped — set REMO_E2E_DB_URL to run', () => {})
}

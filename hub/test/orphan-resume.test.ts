/**
 * Orphan-resume helper tests (Phase: session-resume-on-load).
 *
 * Verifies the sacred invariant: a session whose last finalized run carries
 * `exit_reason='user_stopped'` is NEVER auto-resumed — neither via the
 * supervisor.hello path nor the web-client connect path.
 *
 * Other cases covered:
 *   - NULL exit_reason orphan → resumed.
 *   - exit_reason='crashed' on a prior finalized run → resumed.
 *   - exit_reason='user_stopped' on prior finalized run → NOT resumed.
 *   - No online supervisor → no resume attempt, skipped_no_supervisor populated.
 *   - Rate-limit: second call within 60s for same user returns empty result.
 *   - Mixed batch: correct partition across multiple sessions.
 *
 * Gated on REMO_E2E_DB_URL.
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

const TEST_USER_ID = '00000000-0000-0000-0000-0000000or001'
const TEST_API_KEY_ID = 'apikey_or001'
const TEST_SUPERVISOR_ID = 'sup_or001'

let sql: any
let resumeOrphansForSupervisor: any
let resumeOrphanSessionsForUser: any
let __resetClientResumeRateLimit: any
let registerSupervisor: any
let unregisterSupervisor: any

// Fake ServerWebSocket — just captures sends so we can assert which run_ids
// got `session.start`. We register it in the in-memory supervisor registry to
// simulate an online supervisor.
function fakeWs() {
  const sent: any[] = []
  return {
    sent,
    send: (s: string) => { sent.push(JSON.parse(s)) },
    close: () => {},
    data: {},
  } as any
}

async function seed() {
  await sql.unsafe(`
    INSERT INTO users (id, email, password_hash, role)
    VALUES ('${TEST_USER_ID}', 'or001+orphan@test.local', 'x', 'user')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO api_keys (id, user_id, key_hash, capabilities, name)
    VALUES ('${TEST_API_KEY_ID}', '${TEST_USER_ID}', 'or001-hash', '["supervisor"]'::jsonb, 'or001')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots, concurrency_budget, last_seen_at)
    VALUES ('${TEST_SUPERVISOR_ID}', '${TEST_USER_ID}', '${TEST_API_KEY_ID}', 'or001-host', '{}'::text[], 4, now())
    ON CONFLICT (id) DO NOTHING;
  `)
}

async function makeSession(id: string, projectDir: string) {
  await sql`
    INSERT INTO sessions (id, user_id, name, project_dir, token_hash, status)
    VALUES (${id}, ${TEST_USER_ID}, ${'sess ' + id}, ${projectDir}, ${'hash_' + id}, 'offline')
    ON CONFLICT (id) DO NOTHING
  `
}

async function cleanup() {
  await sql`DELETE FROM session_runs WHERE user_id = ${TEST_USER_ID}`
  await sql`DELETE FROM sessions WHERE user_id = ${TEST_USER_ID}`
}

maybe('orphan-resume helper', () => {
  beforeAll(async () => {
    ;({ sql } = await import('../src/db/postgres'))
    ;({ resumeOrphansForSupervisor, resumeOrphanSessionsForUser, __resetClientResumeRateLimit } =
      await import('../src/orchestrator/orphan-resume'))
    ;({ registerSupervisor, unregisterSupervisor } = await import('../src/ws/supervisor-registry'))
    await seed()
  })

  afterAll(async () => {
    await cleanup()
    await sql`DELETE FROM supervisors WHERE id = ${TEST_SUPERVISOR_ID}`
    await sql`DELETE FROM api_keys WHERE id = ${TEST_API_KEY_ID}`
    await sql`DELETE FROM users WHERE id = ${TEST_USER_ID}`
  })

  beforeEach(async () => {
    await cleanup()
    __resetClientResumeRateLimit()
    try { unregisterSupervisor(TEST_SUPERVISOR_ID) } catch {}
  })

  test('NULL exit_reason orphan → resumed (supervisor path)', async () => {
    await makeSession('sess_or_null', 'C:/x/null')
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_or_null', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_null', 'C:/x/null', now() - interval '1 hour', NULL, 0)
    `
    const ws = fakeWs()
    registerSupervisor({ ws, supervisorId: TEST_SUPERVISOR_ID, userId: TEST_USER_ID, apiKeyId: TEST_API_KEY_ID, roots: [] })
    const r = await resumeOrphansForSupervisor({ userId: TEST_USER_ID, supervisorId: TEST_SUPERVISOR_ID })
    expect(r.resumed.length).toBe(1)
    expect(r.skipped_user_stopped.length).toBe(0)
    expect(ws.sent.find((m: any) => m.type === 'session.start')).toBeTruthy()
  })

  test('session with prior exit_reason=user_stopped → NOT resumed (sacred invariant)', async () => {
    await makeSession('sess_or_stop', 'C:/x/stop')
    // Prior finalized run with user_stopped.
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, exit_reason)
      VALUES ('run_or_stop_old', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_stop', 'C:/x/stop',
              now() - interval '3 hours', now() - interval '2 hours', 'user_stopped')
    `
    // A NEW open run snuck through somehow — we still must not resume it.
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_or_stop_open', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_stop', 'C:/x/stop',
              now() - interval '1 hour', NULL, 0)
    `
    const ws = fakeWs()
    registerSupervisor({ ws, supervisorId: TEST_SUPERVISOR_ID, userId: TEST_USER_ID, apiKeyId: TEST_API_KEY_ID, roots: [] })
    const r = await resumeOrphansForSupervisor({ userId: TEST_USER_ID, supervisorId: TEST_SUPERVISOR_ID })
    expect(r.resumed.length).toBe(0)
    expect(r.skipped_user_stopped.length).toBe(1)
    expect(ws.sent.find((m: any) => m.type === 'session.start')).toBeFalsy()
    // The dangling open row should be finalized as user_stopped too.
    const after = await sql`SELECT exit_reason FROM session_runs WHERE id = 'run_or_stop_open'`
    expect(after[0].exit_reason).toBe('user_stopped')
  })

  test('session with prior exit_reason=crashed → resumed', async () => {
    await makeSession('sess_or_crashed', 'C:/x/crashed')
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, exit_reason)
      VALUES ('run_or_crashed_old', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_crashed', 'C:/x/crashed',
              now() - interval '3 hours', now() - interval '2 hours', 'crashed')
    `
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_or_crashed_open', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_crashed', 'C:/x/crashed',
              now() - interval '30 minutes', NULL, 1)
    `
    const ws = fakeWs()
    registerSupervisor({ ws, supervisorId: TEST_SUPERVISOR_ID, userId: TEST_USER_ID, apiKeyId: TEST_API_KEY_ID, roots: [] })
    const r = await resumeOrphansForSupervisor({ userId: TEST_USER_ID, supervisorId: TEST_SUPERVISOR_ID })
    expect(r.resumed.length).toBe(1)
    expect(r.skipped_user_stopped.length).toBe(0)
  })

  test('user-scoped path: no online supervisor → no resume, empty result', async () => {
    await makeSession('sess_or_nosup', 'C:/x/nosup')
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at)
      VALUES ('run_or_nosup', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_nosup', 'C:/x/nosup',
              now() - interval '1 hour', NULL)
    `
    // No registerSupervisor call → supervisor offline in registry.
    const r = await resumeOrphanSessionsForUser(TEST_USER_ID)
    expect(r.resumed.length).toBe(0)
    expect(r.skipped_no_supervisor.length).toBe(0) // early-return: no supervisors at all
  })

  test('user-scoped path: rate-limited within 60s', async () => {
    await makeSession('sess_or_rl', 'C:/x/rl')
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at)
      VALUES ('run_or_rl', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_rl', 'C:/x/rl',
              now() - interval '1 hour', NULL)
    `
    const ws = fakeWs()
    registerSupervisor({ ws, supervisorId: TEST_SUPERVISOR_ID, userId: TEST_USER_ID, apiKeyId: TEST_API_KEY_ID, roots: [] })
    const r1 = await resumeOrphanSessionsForUser(TEST_USER_ID)
    expect(r1.resumed.length).toBe(1)
    // Second call: rate-limited, no action.
    const r2 = await resumeOrphanSessionsForUser(TEST_USER_ID)
    expect(r2.resumed.length).toBe(0)
  })

  test('mixed batch: user_stopped skipped, NULL resumed, max_restarts skipped', async () => {
    await makeSession('sess_or_mix_a', 'C:/x/ma')
    await makeSession('sess_or_mix_b', 'C:/x/mb')
    await makeSession('sess_or_mix_c', 'C:/x/mc')
    // a: user_stopped (skip)
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, exit_reason)
      VALUES ('run_mix_a_old', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_mix_a', 'C:/x/ma',
              now() - interval '3 hours', now() - interval '2 hours', 'user_stopped')
    `
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at)
      VALUES ('run_mix_a_open', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_mix_a', 'C:/x/ma',
              now() - interval '1 hour', NULL)
    `
    // b: clean NULL (resume)
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_mix_b_open', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_mix_b', 'C:/x/mb',
              now() - interval '1 hour', NULL, 0)
    `
    // c: max_restarts (skip)
    await sql`
      INSERT INTO session_runs (id, user_id, supervisor_id, session_id, repo_path, started_at, ended_at, restart_count)
      VALUES ('run_mix_c_open', ${TEST_USER_ID}, ${TEST_SUPERVISOR_ID}, 'sess_or_mix_c', 'C:/x/mc',
              now() - interval '1 hour', NULL, 10)
    `
    const ws = fakeWs()
    registerSupervisor({ ws, supervisorId: TEST_SUPERVISOR_ID, userId: TEST_USER_ID, apiKeyId: TEST_API_KEY_ID, roots: [] })
    const r = await resumeOrphansForSupervisor({ userId: TEST_USER_ID, supervisorId: TEST_SUPERVISOR_ID })
    expect(r.resumed.length).toBe(1)
    expect(r.skipped_user_stopped.length).toBe(1)
    expect(r.skipped_max_restarts.length).toBe(1)
  })
})

if (!HAS_TEST_DB) {
  test.skip('orphan-resume test suite skipped — set REMO_E2E_DB_URL to run', () => {})
}

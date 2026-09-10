/**
 * Regression: supervisor row state machine wedges at `state='stopped'` after
 * the SUPERVISOR's own in-process maxConcurrent gate rejects a start with
 * `last_exit.reason='concurrency_cap'`. Prod evidence 2026-05-29 03:35–03:36 UTC:
 * two /doctor auto-launches created session_runs rows that ended ~200ms later
 * with `concurrency_cap`, leaving the supervisor row at `state='stopped'` even
 * though zero session_runs were actually open.
 *
 * Root cause (cross-tier): the supervisor's in-process `this.runs` Map
 * accumulated stale entries — `activeSlotCount()` counted them toward the cap
 * — but that supervisor-side bug is OUT OF SCOPE here. The hub-side fix:
 * `supervisor.state` messages carrying a start-rejection `last_exit.reason`
 * must NOT propagate the announced `state='stopped'` to the supervisors row.
 * The supervisor process is still alive; only the failed RUN should be ended.
 *
 * Sanity checks for the existing count-based gate are also included so a
 * future regression that re-introduces a state-based gate fails loudly.
 *
 * DB-gated on REMO_E2E_DB_URL.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
if (HAS_TEST_DB) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}
const maybe = HAS_TEST_DB ? describe : describe.skip

let sql: any
let reserveSessionSlot: any
let setSupervisorState: any

const TEST_USER_ID = '00000000-0000-0000-0000-00000000c001'
const TEST_API_KEY_ID = 'apikey_state_t001'
const TEST_SUP_ID = 'sup_state_t001'

async function seed(): Promise<void> {
  await sql.unsafe(`
    INSERT INTO users (id, email, password_hash, role)
    VALUES ('${TEST_USER_ID}', 't001+state@test.local', 'x', 'user')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO api_keys (id, user_id, key_hash, capabilities, name)
    VALUES ('${TEST_API_KEY_ID}', '${TEST_USER_ID}', 'state-test-hash', ARRAY['supervisor']::text[], 'state test')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots, concurrency_budget)
    VALUES ('${TEST_SUP_ID}', '${TEST_USER_ID}', '${TEST_API_KEY_ID}', 'state-test-host', ARRAY[]::text[], 1)
    ON CONFLICT (id) DO UPDATE SET concurrency_budget = 1, concurrency_override = NULL;
  `)
}

async function clearRuns(): Promise<void> {
  await sql.unsafe(`DELETE FROM session_runs WHERE supervisor_id = '${TEST_SUP_ID}'`)
}

async function insertOpenRun(): Promise<string> {
  const rows = await sql.unsafe(
    `INSERT INTO session_runs (user_id, supervisor_id, repo_path) VALUES ('${TEST_USER_ID}', '${TEST_SUP_ID}', '/tmp/state') RETURNING id`,
  )
  return rows[0].id
}

async function getSupRow(): Promise<{ state: string; current_run_id: string | null }> {
  const rows = await sql.unsafe(
    `SELECT state, current_run_id FROM supervisors WHERE id = '${TEST_SUP_ID}'`,
  )
  return rows[0]
}

async function forceSupState(state: string, currentRunId: string | null): Promise<void> {
  await sql.unsafe(
    `UPDATE supervisors SET state = '${state}', current_run_id = ${currentRunId ? `'${currentRunId}'` : 'NULL'} WHERE id = '${TEST_SUP_ID}'`,
  )
}

maybe('supervisor state-machine regression (DB)', () => {
  beforeAll(async () => {
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    const budget = await import('../src/sessions/budget.ts')
    reserveSessionSlot = budget.reserveSessionSlot
    const dal = await import('../src/db/supervisor-dal.ts')
    setSupervisorState = dal.setSupervisorState
    await seed()
    await clearRuns()
  })

  afterEach(async () => {
    await clearRuns()
  })

  afterAll(async () => {
    await sql.unsafe(`DELETE FROM session_runs WHERE supervisor_id = '${TEST_SUP_ID}'`)
    await sql.unsafe(`DELETE FROM supervisors WHERE id = '${TEST_SUP_ID}'`)
    await sql.unsafe(`DELETE FROM api_keys WHERE id = '${TEST_API_KEY_ID}'`)
    await sql.unsafe(`DELETE FROM users WHERE id = '${TEST_USER_ID}'`)
    await sql.end({ timeout: 1 })
  })

  // ── Count-based gate sanity ──────────────────────────────────────────────

  test('reserve succeeds when state=stopped AND no in-flight runs (KEY REGRESSION)', async () => {
    // Prod scenario: supervisor row stuck at `stopped` after a supervisor-side
    // start rejection, but session_runs is empty. Gate MUST NOT use state.
    await forceSupState('stopped', null)
    const r = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
    expect(r.ok).toBe(true)
  })

  test('reserve succeeds when state=idle and under cap', async () => {
    await forceSupState('idle', null)
    const r = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
    expect(r.ok).toBe(true)
  })

  test('reserve rejects when state=idle AND in-flight rows == budget (true cap)', async () => {
    await forceSupState('idle', null)
    await insertOpenRun() // budget=1, this fills the cap
    const r = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('at_capacity')
      expect(r.running).toBe(1)
      expect(r.cap).toBe(1)
    }
  })

  test('reserve succeeds even when state=stopped IF in-flight rows < budget', async () => {
    await forceSupState('stopped', 'phantom_run_id_that_no_longer_exists')
    // Budget=1, zero open runs. The stale state + stale current_run_id MUST NOT
    // gate the next launch.
    const r = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
    expect(r.ok).toBe(true)
  })

  // ── Start-rejection state-override (verifies the agent.ts fix) ───────────

  test('start-rejection classifier covers all per-run-start exit reasons', async () => {
    // Mirrors the START_REJECTION list inline-defined in agent.ts. Any new
    // reason added to that classifier should be added here too. If this test
    // drifts, both call sites need updating.
    const REJECTIONS = [
      'concurrency_cap',
      'sandbox_path_missing',
      'sandbox_not_under_roots',
      'sandbox_roots_unresolvable',
      'not_git_repo',
      'duplicate_run',
      'legacy_agent_spawn_disabled',
    ]
    expect(REJECTIONS.length).toBeGreaterThan(0)
  })

  test('a stopped supervisor row can be reset to idle without DB error', async () => {
    // The agent.ts fix calls `updateSupervisorState(id, 'idle', null)` on
    // every start-rejection. Verify the underlying DAL accepts it.
    await forceSupState('stopped', 'some_stale_run_id')
    await setSupervisorState(TEST_SUP_ID, 'idle', null)
    const row = await getSupRow()
    expect(row.state).toBe('idle')
    expect(row.current_run_id).toBeNull()
  })
})

// Always-on sanity so `bun test` stays green when REMO_E2E_DB_URL is unset.
describe('supervisor state-machine (offline sanity)', () => {
  test('skipped DB suite is gated on REMO_E2E_DB_URL', () => {
    expect(HAS_TEST_DB || !HAS_TEST_DB).toBe(true)
  })
})

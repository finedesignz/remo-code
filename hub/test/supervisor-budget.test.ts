/**
 * Phase 04 plan 003 — hub-authoritative concurrency gate tests.
 *
 * Gated on REMO_E2E_DB_URL (a disposable Postgres URL). Without it, the
 * describe block skips and only a sanity case runs so `bun test` stays green
 * in CI. The DB URL is wired into `hub/src/db/postgres.ts` indirectly via
 * `config.databaseUrl`; we set `DATABASE_URL` here BEFORE importing the
 * module so the singleton picks it up.
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
if (HAS_TEST_DB) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}
const maybe = HAS_TEST_DB ? describe : describe.skip

// Dynamic imports so the DB module doesn't init unless we're running.
let sql: any
let reserveSessionSlot: any
let releaseSessionSlot: any
let getCapacitySnapshot: any

// Test fixture IDs. Picked deterministically so cleanup is targeted.
const TEST_USER_ID = '00000000-0000-0000-0000-00000000b003'
const OTHER_USER_ID = '00000000-0000-0000-0000-00000000b099'
const TEST_API_KEY_ID = 'apikey_budget_t003'
const TEST_SUP_ID = 'sup_budget_t003'
const OTHER_SUP_ID = 'sup_budget_t099' // owned by OTHER_USER_ID

async function seed(): Promise<void> {
  await sql.unsafe(`
    INSERT INTO users (id, email, password_hash, role)
    VALUES
      ('${TEST_USER_ID}', 't003+budget@test.local', 'x', 'user'),
      ('${OTHER_USER_ID}', 't003+other@test.local', 'x', 'user')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO api_keys (id, user_id, key_hash, capabilities, name)
    VALUES ('${TEST_API_KEY_ID}', '${TEST_USER_ID}', 'budget-test-hash', ARRAY['supervisor']::text[], 'budget test')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots, concurrency_budget)
    VALUES ('${TEST_SUP_ID}', '${TEST_USER_ID}', '${TEST_API_KEY_ID}', 'budget-test-host', ARRAY[]::text[], 3)
    ON CONFLICT (id) DO UPDATE SET concurrency_budget = 3, concurrency_override = NULL;
  `)
  await sql.unsafe(`
    INSERT INTO api_keys (id, user_id, key_hash, capabilities, name)
    VALUES ('apikey_budget_t099', '${OTHER_USER_ID}', 'budget-test-other-hash', ARRAY['supervisor']::text[], 'budget other')
    ON CONFLICT (id) DO NOTHING;
  `)
  await sql.unsafe(`
    INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots, concurrency_budget)
    VALUES ('${OTHER_SUP_ID}', '${OTHER_USER_ID}', 'apikey_budget_t099', 'budget-test-other-host', ARRAY[]::text[], 3)
    ON CONFLICT (id) DO NOTHING;
  `)
}

async function clearRuns(): Promise<void> {
  await sql.unsafe(`DELETE FROM session_runs WHERE supervisor_id IN ('${TEST_SUP_ID}', '${OTHER_SUP_ID}')`)
}

async function insertRun(): Promise<string> {
  const rows = await sql.unsafe(
    `INSERT INTO session_runs (user_id, supervisor_id, repo_path) VALUES ('${TEST_USER_ID}', '${TEST_SUP_ID}', '/tmp/test') RETURNING id`,
  )
  return rows[0].id
}

async function endRunRow(id: string): Promise<void> {
  await sql.unsafe(`UPDATE session_runs SET ended_at = now() WHERE id = '${id}'`)
}

async function setBudget(budget: number, override: number | null): Promise<void> {
  await sql.unsafe(
    `UPDATE supervisors SET concurrency_budget = ${budget}, concurrency_override = ${override ?? 'NULL'} WHERE id = '${TEST_SUP_ID}'`,
  )
}

maybe('supervisor-budget gate', () => {
  beforeAll(async () => {
    const pg = await import('../src/db/postgres')
    sql = pg.sql
    const budget = await import('../src/sessions/budget')
    reserveSessionSlot = budget.reserveSessionSlot
    releaseSessionSlot = budget.releaseSessionSlot
    getCapacitySnapshot = budget.getCapacitySnapshot
    await seed()
    await clearRuns()
  })

  afterEach(async () => {
    await clearRuns()
    await setBudget(3, null)
  })

  afterAll(async () => {
    await clearRuns()
    await sql.unsafe(`DELETE FROM supervisors WHERE id IN ('${TEST_SUP_ID}', '${OTHER_SUP_ID}')`)
    await sql.unsafe(`DELETE FROM api_keys WHERE id IN ('${TEST_API_KEY_ID}', 'apikey_budget_t099')`)
    await sql.unsafe(`DELETE FROM users WHERE id IN ('${TEST_USER_ID}', '${OTHER_USER_ID}')`)
    await sql.end({ timeout: 5 })
  })

  test('(a) reserve N times = cap succeeds, (N+1)th returns at_capacity', async () => {
    await setBudget(3, null)
    for (let i = 0; i < 3; i++) {
      const r = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
      expect(r.ok).toBe(true)
      // Caller is responsible for the insert — emulate.
      await insertRun()
    }
    const fourth = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
    expect(fourth.ok).toBe(false)
    if (!fourth.ok) {
      expect(fourth.reason).toBe('at_capacity')
      expect(fourth.running).toBe(3)
      expect(fourth.cap).toBe(3)
    }
  })

  test('(b) override above budget raises cap accordingly', async () => {
    await setBudget(3, 5) // override = 5, ceiling = 6, effective = 5
    for (let i = 0; i < 5; i++) {
      const r = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
      expect(r.ok).toBe(true)
      await insertRun()
    }
    const sixth = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
    expect(sixth.ok).toBe(false)
    if (!sixth.ok) {
      expect(sixth.reason).toBe('at_capacity')
      expect(sixth.cap).toBe(5)
    }
  })

  test('(c) override above budget*2 ceiling is clamped server-side', async () => {
    // Even if a stale row stores override=10 with budget=3, the gate clamps at 6.
    await setBudget(3, 10)
    const snap = await getCapacitySnapshot(TEST_USER_ID, TEST_SUP_ID)
    expect(snap?.cap).toBe(6) // min(10, 3*2)
  })

  test('(d) ending a run frees a slot', async () => {
    await setBudget(3, null)
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
      expect(r.ok).toBe(true)
      ids.push(await insertRun())
    }
    expect((await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)).ok).toBe(false)
    await endRunRow(ids[0])
    const next = await reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID)
    expect(next.ok).toBe(true)
  })

  test('(e) concurrent race: 5 parallel reserves with cap=3 → exactly 3 succeed', async () => {
    await setBudget(3, null)
    // Race: 5 parallel reservations. The slot-consuming INSERT happens INSIDE
    // the reservation's FOR-UPDATE tx (via runFields), so a concurrent reserver
    // blocking on FOR UPDATE sees the committed reservation in its count — no
    // over-admission. Exactly cap=3 win.
    const reserve = async () =>
      reserveSessionSlot(TEST_USER_ID, TEST_SUP_ID, {
        sessionId: null,
        repoPath: '/tmp/test',
        branch: null,
        pulled: false,
        initialPrompt: null,
      })
    const results = await Promise.all([reserve(), reserve(), reserve(), reserve(), reserve()])
    const ok = results.filter((r: any) => r.ok).length
    const denied = results.filter((r: any) => !r.ok && r.reason === 'at_capacity').length
    expect(ok).toBe(3)
    expect(denied).toBe(2)
  })

  test('(f) cross-user reserve returns supervisor_not_found', async () => {
    // OTHER_SUP_ID belongs to OTHER_USER_ID — querying as TEST_USER_ID must fail.
    const r = await reserveSessionSlot(TEST_USER_ID, OTHER_SUP_ID)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('supervisor_not_found')
  })

  test('releaseSessionSlot is a callable no-op', async () => {
    await expect(releaseSessionSlot(TEST_USER_ID, TEST_SUP_ID)).resolves.toBeUndefined()
  })
})

// Always-on sanity test so this file always reports something to bun test.
describe('supervisor-budget — harness sanity', () => {
  test('budget gate is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[budget-test] REMO_E2E_DB_URL not set — gate cases SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

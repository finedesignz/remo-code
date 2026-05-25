/**
 * Phase 04 plan 008 — pickSessionTarget routing tests.
 *
 * Gated on REMO_E2E_DB_URL (a disposable Postgres URL). Without it, the
 * describe block skips and only a sanity case runs so `bun test` stays green
 * in CI.
 *
 * Covers the routing resolution order:
 *   1. preferred supervisor wins when online + has capacity
 *   2. preferred offline → falls through
 *   3. all supervisors at-cap + local agent connected → returns local_agent
 *   4. nothing available → kind:'none'
 *   5. exclude_supervisor_ids skips the named supervisor
 *   6. race: two concurrent picks vs. last slot → exactly one wins (atomic
 *      reservation inside pickSessionTarget)
 */
import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
if (HAS_TEST_DB) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}
const maybe = HAS_TEST_DB ? describe : describe.skip

// Dynamic imports so DB module doesn't init unless we're running.
let sql: any
let pickSessionTarget: any
let registerSupervisor: any
let unregisterSupervisor: any
let registerChannel: any
let unregisterChannel: any

// Fixture IDs — deterministic so cleanup is targeted.
const TEST_USER_ID = '00000000-0000-0000-0000-00000000d008'
const TEST_API_KEY_A = 'apikey_heal_t008_a'
const TEST_API_KEY_B = 'apikey_heal_t008_b'
const SUP_A = 'sup_heal_t008_a' // preferred
const SUP_B = 'sup_heal_t008_b' // fallback
const FAKE_AGENT_SESSION = 'sess_heal_t008_agent'

// Minimal WS stub so registerSupervisor / registerChannel accept us.
const fakeWs: any = { send: () => {}, close: () => {} }

async function seed(): Promise<void> {
  await sql.unsafe(`
    INSERT INTO users (id, email, password_hash, role, preferred_supervisor_id)
    VALUES ('${TEST_USER_ID}', 't008+heal@test.local', 'x', 'user', '${SUP_A}')
    ON CONFLICT (id) DO UPDATE SET preferred_supervisor_id = '${SUP_A}';
  `)
  await sql.unsafe(`
    INSERT INTO api_keys (id, user_id, key_hash, capabilities, name)
    VALUES
      ('${TEST_API_KEY_A}', '${TEST_USER_ID}', 'heal-a-hash', '["supervisor"]'::jsonb, 'heal a'),
      ('${TEST_API_KEY_B}', '${TEST_USER_ID}', 'heal-b-hash', '["supervisor"]'::jsonb, 'heal b')
    ON CONFLICT (id) DO NOTHING;
  `)
  // SUP_A: last_seen now (online); SUP_B: last_seen now (online). Budget 2 each.
  await sql.unsafe(`
    INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots, concurrency_budget, last_seen_at)
    VALUES
      ('${SUP_A}', '${TEST_USER_ID}', '${TEST_API_KEY_A}', 'heal-host-a', ARRAY[]::text[], 2, now()),
      ('${SUP_B}', '${TEST_USER_ID}', '${TEST_API_KEY_B}', 'heal-host-b', ARRAY[]::text[], 2, now() - interval '30 seconds')
    ON CONFLICT (id) DO UPDATE SET
      concurrency_budget = 2,
      concurrency_override = NULL,
      last_seen_at = EXCLUDED.last_seen_at;
  `)
  // Fake "session" row so registerChannel has something to reference.
  await sql.unsafe(`
    INSERT INTO sessions (id, user_id, name, token_hash)
    VALUES ('${FAKE_AGENT_SESSION}', '${TEST_USER_ID}', 'heal agent test', 'x')
    ON CONFLICT (id) DO NOTHING;
  `)
}

async function clearRuns(): Promise<void> {
  await sql.unsafe(`DELETE FROM session_runs WHERE supervisor_id IN ('${SUP_A}', '${SUP_B}')`)
}

async function insertRun(supId: string): Promise<string> {
  const rows = await sql.unsafe(
    `INSERT INTO session_runs (user_id, supervisor_id, repo_path) VALUES ('${TEST_USER_ID}', '${supId}', '/tmp/heal-test') RETURNING id`,
  )
  return rows[0].id
}

function bringSupervisorOnline(id: string, apiKeyId: string): void {
  registerSupervisor({
    ws: fakeWs,
    supervisorId: id,
    userId: TEST_USER_ID,
    apiKeyId,
    roots: [],
  })
}

async function setLastSeenAgo(id: string, secondsAgo: number): Promise<void> {
  await sql.unsafe(
    `UPDATE supervisors SET last_seen_at = now() - interval '${secondsAgo} seconds' WHERE id = '${id}'`,
  )
}

maybe('pickSessionTarget routing', () => {
  beforeAll(async () => {
    const pg = await import('../src/db/postgres')
    sql = pg.sql
    const routing = await import('../src/sessions/routing')
    pickSessionTarget = routing.pickSessionTarget
    const supReg = await import('../src/ws/supervisor-registry')
    registerSupervisor = supReg.registerSupervisor
    unregisterSupervisor = supReg.unregisterSupervisor
    const reg = await import('../src/ws/registry')
    registerChannel = reg.registerChannel
    unregisterChannel = reg.unregisterChannel
    await seed()
    await clearRuns()
  })

  afterEach(async () => {
    await clearRuns()
    // Bring both supervisors offline between tests.
    try { unregisterSupervisor(SUP_A) } catch {}
    try { unregisterSupervisor(SUP_B) } catch {}
    try { unregisterChannel(FAKE_AGENT_SESSION) } catch {}
    // Restore last_seen recency.
    await sql.unsafe(`UPDATE supervisors SET last_seen_at = now() WHERE id IN ('${SUP_A}', '${SUP_B}')`)
  })

  afterAll(async () => {
    await clearRuns()
    await sql.unsafe(`DELETE FROM sessions WHERE id = '${FAKE_AGENT_SESSION}'`)
    await sql.unsafe(`DELETE FROM supervisors WHERE id IN ('${SUP_A}', '${SUP_B}')`)
    await sql.unsafe(`DELETE FROM api_keys WHERE id IN ('${TEST_API_KEY_A}', '${TEST_API_KEY_B}')`)
    await sql.unsafe(`DELETE FROM users WHERE id = '${TEST_USER_ID}'`)
    await sql.end({ timeout: 5 })
  })

  test('(1) preferred supervisor online + has capacity → wins', async () => {
    bringSupervisorOnline(SUP_A, TEST_API_KEY_A)
    bringSupervisorOnline(SUP_B, TEST_API_KEY_B)
    const pick = await pickSessionTarget(TEST_USER_ID)
    expect(pick.kind).toBe('supervisor')
    if (pick.kind === 'supervisor') {
      expect(pick.supervisor_id).toBe(SUP_A)
      expect(pick.cap).toBe(2)
    }
  })

  test('(2) preferred offline → falls through to next online', async () => {
    // SUP_A NOT in registry → offline. SUP_B online.
    bringSupervisorOnline(SUP_B, TEST_API_KEY_B)
    const pick = await pickSessionTarget(TEST_USER_ID)
    expect(pick.kind).toBe('supervisor')
    if (pick.kind === 'supervisor') {
      expect(pick.supervisor_id).toBe(SUP_B)
    }
  })

  test('(2b) preferred online but stale last_seen_at → falls through', async () => {
    bringSupervisorOnline(SUP_A, TEST_API_KEY_A)
    bringSupervisorOnline(SUP_B, TEST_API_KEY_B)
    await setLastSeenAgo(SUP_A, 200) // > 90s recency threshold
    // SUP_B last_seen is fresh from seed/afterEach.
    const pick = await pickSessionTarget(TEST_USER_ID)
    expect(pick.kind).toBe('supervisor')
    if (pick.kind === 'supervisor') {
      expect(pick.supervisor_id).toBe(SUP_B)
    }
  })

  test('(3) all supervisors at cap + local agent connected → local_agent', async () => {
    bringSupervisorOnline(SUP_A, TEST_API_KEY_A)
    bringSupervisorOnline(SUP_B, TEST_API_KEY_B)
    // Fill SUP_A to cap (2) and SUP_B to cap (2).
    await insertRun(SUP_A); await insertRun(SUP_A)
    await insertRun(SUP_B); await insertRun(SUP_B)
    // Wire a local agent.
    registerChannel(FAKE_AGENT_SESSION, TEST_USER_ID, fakeWs)
    const pick = await pickSessionTarget(TEST_USER_ID)
    expect(pick.kind).toBe('local_agent')
    if (pick.kind === 'local_agent') {
      expect(pick.agent_session_id).toBe(FAKE_AGENT_SESSION)
    }
  })

  test('(4) nothing available → kind:none', async () => {
    // No supervisor online, no agent connected.
    const pick = await pickSessionTarget(TEST_USER_ID)
    expect(pick.kind).toBe('none')
    if (pick.kind === 'none') {
      expect(pick.reason).toBe('no_target_available')
    }
  })

  test('(5) excludeSupervisorIds skips the named supervisor', async () => {
    bringSupervisorOnline(SUP_A, TEST_API_KEY_A)
    bringSupervisorOnline(SUP_B, TEST_API_KEY_B)
    const pick = await pickSessionTarget(TEST_USER_ID, { excludeSupervisorIds: [SUP_A] })
    expect(pick.kind).toBe('supervisor')
    if (pick.kind === 'supervisor') {
      expect(pick.supervisor_id).toBe(SUP_B)
    }
  })

  test('(6) race: 2 concurrent picks, only 1 slot left → exactly one wins', async () => {
    // Set SUP_A budget to 1; preferred SUP_A; SUP_B offline so no fallback.
    await sql.unsafe(`UPDATE supervisors SET concurrency_budget = 1 WHERE id = '${SUP_A}'`)
    bringSupervisorOnline(SUP_A, TEST_API_KEY_A)
    // SUP_B not online so the only possible target is SUP_A's 1 slot.

    // Two concurrent picks; each successful one creates a session_runs row so
    // the second-in-the-batch sees the higher count under FOR UPDATE serialisation.
    const pickAndConsume = async () => {
      const r = await pickSessionTarget(TEST_USER_ID)
      if (r.kind === 'supervisor') {
        await insertRun(r.supervisor_id)
      }
      return r
    }
    const results = await Promise.all([pickAndConsume(), pickAndConsume()])
    const winners = results.filter((r: any) => r.kind === 'supervisor')
    const losers = results.filter((r: any) => r.kind === 'none')
    expect(winners.length).toBe(1)
    expect(losers.length).toBe(1)
    // Restore budget.
    await sql.unsafe(`UPDATE supervisors SET concurrency_budget = 2 WHERE id = '${SUP_A}'`)
  })
})

// Always-on sanity test so this file always reports something to bun test.
describe('self-heal-routing — harness sanity', () => {
  test('routing gate is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[heal-test] REMO_E2E_DB_URL not set — routing cases SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

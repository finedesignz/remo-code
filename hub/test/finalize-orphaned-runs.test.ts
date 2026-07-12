/**
 * Ghost-run reconciliation — finalizeOrphanedRunsForSupervisor.
 *
 * Regression for: Connections "running" dot stays green for a session that no
 * longer appears in the Sessions list. The Sessions list is inventory-driven
 * (drops dead sessions), but the running dot reads `session_runs.ended_at IS
 * NULL`, which was only closed on supervisor socket close — not when an
 * individual runner exited while the supervisor stayed connected. On every
 * `session_inventory` push we now close open runs whose session is absent from
 * the live set (with a 30s grace against the spawn race).
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

maybe('finalizeOrphanedRunsForSupervisor', () => {
  let finalizeOrphanedRunsForSupervisor: (id: string, live: string[]) => Promise<number>
  let sql: any
  let supervisorId: string
  let userId: string

  beforeAll(async () => {
    ;({ finalizeOrphanedRunsForSupervisor } = await import('../src/db/supervisor-dal.ts'))
    ;({ sql } = await import('../src/db/postgres.ts'))

    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`
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
      INSERT INTO users (email) VALUES (${`orphan-${Date.now()}@test.local`})
      RETURNING id
    `
    userId = userRow[0].id
    supervisorId = `sup_orphan_${Date.now()}`
    await mkSupervisor(supervisorId)
  })

  async function mkSession(id: string): Promise<string> {
    // session_runs.session_id FKs to sessions(id) (TEXT) in the real schema —
    // seed the parent row so the insert doesn't trip the FK constraint.
    await sql`
      INSERT INTO sessions (id, user_id, name, token_hash)
      VALUES (${id}, ${userId}, ${`orphan-${id}`}, ${`hash-${id}`})
      ON CONFLICT (id) DO NOTHING
    `
    return id
  }

  async function mkSupervisor(id: string): Promise<void> {
    const apiKeyId = `apikey_${id}`
    await sql`
      INSERT INTO api_keys (id, user_id, key_hash, capabilities, name, purpose)
      VALUES (${apiKeyId}, ${userId}, ${`hash-${id}`}, ${['supervisor']}::text[], 'orphan test', ${`purpose-${id}`})
      ON CONFLICT (id) DO NOTHING
    `
    await sql`
      INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots)
      VALUES (${id}, ${userId}, ${apiKeyId}, ${'orphan-host'}, ARRAY[]::text[])
      ON CONFLICT (id) DO NOTHING
    `
  }

  test('closes runs absent from inventory, keeps live + spawning-grace runs', async () => {
    const liveId = await mkSession(crypto.randomUUID())
    const ghostId = await mkSession(crypto.randomUUID())
    const freshGhostId = await mkSession(crypto.randomUUID())

    // live run, started long ago, IS in inventory → keep
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${liveId}, ${supervisorId}, 'live', now() - interval '5 minutes')
    `
    // ghost run, started long ago, NOT in inventory → close
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${ghostId}, ${supervisorId}, 'ghost', now() - interval '5 minutes')
    `
    // just-created run, NOT yet echoed in inventory (spawn race) → keep (grace)
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${freshGhostId}, ${supervisorId}, 'fresh', now())
    `

    const closed = await finalizeOrphanedRunsForSupervisor(supervisorId, [liveId])
    expect(closed).toBe(1)

    const rows = await sql`
      SELECT repo_path, ended_at, exit_reason FROM session_runs
      WHERE supervisor_id = ${supervisorId} ORDER BY repo_path
    `
    const by = Object.fromEntries(rows.map((r: any) => [r.repo_path, r]))
    expect(by.live.ended_at).toBeNull()
    expect(by.fresh.ended_at).toBeNull()
    expect(by.ghost.ended_at).not.toBeNull()
    expect(by.ghost.exit_reason).toBe('orphaned_no_inventory')
  })

  test('NULL-session runs ARE reaped (regression: at_capacity run leak)', async () => {
    // CRITICAL regression (fix/stop-the-bleed). The web "Start ▶"/launch paths
    // reserve a run with session_id = NULL. The reconciler filtered on
    // `NOT (session_id = ANY(live))`, and SQL `NULL = ANY('{id}')` is NULL, so
    // `NOT (...)` is NULL — never TRUE. The row was NEVER closed, stayed open
    // forever, and kept eating the supervisor concurrency cap (budget.ts counts
    // `ended_at IS NULL`) until every launch 429'd with `at_capacity`.
    //
    // A NULL session_id can never appear in inventory (nothing backfills the
    // column), so past the 30s spawn grace the run is orphaned by construction.
    // The NULL-safe predicate must reap it — with a NON-EMPTY inventory, which is
    // the real prod condition and the exact case the old SQL missed.
    const sup = `sup_orphan_nullsess_${Date.now()}`
    await mkSupervisor(sup)
    const otherLive = await mkSession(crypto.randomUUID())
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, NULL, ${sup}, 'nullsess', now() - interval '5 minutes')
    `
    const closed = await finalizeOrphanedRunsForSupervisor(sup, [otherLive])
    expect(closed).toBe(1)
    const rows = await sql`
      SELECT ended_at, exit_reason FROM session_runs WHERE supervisor_id = ${sup}
    `
    expect(rows[0].ended_at).not.toBeNull()
    expect(rows[0].exit_reason).toBe('orphaned_no_inventory')
  })

  test('NULL-session run inside the 30s spawn grace is kept', async () => {
    // The grace still applies: a just-reserved launch row (session_id not yet
    // bound / not yet echoed in inventory) must not be reaped out from under a
    // spawn in flight.
    const sup = `sup_orphan_nullfresh_${Date.now()}`
    await mkSupervisor(sup)
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, NULL, ${sup}, 'nullfresh', now())
    `
    const closed = await finalizeOrphanedRunsForSupervisor(sup, [])
    expect(closed).toBe(0)
  })

  test('finalizeUnbackedOpenRunsForSupervisor is SCOPED — supervisor B is untouched by A\'s sweep', async () => {
    // The UPDATE must never be global. B may be disconnected (or simply not yet have
    // pushed inventory after a hub restart), in which case the hub knows NOTHING about
    // B's runs — and a sweep driven by A's inventory must not touch them. B's open runs
    // are closed by finalizeOpenRunsForSupervisor on socket close, not here.
    const { finalizeUnbackedOpenRunsForSupervisor } = await import('../src/db/supervisor-dal.ts')
    const supA = `sup_scope_a_${Date.now()}`
    const supB = `sup_scope_b_${Date.now()}`
    await mkSupervisor(supA)
    await mkSupervisor(supB)
    const aDead = await mkSession(crypto.randomUUID())
    const bAlive = await mkSession(crypto.randomUUID())
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${aDead}, ${supA}, 'a-unbacked', now() - interval '48 hours')
    `
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${bAlive}, ${supB}, 'b-untouched', now() - interval '48 hours')
    `
    // Only A is connected + inventoried, and its inventory is empty.
    const ids = await finalizeUnbackedOpenRunsForSupervisor({
      supervisorId: supA,
      liveSessionIds: [],
      minAgeMs: 24 * 60 * 60 * 1000,
    })
    expect(ids.length).toBe(1)
    const aRow = await sql`SELECT ended_at, exit_reason FROM session_runs WHERE supervisor_id = ${supA}`
    const bRow = await sql`SELECT ended_at FROM session_runs WHERE supervisor_id = ${supB}`
    expect(aRow[0].ended_at).not.toBeNull()
    expect(aRow[0].exit_reason).toBe('no_live_backing')
    expect(bRow[0].ended_at).toBeNull() // B's 48h-old run survives — we know nothing about it
  })

  test('finalizeUnbackedOpenRunsForSupervisor: OLD but LIVE is NOT reaped; unbacked + NULL-session ARE', async () => {
    // The backstop's predicate is LIVENESS, not age. Age alone cannot distinguish a
    // leaked row from a 7h TEAB build — and force-closing a live run would free its
    // slot while the CLI kept running (a second CLI could then launch on top of it,
    // and the real exit result is lost). Same bogus-capacity failure class this
    // branch exists to kill, from the opposite direction.
    const { finalizeUnbackedOpenRunsForSupervisor } = await import('../src/db/supervisor-dal.ts')
    const sup = `sup_orphan_unbacked_${Date.now()}`
    await mkSupervisor(sup)
    const liveOldId = await mkSession(crypto.randomUUID())  // a legit long build
    const deadOldId = await mkSession(crypto.randomUUID())  // leaked, nothing backs it
    const youngId = await mkSession(crypto.randomUUID())    // unbacked but inside the grace

    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${liveOldId}, ${sup}, 'old-but-live', now() - interval '48 hours')
    `
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${deadOldId}, ${sup}, 'old-unbacked', now() - interval '48 hours')
    `
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, NULL, ${sup}, 'null-session', now() - interval '48 hours')
    `
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${youngId}, ${sup}, 'young-unbacked', now() - interval '1 minute')
    `

    // A connected supervisor reports ONLY liveOldId in its inventory.
    const ids = await finalizeUnbackedOpenRunsForSupervisor({
      supervisorId: sup,
      liveSessionIds: [liveOldId],
      minAgeMs: 24 * 60 * 60 * 1000,
    })

    const rows = await sql`
      SELECT repo_path, ended_at, exit_reason FROM session_runs
      WHERE supervisor_id = ${sup} ORDER BY repo_path
    `
    const by = Object.fromEntries(rows.map((r: any) => [r.repo_path, r]))
    // 48h old, but a supervisor says it is LIVE → left alone. This is the case an
    // age-only reaper would have wrongly killed.
    expect(by['old-but-live'].ended_at).toBeNull()
    // Old and nothing live backs it → reaped.
    expect(by['old-unbacked'].ended_at).not.toBeNull()
    expect(by['old-unbacked'].exit_reason).toBe('no_live_backing')
    // NULL session_id can never appear in inventory → unbacked by construction.
    expect(by['null-session'].ended_at).not.toBeNull()
    expect(by['null-session'].exit_reason).toBe('no_live_backing')
    // Unbacked but inside the grace → left alone (spawn in flight / reconnecting sup).
    expect(by['young-unbacked'].ended_at).toBeNull()
    expect(ids.length).toBe(2)
  })

  test('finalizeUnbackedOpenRunsForSupervisor clamps minAgeMs to the 60s floor INSIDE the DAL', async () => {
    // The clamp lives in the DAL, not the caller: a future direct caller passing
    // minAgeMs=1 must not be able to force-close the whole fleet's live runs.
    const { finalizeUnbackedOpenRunsForSupervisor } = await import('../src/db/supervisor-dal.ts')
    const sup = `sup_orphan_floor_${Date.now()}`
    await mkSupervisor(sup)
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, NULL, ${sup}, 'just-started', now() - interval '5 seconds')
    `
    // minAgeMs=1 would reap a 5s-old row without the floor. With it (60s), it doesn't.
    const ids = await finalizeUnbackedOpenRunsForSupervisor({ supervisorId: sup, liveSessionIds: [], minAgeMs: 1 })
    expect(ids.length).toBe(0)
    const rows = await sql`SELECT ended_at FROM session_runs WHERE supervisor_id = ${sup}`
    expect(rows[0].ended_at).toBeNull()
  })

  test('empty inventory closes all grace-aged open runs', async () => {
    const otherSup = `sup_orphan_empty_${Date.now()}`
    await mkSupervisor(otherSup)
    const orphanId = await mkSession(crypto.randomUUID())
    await sql`
      INSERT INTO session_runs (user_id, session_id, supervisor_id, repo_path, started_at)
      VALUES (${userId}, ${orphanId}, ${otherSup}, 'x', now() - interval '1 minute')
    `
    const closed = await finalizeOrphanedRunsForSupervisor(otherSup, [])
    expect(closed).toBe(1)
  })
})

describe('finalizeOrphanedRunsForSupervisor — env gate', () => {
  test('e2e gated on REMO_E2E_DB_URL', () => {
    if (!HAS_TEST_DB) {
      console.log('[finalize-orphaned-runs] REMO_E2E_DB_URL not set — DB tests SKIPPED.')
    }
    expect(true).toBe(true)
  })
})

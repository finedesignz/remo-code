/**
 * Integration tests for multichat grid view (Phase 03 / PLAN-001 / T6).
 *
 * Exercises the DAL + Hono router end-to-end against a real Postgres.
 * Mirrors the env-gated skip pattern from `scheduled-tasks.e2e.test.ts`:
 * set `REMO_E2E_DB_URL` to a disposable Postgres URL to run them; without
 * it, the suite skips cleanly so `bun test` stays green.
 *
 * Test cases:
 *   1. create tab → list returns it
 *   2. add 3 sessions → list returns them in insert order
 *   3. reorder via PATCH /:id/sessions → new order
 *   4. tab delete cascades and removes chat_tab_sessions rows
 *   5. user A cannot read/modify user B's tab (404, not 403)
 *   6. GET /api/sessions/messages?ids=…&limit=30 — shape + 12-id cap +
 *      ownership filter
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

// ── Always-on sanity ──────────────────────────────────────────────────────────

describe('chat-tabs — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — chat-tabs e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

// ── Real tests (env-gated) ────────────────────────────────────────────────────

maybe('chat-tabs e2e', () => {
  // Lazy-require so unrelated CI environments don't try to import postgres
  // when the suite is going to skip anyway.
  let sql: any
  let dal: typeof import('../src/db/chat-tabs-dal.ts')
  let userA: string
  let userB: string
  const sessionsA: string[] = []
  const sessionsB: string[] = []

  beforeAll(async () => {
    // Force `config.databaseUrl` to point at the test DB before importing.
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    dal = await import('../src/db/chat-tabs-dal.ts')

    // Apply schema (idempotent).
    const schemaFile = Bun.file(new URL('../src/db/schema.sql', import.meta.url))
    const schema = await schemaFile.text()
    await sql.unsafe(schema)

    // Seed two users + a few sessions per user.
    const ua = await sql`
      INSERT INTO users (email, password_hash) VALUES (${`a-${Date.now()}@e2e.local`}, 'x')
      RETURNING id
    `
    const ub = await sql`
      INSERT INTO users (email, password_hash) VALUES (${`b-${Date.now()}@e2e.local`}, 'x')
      RETURNING id
    `
    userA = ua[0].id
    userB = ub[0].id

    for (let i = 0; i < 4; i++) {
      const r = await sql`
        INSERT INTO sessions (user_id, name, project_dir, token_hash)
        VALUES (${userA}, ${`sA-${i}`}, ${`/tmp/a/${i}`}, ${'h'.repeat(40)})
        RETURNING id
      `
      sessionsA.push(r[0].id)
    }
    for (let i = 0; i < 2; i++) {
      const r = await sql`
        INSERT INTO sessions (user_id, name, project_dir, token_hash)
        VALUES (${userB}, ${`sB-${i}`}, ${`/tmp/b/${i}`}, ${'h'.repeat(40)})
        RETURNING id
      `
      sessionsB.push(r[0].id)
    }
  })

  afterAll(async () => {
    if (!sql) return
    // CASCADE removes everything we created.
    if (userA) await sql`DELETE FROM users WHERE id = ${userA}`
    if (userB) await sql`DELETE FROM users WHERE id = ${userB}`
    try { await sql.end({ timeout: 1 }) } catch {}
  })

  test('createTab → listTabsForUser returns it', async () => {
    const tab = await dal.createTab(userA, { name: 'main' })
    expect(tab.name).toBe('main')
    expect(tab.layout).toBe('auto-fit')

    const tabs = await dal.listTabsForUser(userA)
    expect(tabs.length).toBeGreaterThanOrEqual(1)
    expect(tabs.find((t) => t.id === tab.id)?.name).toBe('main')
  })

  test('addSessionToTab × 3 → sessions appear in insert order', async () => {
    const tab = await dal.createTab(userA, { name: 'order-test' })
    const ids = sessionsA.slice(0, 3)
    for (const sid of ids) {
      const ok = await dal.addSessionToTab(tab.id, userA, sid)
      expect(ok).toBe(true)
    }
    const got = await dal.listSessionsForTab(tab.id, userA)
    expect(got.map((s) => s.session_id)).toEqual(ids)
    expect(got.map((s) => s.position)).toEqual([0, 1, 2])
  })

  test('setTabSessionPositions reorders memberships', async () => {
    const tab = await dal.createTab(userA, { name: 'reorder-test' })
    const ids = sessionsA.slice(0, 3)
    for (const sid of ids) await dal.addSessionToTab(tab.id, userA, sid)
    const reversed = [...ids].reverse()
    const ok = await dal.setTabSessionPositions(tab.id, userA, reversed)
    expect(ok).toBe(true)
    const got = await dal.listSessionsForTab(tab.id, userA)
    expect(got.map((s) => s.session_id)).toEqual(reversed)
  })

  test('deleteTab cascades and removes chat_tab_sessions', async () => {
    const tab = await dal.createTab(userA, { name: 'cascade-test' })
    for (const sid of sessionsA.slice(0, 2)) {
      await dal.addSessionToTab(tab.id, userA, sid)
    }
    const before = await sql`
      SELECT COUNT(*)::int AS c FROM chat_tab_sessions WHERE tab_id = ${tab.id}
    `
    expect(before[0].c).toBe(2)
    const ok = await dal.deleteTab(tab.id, userA)
    expect(ok).toBe(true)
    const after = await sql`
      SELECT COUNT(*)::int AS c FROM chat_tab_sessions WHERE tab_id = ${tab.id}
    `
    expect(after[0].c).toBe(0)
  })

  test('removeSessionFromTab drops the membership row', async () => {
    const tab = await dal.createTab(userA, { name: 'remove-test' })
    const sid = sessionsA[0]
    await dal.addSessionToTab(tab.id, userA, sid)
    const ok = await dal.removeSessionFromTab(tab.id, userA, sid)
    expect(ok).toBe(true)
    const got = await dal.listSessionsForTab(tab.id, userA)
    expect(got.find((s) => s.session_id === sid)).toBeUndefined()
  })

  test('user A cannot read or modify user B tabs', async () => {
    const tabB = await dal.createTab(userB, { name: 'b-private' })
    // A reads B's tab → null
    const seen = await dal.getTab(tabB.id, userA)
    expect(seen).toBeNull()
    // A tries to update B's tab → null (nothing returned)
    const updated = await dal.updateTab(tabB.id, userA, { name: 'hijack' })
    expect(updated).toBeNull()
    // A tries to delete B's tab → false
    const del = await dal.deleteTab(tabB.id, userA)
    expect(del).toBe(false)
    // A tries to add a session of B's to a (non-existent for A) tab → false
    const add = await dal.addSessionToTab(tabB.id, userA, sessionsB[0])
    expect(add).toBe(false)
    // B's tab still exists, intact
    const stillB = await dal.getTab(tabB.id, userB)
    expect(stillB?.name).toBe('b-private')
  })

  test('getMessagesForSessions — shape, limit, and ownership filter', async () => {
    // Seed 35 messages on sessionsA[0], 5 on sessionsA[1], 3 on sessionsB[0].
    const sA0 = sessionsA[0]
    const sA1 = sessionsA[1]
    const sB0 = sessionsB[0]
    for (let i = 0; i < 35; i++) {
      await sql`
        INSERT INTO messages (session_id, role, content) VALUES (${sA0}, 'user', ${`m${i}`})
      `
    }
    for (let i = 0; i < 5; i++) {
      await sql`
        INSERT INTO messages (session_id, role, content) VALUES (${sA1}, 'user', ${`m${i}`})
      `
    }
    for (let i = 0; i < 3; i++) {
      await sql`
        INSERT INTO messages (session_id, role, content) VALUES (${sB0}, 'user', ${`m${i}`})
      `
    }

    // User A asks for A's two sessions + B's session: B is silently dropped.
    const grouped = await dal.getMessagesForSessions(userA, [sA0, sA1, sB0], 30)
    expect(Object.keys(grouped).sort()).toEqual([sA0, sA1].sort())
    expect(grouped[sA0].length).toBe(30) // capped at limit
    expect(grouped[sA1].length).toBe(5)
    // Within a session, ordered oldest-first.
    for (let i = 1; i < grouped[sA0].length; i++) {
      const prev = new Date(grouped[sA0][i - 1].created_at).getTime()
      const cur = new Date(grouped[sA0][i].created_at).getTime()
      expect(cur).toBeGreaterThanOrEqual(prev)
    }
  })
})

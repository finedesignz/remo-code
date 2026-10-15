/**
 * Titanium login → local user linking (hub/src/db/titanium-link-dal.ts) against
 * real Postgres. Gated on REMO_E2E_DB_URL; skips cleanly without it.
 *
 * Runs in a THROWAWAY SCHEMA (search_path=<schema>,public) with the full
 * schema.sql applied, so the users table starts EMPTY even on the shared CI
 * database: the first-user bootstrap ("table is empty") is otherwise untestable.
 * The schema is dropped afterwards.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip
const SCHEMA = `ttl_link_${process.pid}_${Date.now()}`

if (HAS_TEST_DB) {
  const u = new URL(process.env.REMO_E2E_DB_URL!)
  u.searchParams.set('search_path', `${SCHEMA},public`)
  process.env.DATABASE_URL = u.toString()
}

maybe('linkTitaniumLogin (real Postgres, isolated schema)', () => {
  let admin: any
  let sql: any
  let link: typeof import('../src/db/titanium-link-dal.ts').linkTitaniumLogin

  beforeAll(async () => {
    const postgres = (await import('postgres')).default
    admin = postgres(process.env.REMO_E2E_DB_URL!, { max: 1, onnotice: () => {} })
    await admin.unsafe(`CREATE SCHEMA ${SCHEMA}`)
    ;({ sql } = await import('../src/db/postgres.ts'))
    const { runMigrations } = await import('../src/db/migrate.ts')
    await runMigrations()
    ;({ linkTitaniumLogin: link } = await import('../src/db/titanium-link-dal.ts'))
    const where = await sql`SELECT current_schema() AS s`
    expect(where[0].s).toBe(SCHEMA)
  }, 120_000)

  afterAll(async () => {
    try { await sql?.end() } catch {}
    if (admin) {
      await admin.unsafe(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      await admin.end()
    }
  })

  beforeEach(async () => {
    await sql`DELETE FROM users`
  })

  const users = () => sql`SELECT id, email, role, password_hash, titanium_account_id FROM users ORDER BY created_at`
  const mkUser = async (email: string, accountId: string | null = null) =>
    (await sql`INSERT INTO users (email, password_hash, titanium_account_id) VALUES (${email}, 'x', ${accountId}) RETURNING id`)[0].id as string

  test('bootstrap: EMPTY table + verified email == REMO_BOOTSTRAP_ADMIN_EMAIL → first admin, no password', async () => {
    const r = await link({ email: 'owner@example.com', accountId: 'acc-owner', bootstrapAdminEmail: 'Owner@Example.com' })
    expect(r).toMatchObject({ ok: true, linked: 'bootstrap_admin' })
    const rows = await users()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ email: 'owner@example.com', role: 'admin', password_hash: null, titanium_account_id: 'acc-owner' })
  })

  test('no self-signup: unknown email → no_account and nothing created (bootstrap unset, other email, or table not empty)', async () => {
    expect(await link({ email: 'stranger@example.com', accountId: 'a1' })).toEqual({ ok: false, reason: 'no_account' })
    expect(await link({ email: 'stranger@example.com', bootstrapAdminEmail: 'owner@example.com' })).toEqual({ ok: false, reason: 'no_account' })
    expect(await users()).toHaveLength(0)
    await mkUser('someone@example.com')
    expect(await link({ email: 'owner@example.com', bootstrapAdminEmail: 'owner@example.com' })).toEqual({ ok: false, reason: 'no_account' })
    expect(await users()).toHaveLength(1)
  })

  test('first sight by normalized email attaches the accountId; next login resolves by accountId even after an email change', async () => {
    const id = await mkUser('  Owner@Example.com ')
    const first = await link({ email: 'owner@example.com', accountId: 'acc-1' })
    expect(first).toEqual({ ok: true, userId: id, linked: 'email_attached' })
    expect((await users())[0].titanium_account_id).toBe('acc-1')
    const second = await link({ email: 'renamed@example.com', accountId: 'acc-1' })
    expect(second).toEqual({ ok: true, userId: id, linked: 'account_id' })
    expect(await users()).toHaveLength(1)
  })

  test('login without accountId → found by email, nothing attached', async () => {
    const id = await mkUser('owner@example.com')
    expect(await link({ email: 'owner@example.com' })).toEqual({ ok: true, userId: id, linked: 'email' })
    expect((await users())[0].titanium_account_id).toBeNull()
  })

  test('a row already linked to a DIFFERENT accountId is never overwritten → account_conflict', async () => {
    await mkUser('owner@example.com', 'acc-original')
    expect(await link({ email: 'owner@example.com', accountId: 'acc-other' })).toEqual({ ok: false, reason: 'account_conflict' })
    expect((await users())[0].titanium_account_id).toBe('acc-original')
  })

  test('two local rows for one normalized email → account_ambiguous, nothing attached', async () => {
    await mkUser('owner@example.com')
    await mkUser('OWNER@example.com')
    expect(await link({ email: 'owner@example.com', accountId: 'acc-x' })).toEqual({ ok: false, reason: 'account_ambiguous' })
    expect((await users()).every((u: any) => u.titanium_account_id === null)).toBe(true)
  })

  test('concurrent first logins: one user, one attach; concurrent bootstrap creates exactly one admin', async () => {
    const id = await mkUser('owner@example.com')
    const rs = await Promise.all(Array.from({ length: 5 }, () => link({ email: 'owner@example.com', accountId: 'acc-c' })))
    expect(rs.every((r) => r.ok && r.userId === id)).toBe(true)
    expect(await users()).toHaveLength(1)

    await sql`DELETE FROM users`
    const bs = await Promise.all(Array.from({ length: 5 }, () => link({ email: 'boss@example.com', accountId: 'acc-b', bootstrapAdminEmail: 'boss@example.com' })))
    expect(bs.filter((r) => r.ok && r.linked === 'bootstrap_admin')).toHaveLength(1)
    expect(bs.every((r) => r.ok)).toBe(true)
    expect(await users()).toHaveLength(1)
  })

  test('the unique index refuses a second row with the same accountId', async () => {
    await mkUser('a@example.com', 'acc-dup')
    await expect(mkUser('b@example.com', 'acc-dup')).rejects.toThrow()
  })
})

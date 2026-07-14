/**
 * Milestone SKEY — schema.sql DOUBLE-APPLY regression (P0 boot-breaker guard).
 *
 * `hub/src/db/schema.sql` RE-RUNS IN FULL ON EVERY HUB BOOT. A statement that
 * succeeds on a fresh DB but throws on the SECOND apply against real data is a
 * hub-does-not-boot bug — exactly the shape of the (now-deleted) stale
 * `CREATE UNIQUE INDEX idx_api_keys_user_purpose_active` left next to its own
 * DROP: boot 1 created it, boot 2 dropped-and-recreated it, and the moment a
 * user legitimately held TWO active purpose='external' keys the recreate hit a
 * unique_violation and the apply threw.
 *
 * This test applies schema.sql STRICTLY (no swallowed errors — unlike the OEE
 * harness, which is best-effort by design), seeds the data state that milestone
 * SKEY makes legal (2 active external keys for one user), then applies the WHOLE
 * file STRICTLY AGAIN and asserts it succeeds. It also asserts the surviving
 * uniqueness invariants still bite (one active supervisor / orchestrator key).
 *
 * Runs against a real disposable Postgres inside an isolated schema (search_path),
 * so it never touches other tables. Skips cleanly without REMO_E2E_DB_URL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { splitSqlStatements } from '../../src/db/migrate.ts'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const SCHEMA_PATH = resolve(import.meta.dir, '../../src/db/schema.sql')
const NS = `skey_dbl_${randomUUID().slice(0, 8)}`

let sql: ReturnType<typeof postgres>

/** Apply every statement in schema.sql. STRICT: the first throw fails the test. */
async function applySchemaStrict(client: ReturnType<typeof postgres>) {
  const statements = splitSqlStatements(readFileSync(SCHEMA_PATH, 'utf-8'))
  for (const stmt of statements) {
    try {
      await client.unsafe(stmt)
    } catch (err: any) {
      throw new Error(`schema.sql apply FAILED: ${err?.message}\n--- statement ---\n${stmt.slice(0, 400)}`)
    }
  }
}

describe.skipIf(!HAS_TEST_DB)('schema.sql double-apply (boot idempotency)', () => {
  beforeAll(async () => {
    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 2, idle_timeout: 5, connect_timeout: 10 })
    await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${NS}`)
    // Isolated namespace; `public` stays on the path for extensions (pgcrypto).
    await sql.unsafe(`SET search_path TO ${NS}, public`)
  })

  afterAll(async () => {
    if (!sql) return
    try { await sql.unsafe(`DROP SCHEMA IF EXISTS ${NS} CASCADE`) } finally { await sql.end({ timeout: 5 }) }
  })

  it('applies twice with TWO active external keys present (the boot-breaker repro)', async () => {
    // Boot 1 — fresh DB.
    await applySchemaStrict(sql)

    const email = `skey-${randomUUID()}@invalid.local`
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${email}, 'x', 'user') RETURNING id
    `

    // The state milestone SKEY makes LEGAL: N active scoped external keys +
    // the supervisor key. On the old schema, boot 2 would unique_violation here.
    await sql`
      INSERT INTO api_keys (user_id, key_hash, name, purpose, scopes)
      VALUES
        (${user.id}, ${'h-sup-' + randomUUID()}, 'Supervisor', 'supervisor', NULL),
        (${user.id}, ${'h-ext1-' + randomUUID()}, 'Claude Desktop', 'external', ARRAY['ext:read']),
        (${user.id}, ${'h-ext2-' + randomUUID()}, 'CI bot', 'external', ARRAY['ext:read','ext:ask'])
    `
    const [{ count }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM api_keys
      WHERE user_id = ${user.id} AND purpose = 'external' AND revoked_at IS NULL
    `
    expect(Number(count)).toBe(2)

    // Boot 2 — schema.sql re-runs IN FULL. Must NOT throw.
    await applySchemaStrict(sql)

    // Boot 3, for good measure (convergence, not just one-shot tolerance).
    await applySchemaStrict(sql)

    const [{ count: still }] = await sql<{ count: string }[]>`
      SELECT count(*)::text AS still FROM api_keys WHERE user_id = ${user.id} AND revoked_at IS NULL
    `
    expect(Number(still)).toBe(3)
  })

  it('the stale (user_id, purpose) unique index is GONE and does not come back', async () => {
    await applySchemaStrict(sql)
    const rows = await sql<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = ${NS} AND tablename = 'api_keys'
    `
    const names = rows.map(r => r.indexname)
    expect(names).not.toContain('idx_api_keys_user_purpose_active')
    expect(names).not.toContain('idx_api_keys_user_active')
    expect(names).toContain('idx_api_keys_user_supervisor_active')
    expect(names).toContain('idx_api_keys_user_orchestrator_active')
  })

  it('still enforces ONE active supervisor key and ONE active orchestrator key', async () => {
    const email = `skey-uniq-${randomUUID()}@invalid.local`
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${email}, 'x', 'user') RETURNING id
    `
    await sql`
      INSERT INTO api_keys (user_id, key_hash, name, purpose)
      VALUES (${user.id}, ${'h-s1-' + randomUUID()}, 'Supervisor', 'supervisor')
    `
    let threw = false
    try {
      await sql`
        INSERT INTO api_keys (user_id, key_hash, name, purpose)
        VALUES (${user.id}, ${'h-s2-' + randomUUID()}, 'Supervisor 2', 'supervisor')
      `
    } catch { threw = true }
    expect(threw).toBe(true)

    await sql`
      INSERT INTO api_keys (user_id, key_hash, name, purpose)
      VALUES (${user.id}, ${'h-o1-' + randomUUID()}, 'Orchestrator', 'orchestrator')
    `
    let threwOrch = false
    try {
      await sql`
        INSERT INTO api_keys (user_id, key_hash, name, purpose)
        VALUES (${user.id}, ${'h-o2-' + randomUUID()}, 'Orchestrator 2', 'orchestrator')
      `
    } catch { threwOrch = true }
    expect(threwOrch).toBe(true)
  })
})

/**
 * Ghost-hostname backfill — the durable fix for online sessions stuck with
 * hostname=NULL (unroutable by pickSupervisorForSession → autospawn refuses
 * `supervisor_offline`; ghost-reaper grace keeps resetting).
 *
 * Covers the two hub-side DAL primitives the agent-auth online transition now
 * uses so a session is never observable as online+NULL-hostname:
 *   - getSupervisorHostnameForApiKey: fallback hostname from the api_key that the
 *     agent shares with its host supervisor, when the auth frame omits hostname.
 *   - backfillSessionHostname: COALESCE backfill — sets a NULL hostname, never
 *     downgrades an existing one.
 *
 * Gated on REMO_E2E_DB_URL (real Postgres). Skips cleanly otherwise.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
if (process.env.REMO_E2E_DB_URL) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}

import { describe, test, expect, beforeAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('ghost-hostname backfill', () => {
  let getSupervisorHostnameForApiKey: (h: string) => Promise<string | null>
  let backfillSessionHostname: (id: string, h: string | null) => Promise<void>
  let sql: any
  let userId: string

  beforeAll(async () => {
    ;({ getSupervisorHostnameForApiKey, backfillSessionHostname } = await import('../src/db/dal.ts'))
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
    const u = await sql`INSERT INTO users (email) VALUES (${`ghosthost-${Date.now()}@test.local`}) RETURNING id`
    userId = u[0].id
  })

  async function mkSupervisor(keyHash: string, host: string): Promise<void> {
    const apiKeyId = `apikey_${host}_${Date.now()}`
    await sql`
      INSERT INTO api_keys (id, user_id, key_hash, capabilities, name, purpose)
      VALUES (${apiKeyId}, ${userId}, ${keyHash}, ${['supervisor']}::text[], 'ghosthost', ${`p-${apiKeyId}`})
      ON CONFLICT (id) DO NOTHING
    `
    await sql`
      INSERT INTO supervisors (id, user_id, api_key_id, hostname, roots, last_seen_at)
      VALUES (${`sup_${host}_${Date.now()}`}, ${userId}, ${apiKeyId}, ${host}, ARRAY[]::text[], now())
      ON CONFLICT (id) DO NOTHING
    `
  }

  test('getSupervisorHostnameForApiKey resolves the supervisor host by key hash', async () => {
    const keyHash = `kh-${crypto.randomUUID()}`
    await mkSupervisor(keyHash, 'TitaniumTower')
    expect(await getSupervisorHostnameForApiKey(keyHash)).toBe('TitaniumTower')
    expect(await getSupervisorHostnameForApiKey(`kh-none-${crypto.randomUUID()}`)).toBeNull()
  })

  test('backfillSessionHostname sets NULL host but never downgrades an existing one', async () => {
    const mk = async (host: string | null) => {
      const r = await sql`
        INSERT INTO sessions (id, user_id, name, token_hash, status, hostname)
        VALUES (${crypto.randomUUID()}, ${userId}, 'gh', ${`h-${crypto.randomUUID()}`}, 'online', ${host})
        RETURNING id
      `
      return r[0].id
    }
    const ghost = await mk(null)
    const owned = await mk('OtherHost')

    await backfillSessionHostname(ghost, 'TitaniumTower')
    await backfillSessionHostname(owned, 'TitaniumTower') // must NOT overwrite
    await backfillSessionHostname(ghost, '')              // no-op on empty

    const g = await sql`SELECT hostname FROM sessions WHERE id = ${ghost}`
    const o = await sql`SELECT hostname FROM sessions WHERE id = ${owned}`
    expect(g[0].hostname).toBe('TitaniumTower')
    expect(o[0].hostname).toBe('OtherHost')
  })
})

describe('ghost-hostname backfill — env gate', () => {
  test('e2e gated on REMO_E2E_DB_URL', () => {
    if (!HAS_TEST_DB) console.log('[ghost-hostname-backfill] REMO_E2E_DB_URL not set — DB tests SKIPPED.')
    expect(true).toBe(true)
  })
})

/**
 * Supervisor api-key auth disambiguation.
 *
 * Verifies verifyApiKeyWithCapability returns the four distinct failure
 * shapes (not_found / revoked / missing_capability / ok). The `deleted`
 * branch is reserved for forward compatibility (no `deleted_at` column on
 * `api_keys` yet) and is exercised only at the type level.
 *
 * Gated on REMO_E2E_DB_URL — skips cleanly when unset, like the other DAL
 * suites under hub/test/.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
if (process.env.REMO_E2E_DB_URL) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createHash, randomBytes } from 'crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

const TEST_TAG = `sup-auth-${Date.now()}`

function mkHash() {
  // 64-hex sha256 of a random token — same shape as the hub computes.
  return createHash('sha256').update(randomBytes(32)).digest('hex')
}

maybe('verifyApiKeyWithCapability disambiguates failure reasons', () => {
  let sql: any
  let dal: typeof import('../src/db/supervisor-dal.ts')
  let userId: string

  beforeAll(async () => {
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    dal = await import('../src/db/supervisor-dal.ts')
    const { runMigrations } = await import('../src/db/migrate.ts')
    await runMigrations()
    const rows = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${TEST_TAG + '@example.test'}, 'bcrypt-placeholder')
      RETURNING id
    `
    userId = rows[0].id as string
  })

  afterAll(async () => {
    await sql`DELETE FROM api_keys WHERE user_id = ${userId}`
    await sql`DELETE FROM users WHERE id = ${userId}`
  })

  test('not_found when no row matches keyhash', async () => {
    const result = await dal.verifyApiKeyWithCapability(mkHash(), 'supervisor')
    expect(result).toEqual({ ok: false, reason: 'not_found' })
  })

  test('ok when key exists, not revoked, has capability', async () => {
    const keyHash = mkHash()
    await sql`
      INSERT INTO api_keys (user_id, name, key_hash, capabilities, purpose)
      VALUES (${userId}, 'happy', ${keyHash}, ARRAY['agent','supervisor'], 'disamb-happy')
    `
    const result = await dal.verifyApiKeyWithCapability(keyHash, 'supervisor')
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.userId).toBe(userId)
      expect(typeof result.apiKeyId).toBe('string')
    }
  })

  test('revoked when revoked_at IS NOT NULL', async () => {
    const keyHash = mkHash()
    await sql`
      INSERT INTO api_keys (user_id, name, key_hash, capabilities, revoked_at)
      VALUES (${userId}, 'revoked', ${keyHash}, ARRAY['agent','supervisor'], now())
    `
    const result = await dal.verifyApiKeyWithCapability(keyHash, 'supervisor')
    expect(result).toEqual({ ok: false, reason: 'revoked' })
  })

  test('missing_capability when caps non-empty and need not present', async () => {
    const keyHash = mkHash()
    await sql`
      INSERT INTO api_keys (user_id, name, key_hash, capabilities, purpose)
      VALUES (${userId}, 'no-cap', ${keyHash}, ARRAY['agent'], 'disamb-no-cap')
    `
    const result = await dal.verifyApiKeyWithCapability(keyHash, 'supervisor')
    expect(result.ok).toBe(false)
    if (!result.ok && result.reason === 'missing_capability') {
      expect(result.need).toBe('supervisor')
      expect(result.have).toEqual(['agent'])
    } else {
      throw new Error(`expected missing_capability, got ${JSON.stringify(result)}`)
    }
  })

  test('empty caps treated as legacy all-caps (ok)', async () => {
    const keyHash = mkHash()
    await sql`
      INSERT INTO api_keys (user_id, name, key_hash, capabilities, purpose)
      VALUES (${userId}, 'legacy', ${keyHash}, ARRAY[]::TEXT[], 'disamb-legacy')
    `
    const result = await dal.verifyApiKeyWithCapability(keyHash, 'supervisor')
    expect(result.ok).toBe(true)
  })
})

// Always-on smoke test so the file passes even without REMO_E2E_DB_URL.
describe('supervisor-auth disambiguation harness', () => {
  test('reason union shape is exhaustive at type level', async () => {
    // Compile-time only: the type assertion below fails to typecheck if a new
    // reason is added to VerifyApiKeyResult without updating this switch.
    type R = import('../src/db/supervisor-dal.ts').VerifyApiKeyResult
    const _check = (r: R): string => {
      if (r.ok) return 'ok'
      switch (r.reason) {
        case 'not_found': return 'nf'
        case 'revoked': return 'rv'
        case 'deleted': return 'del'
        case 'missing_capability': return 'mc'
      }
    }
    void _check
    expect(true).toBe(true)
  })
})

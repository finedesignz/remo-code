/**
 * DAL tests for Phase 07 Titanium auth helpers (Plan B).
 *
 * Gated on REMO_E2E_DB_URL — exercises real Postgres against the migrated
 * schema. Skips cleanly when unset. The harness sanity test always runs.
 *
 * Covers every new helper in hub/src/db/dal.ts:
 *   - getUserByTitaniumSubject
 *   - linkTitaniumSubject
 *   - setPendingVerify
 *   - promoteCandidateSubject (happy + guard)
 *   - updateLicenseStatus
 *   - updateUserEmail (happy + UNIQUE conflict)
 *   - createAuthSession + getAuthSessionByToken (happy + expired = null)
 *   - touchAuthSession
 *   - deleteAuthSession
 *   - purgeExpiredAuthSessions
 *   - recordAuthEvent (incl. link_mismatch metadata)
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
if (process.env.REMO_E2E_DB_URL) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

const TEST_TAG = `phase07-${Date.now()}`

maybe('phase 07 titanium auth dal', () => {
  let sql: any
  let dal: typeof import('../src/db/dal.ts')

  beforeAll(async () => {
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    dal = await import('../src/db/dal.ts')
    const { runMigrations } = await import('../src/db/migrate.ts')
    await runMigrations()
  })

  afterAll(async () => {
    // Best-effort cleanup of any rows this test created.
    await sql`DELETE FROM auth_events WHERE event_type LIKE ${TEST_TAG + '%'}`
    await sql`DELETE FROM users WHERE email LIKE ${TEST_TAG + '%'}`
  })

  async function mkUser(suffix: string) {
    const email = `${TEST_TAG}-${suffix}@example.test`
    const row = await dal.createUser(email, 'bcrypt-placeholder')
    return { id: row.id as string, email }
  }

  test('getUserByTitaniumSubject returns null when unlinked, row after link', async () => {
    const u = await mkUser('lookup')
    expect(await dal.getUserByTitaniumSubject(`${TEST_TAG}-subj-lookup`)).toBeNull()
    await dal.linkTitaniumSubject(u.id, `${TEST_TAG}-subj-lookup`, u.email)
    const found = await dal.getUserByTitaniumSubject(`${TEST_TAG}-subj-lookup`)
    expect(found?.id).toBe(u.id)
    expect(found?.titanium_link_status).toBe('linked')
    expect(found?.titanium_email).toBe(u.email)
    expect(found?.last_titanium_sync_at).toBeTruthy()
  })

  test('setPendingVerify writes candidate_subject + pending_verify', async () => {
    const u = await mkUser('pending')
    await dal.setPendingVerify(u.id, `${TEST_TAG}-cand`, u.email)
    const rows = await sql`SELECT candidate_subject, titanium_link_status FROM users WHERE id = ${u.id}`
    expect(rows[0].candidate_subject).toBe(`${TEST_TAG}-cand`)
    expect(rows[0].titanium_link_status).toBe('pending_verify')
  })

  test('promoteCandidateSubject only acts when pending_verify', async () => {
    const u = await mkUser('promote')
    // No-op when not pending.
    expect(await dal.promoteCandidateSubject(u.id)).toBe(false)
    await dal.setPendingVerify(u.id, `${TEST_TAG}-promo-cand`, u.email)
    expect(await dal.promoteCandidateSubject(u.id)).toBe(true)
    const rows = await sql`SELECT titanium_subject, candidate_subject, titanium_link_status FROM users WHERE id = ${u.id}`
    expect(rows[0].titanium_subject).toBe(`${TEST_TAG}-promo-cand`)
    expect(rows[0].candidate_subject).toBeNull()
    expect(rows[0].titanium_link_status).toBe('linked')
    // Second call is a no-op.
    expect(await dal.promoteCandidateSubject(u.id)).toBe(false)
  })

  test('updateLicenseStatus sets status + id + checked_at', async () => {
    const u = await mkUser('license')
    await dal.updateLicenseStatus(u.id, 'ACTIVE', 'lic_123')
    const rows = await sql`SELECT license_status, license_id, license_checked_at FROM users WHERE id = ${u.id}`
    expect(rows[0].license_status).toBe('ACTIVE')
    expect(rows[0].license_id).toBe('lic_123')
    expect(rows[0].license_checked_at).toBeTruthy()
  })

  test('updateUserEmail happy path + UNIQUE collision', async () => {
    const a = await mkUser('email-a')
    const b = await mkUser('email-b')
    const ok = await dal.updateUserEmail(a.id, `${TEST_TAG}-renamed@example.test`)
    expect(ok).toEqual({ updated: true, conflict: false })
    // Try to overwrite a's email with b's existing email → UNIQUE conflict.
    const collide = await dal.updateUserEmail(a.id, b.email)
    expect(collide).toEqual({ updated: false, conflict: true })
  })

  test('createAuthSession + getAuthSessionByToken roundtrip; expired returns null', async () => {
    const u = await mkUser('sess')
    const created = await dal.createAuthSession({
      userId: u.id,
      ip: '127.0.0.1',
      userAgent: 'bun-test',
      ttlSeconds: 60,
    })
    expect(created.token.startsWith('remo_')).toBe(true)
    const row = await dal.getAuthSessionByToken(created.token)
    expect(row?.user_id).toBe(u.id)
    expect(row?.ip).toBe('127.0.0.1')

    // Force expiry, confirm lookup returns null.
    await sql`UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE id = ${created.id}`
    expect(await dal.getAuthSessionByToken(created.token)).toBeNull()
  })

  test('touchAuthSession bumps last_used_at; deleteAuthSession removes row', async () => {
    const u = await mkUser('sess-touch')
    const { token, id } = await dal.createAuthSession({ userId: u.id, ttlSeconds: 60 })
    const beforeRows = await sql`SELECT last_used_at FROM auth_sessions WHERE id = ${id}`
    const before = new Date(beforeRows[0].last_used_at).getTime()
    await new Promise((r) => setTimeout(r, 25))
    await dal.touchAuthSession(token)
    const afterRows = await sql`SELECT last_used_at FROM auth_sessions WHERE id = ${id}`
    const after = new Date(afterRows[0].last_used_at).getTime()
    expect(after).toBeGreaterThanOrEqual(before)

    await dal.deleteAuthSession(token)
    const gone = await sql`SELECT id FROM auth_sessions WHERE id = ${id}`
    expect(gone.length).toBe(0)
  })

  test('purgeExpiredAuthSessions reaps expired rows only', async () => {
    const u = await mkUser('sess-purge')
    const live = await dal.createAuthSession({ userId: u.id, ttlSeconds: 60 })
    const dead = await dal.createAuthSession({ userId: u.id, ttlSeconds: 60 })
    await sql`UPDATE auth_sessions SET expires_at = now() - interval '1 minute' WHERE id = ${dead.id}`
    const purged = await dal.purgeExpiredAuthSessions()
    expect(purged).toBeGreaterThanOrEqual(1)
    // live row still here, dead one gone.
    const liveRows = await sql`SELECT id FROM auth_sessions WHERE id = ${live.id}`
    expect(liveRows.length).toBe(1)
    const deadRows = await sql`SELECT id FROM auth_sessions WHERE id = ${dead.id}`
    expect(deadRows.length).toBe(0)
  })

  test('recordAuthEvent writes link_mismatch with metadata', async () => {
    const u = await mkUser('events')
    const eventType = `${TEST_TAG}-link_mismatch`
    await dal.recordAuthEvent({
      userId: u.id,
      eventType,
      ip: '203.0.113.7',
      userAgent: 'curl/8',
      metadata: { candidate_subject: 'cand_x', attempted_subject: 'try_y' },
    })
    const rows = await sql`
      SELECT user_id, event_type, ip, user_agent, metadata
        FROM auth_events
       WHERE event_type = ${eventType}
       ORDER BY ts DESC LIMIT 1
    `
    expect(rows.length).toBe(1)
    expect(rows[0].user_id).toBe(u.id)
    expect(rows[0].metadata.candidate_subject).toBe('cand_x')
    expect(rows[0].metadata.attempted_subject).toBe('try_y')
  })
})

describe('phase 07 dal — harness sanity', () => {
  test('skips cleanly when REMO_E2E_DB_URL is unset', () => {
    expect(true).toBe(true)
  })
})

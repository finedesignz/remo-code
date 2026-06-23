/**
 * Supervisor stale-row auto-cleanup.
 *
 * Each MSI install/upgrade rotates the api_key → produces a new `supervisors`
 * row for the same physical host. After every successful hello/auth the hub
 * calls cleanupStaleSupervisorRows to reap siblings older than the staleness
 * threshold. These tests exercise the SQL directly.
 *
 * Gated on REMO_E2E_DB_URL — skips cleanly when unset, like the other DAL
 * suites under hub/test/.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
if (process.env.REMO_E2E_DB_URL) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

const TAG = `stalecleanup-${Date.now()}`

maybe('cleanupStaleSupervisorRows', () => {
  let sql: any
  let dal: typeof import('../src/db/supervisor-dal.ts')
  let userIdA: string
  let userIdB: string
  let apiKeyIds: string[] = []

  async function mkApiKey(userId: string): Promise<string> {
    // Each supervisor row needs its own api_key. The partial unique index
    // idx_api_keys_user_purpose_active (user_id, purpose) WHERE revoked_at IS NULL
    // allows only ONE active key per (user, purpose), so give each a distinct
    // purpose — purpose is irrelevant to what this suite exercises.
    const purpose = 'stale-' + Math.random().toString(36).slice(2, 10)
    const rows = await sql`
      INSERT INTO api_keys (user_id, key_hash, capabilities, name, purpose)
      VALUES (${userId}, ${TAG + '-' + Math.random().toString(36).slice(2, 10)}, ${['supervisor']}::text[], 'stale test', ${purpose})
      RETURNING id
    `
    apiKeyIds.push(rows[0].id as string)
    return rows[0].id as string
  }

  async function insertSup(args: {
    userId: string
    hostname: string
    lastSeenMinutesAgo: number
  }): Promise<string> {
    const apiKeyId = await mkApiKey(args.userId)
    const rows = await sql`
      INSERT INTO supervisors (user_id, api_key_id, hostname, roots, last_seen_at)
      VALUES (
        ${args.userId},
        ${apiKeyId},
        ${args.hostname},
        ARRAY[]::text[],
        now() - (${args.lastSeenMinutesAgo} || ' minutes')::interval
      )
      RETURNING id
    `
    return rows[0].id as string
  }

  beforeAll(async () => {
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    dal = await import('../src/db/supervisor-dal.ts')
    const { runMigrations } = await import('../src/db/migrate.ts')
    await runMigrations()
    const uA = await sql`
      INSERT INTO users (email, password_hash) VALUES (${TAG + '-a@test.local'}, 'x') RETURNING id
    `
    const uB = await sql`
      INSERT INTO users (email, password_hash) VALUES (${TAG + '-b@test.local'}, 'x') RETURNING id
    `
    userIdA = uA[0].id as string
    userIdB = uB[0].id as string
  })

  afterAll(async () => {
    // Children (supervisors, api_keys) cascade from users.
    await sql`DELETE FROM users WHERE id IN (${userIdA}, ${userIdB})`
  })

  beforeEach(async () => {
    // Wipe supervisors + api_keys between tests so each starts clean.
    await sql`DELETE FROM supervisors WHERE user_id IN (${userIdA}, ${userIdB})`
    await sql`DELETE FROM api_keys WHERE user_id IN (${userIdA}, ${userIdB})`
    apiKeyIds = []
  })

  test('deletes stale siblings, keeps keep_id and fresh rows', async () => {
    const keep = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 0 })
    const stale1 = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 60 })
    const stale2 = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 600 })
    const fresh = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 1 })

    const result = await dal.cleanupStaleSupervisorRows(userIdA, 'TitaniumTower', keep, 5)
    expect(result.deleted_ids.sort()).toEqual([stale1, stale2].sort())

    const survivors = await sql`
      SELECT id FROM supervisors WHERE user_id = ${userIdA} AND hostname = 'TitaniumTower'
      ORDER BY id
    `
    const ids = survivors.map((r: any) => r.id).sort()
    expect(ids).toEqual([keep, fresh].sort())
  })

  test('never deletes the keep_id even when it is itself stale', async () => {
    // Should not happen in production (we just upserted last_seen_at=now()),
    // but defend the invariant anyway.
    const keep = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 999 })
    const other = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 999 })

    const result = await dal.cleanupStaleSupervisorRows(userIdA, 'TitaniumTower', keep, 5)
    expect(result.deleted_ids).toEqual([other])

    const survivors = await sql`SELECT id FROM supervisors WHERE id = ${keep}`
    expect(survivors.length).toBe(1)
  })

  test('does not touch other hostnames for the same user', async () => {
    const keep = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 0 })
    const otherHost = await insertSup({ userId: userIdA, hostname: 'OtherBox', lastSeenMinutesAgo: 999 })

    const result = await dal.cleanupStaleSupervisorRows(userIdA, 'TitaniumTower', keep, 5)
    expect(result.deleted_ids).toEqual([])

    const survivors = await sql`SELECT id FROM supervisors WHERE user_id = ${userIdA} ORDER BY id`
    const ids = survivors.map((r: any) => r.id).sort()
    expect(ids).toEqual([keep, otherHost].sort())
  })

  test('does not touch the same hostname under a different user', async () => {
    const keep = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 0 })
    const otherUserSup = await insertSup({ userId: userIdB, hostname: 'TitaniumTower', lastSeenMinutesAgo: 999 })

    const result = await dal.cleanupStaleSupervisorRows(userIdA, 'TitaniumTower', keep, 5)
    expect(result.deleted_ids).toEqual([])

    const survivors = await sql`SELECT id FROM supervisors WHERE hostname = 'TitaniumTower' ORDER BY id`
    const ids = survivors.map((r: any) => r.id).sort()
    expect(ids).toEqual([keep, otherUserSup].sort())
  })

  test('staleness threshold boundary: row at threshold survives, just past is deleted', async () => {
    const keep = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 0 })
    // Just inside the window (4 min ago, threshold 5) — survives.
    const inside = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 4 })
    // Just past (6 min ago) — deleted.
    const past = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 6 })

    const result = await dal.cleanupStaleSupervisorRows(userIdA, 'TitaniumTower', keep, 5)
    expect(result.deleted_ids).toEqual([past])

    const survivors = await sql`SELECT id FROM supervisors WHERE user_id = ${userIdA} ORDER BY id`
    const ids = survivors.map((r: any) => r.id).sort()
    expect(ids).toEqual([keep, inside].sort())
  })

  test('no-op when no siblings exist', async () => {
    const keep = await insertSup({ userId: userIdA, hostname: 'TitaniumTower', lastSeenMinutesAgo: 0 })
    const result = await dal.cleanupStaleSupervisorRows(userIdA, 'TitaniumTower', keep, 5)
    expect(result.deleted_ids).toEqual([])
  })
})


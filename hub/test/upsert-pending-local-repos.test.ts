/**
 * Regression: `upsertPendingLocalRepoBatch` was hitting
 *   ERROR: cannot cast type boolean to boolean[]
 * in prod because postgres.js inferred the JS-boolean array param with an
 * element OID PG refuses to cast back to boolean[]. Fix: round-trip through
 * text[] ('t'/'f') and cast scalar-side via `::boolean`.
 *
 * Skips cleanly when REMO_E2E_DB_URL is unset (CI without disposable PG).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('upsertPendingLocalRepoBatch — mixed-boolean batch', () => {
  let dal: typeof import('../src/db/dal')
  let sql: ReturnType<typeof postgres>
  let userId: string
  const hostname = `host-${randomUUID().slice(0, 8)}`

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    dal = await import('../src/db/dal')
    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 2, idle_timeout: 5 })
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${`e2e-bool-${randomUUID()}@invalid.local`}, 'x', 'user')
      RETURNING id
    `
    userId = rows[0].id
  })

  afterAll(async () => {
    await sql`DELETE FROM pending_local_repos WHERE user_id = ${userId}`
    await sql`DELETE FROM users WHERE id = ${userId}`
    await sql.end({ timeout: 5 })
  })

  test('persists both rows of a mixed true/false batch', async () => {
    const count = await dal.upsertPendingLocalRepoBatch([
      { user_id: userId, hostname, project_dir: '/tmp/git-repo', is_git_repo: true },
      { user_id: userId, hostname, project_dir: '/tmp/plain-folder', is_git_repo: false },
    ])
    expect(count).toBe(2)

    const rows = await sql<{ project_dir: string; is_git_repo: boolean }[]>`
      SELECT project_dir, is_git_repo
      FROM pending_local_repos
      WHERE user_id = ${userId} AND hostname = ${hostname}
      ORDER BY project_dir
    `
    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({ project_dir: '/tmp/git-repo', is_git_repo: true })
    expect(rows[1]).toEqual({ project_dir: '/tmp/plain-folder', is_git_repo: false })
  })
})

/**
 * Phase 08 plan 004 — DAL e2e for pending-prompts + dismiss-local.
 *
 * Gated on `REMO_E2E_DB_URL` (same convention as `session-keying-dal.test.ts`).
 * Tests the two DAL helpers that back `GET /api/sessions/pending-prompts` and
 * `POST /api/sessions/dismiss-local`.
 *
 * Cases (plan 004 T3):
 *   1. Seed two rows in `pending_local_repos` for userA, one for userB.
 *      `getPendingPrompts(userA)` returns 2 entries, none from userB.
 *   2. `dismissLocalSession(userA, hostname, project_dir)` removes the row
 *      from `pending_local_repos`, inserts into `dismissed_local_sessions`,
 *      and the next `getPendingPrompts(userA)` returns only the other row.
 *   3. Re-calling `dismissLocalSession` with the same args is idempotent —
 *      no duplicate row in `dismissed_local_sessions`, no throw.
 *   4. `listSessions` includes `repo_key`, `github_owner`, `github_repo`.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

describe('sessions-pending — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — sessions-pending e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

maybe('pending-prompts + dismiss-local — DAL e2e', () => {
  let dal: typeof import('../src/db/dal')
  let sql: ReturnType<typeof postgres>
  let userA: string
  let userB: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    dal = await import('../src/db/dal')
    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 4, idle_timeout: 5 })

    const a = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${`e2e-p08-004-a-${randomUUID()}@invalid.local`}, 'x', 'user')
      RETURNING id
    `
    const b = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${`e2e-p08-004-b-${randomUUID()}@invalid.local`}, 'x', 'user')
      RETURNING id
    `
    userA = a[0].id
    userB = b[0].id
  })

  afterAll(async () => {
    if (userA) await sql`DELETE FROM users WHERE id = ${userA}`
    if (userB) await sql`DELETE FROM users WHERE id = ${userB}`
    try { await sql.end({ timeout: 5 }) } catch {}
  })

  test('1. getPendingPrompts returns only the caller user\'s rows', async () => {
    await sql`
      INSERT INTO pending_local_repos (user_id, hostname, project_dir, is_git_repo)
      VALUES
        (${userA}, 'host-a', '/tmp/repo-a1', true),
        (${userA}, 'host-a', '/tmp/repo-a2', false),
        (${userB}, 'host-b', '/tmp/repo-b1', true)
    `
    const pendingA = await dal.getPendingPrompts(userA)
    expect(pendingA.length).toBe(2)
    expect(pendingA.every((p) => p.project_dir.startsWith('/tmp/repo-a'))).toBe(true)

    const pendingB = await dal.getPendingPrompts(userB)
    expect(pendingB.length).toBe(1)
    expect(pendingB[0].project_dir).toBe('/tmp/repo-b1')
  })

  test('2. dismissLocalSession moves the row from pending → dismissed', async () => {
    await dal.dismissLocalSession(userA, 'host-a', '/tmp/repo-a1')

    const pendingA = await dal.getPendingPrompts(userA)
    expect(pendingA.length).toBe(1)
    expect(pendingA[0].project_dir).toBe('/tmp/repo-a2')

    // Verify the pending row was deleted.
    const pendingRows = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM pending_local_repos
      WHERE user_id = ${userA} AND hostname = 'host-a' AND project_dir = '/tmp/repo-a1'
    `
    expect(pendingRows[0].c).toBe(0)

    // Verify the dismissed row was inserted.
    const dismissedRows = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM dismissed_local_sessions
      WHERE user_id = ${userA} AND hostname = 'host-a' AND project_dir = '/tmp/repo-a1'
    `
    expect(dismissedRows[0].c).toBe(1)
  })

  test('3. dismissLocalSession is idempotent on repeat call', async () => {
    // Already dismissed in test 2 — repeating must not throw, must not dup.
    await dal.dismissLocalSession(userA, 'host-a', '/tmp/repo-a1')
    await dal.dismissLocalSession(userA, 'host-a', '/tmp/repo-a1')

    const dismissedRows = await sql<{ c: number }[]>`
      SELECT COUNT(*)::int AS c FROM dismissed_local_sessions
      WHERE user_id = ${userA} AND hostname = 'host-a' AND project_dir = '/tmp/repo-a1'
    `
    expect(dismissedRows[0].c).toBe(1)
  })

  test('4. listSessions includes repo_key, github_owner, github_repo', async () => {
    await sql`
      INSERT INTO sessions (user_id, name, project_dir, token_hash, repo_key, github_owner, github_repo)
      VALUES (${userA}, 'finedesignz/remo-code', '/tmp/work', ${'x'.repeat(40)},
              'github://finedesignz/remo-code', 'finedesignz', 'remo-code')
    `
    const rows = await dal.listSessions(userA)
    const githubKeyed = (rows as any[]).find((r) => r.repo_key === 'github://finedesignz/remo-code')
    expect(githubKeyed).toBeDefined()
    expect(githubKeyed.github_owner).toBe('finedesignz')
    expect(githubKeyed.github_repo).toBe('remo-code')
  })

  test('5. dismissed row is hidden from getPendingPrompts even if re-inserted', async () => {
    // Simulating: agent re-announces a folder the user previously dismissed.
    // The LEFT JOIN on dismissed_local_sessions must hide it.
    await sql`
      INSERT INTO pending_local_repos (user_id, hostname, project_dir, is_git_repo)
      VALUES (${userA}, 'host-a', '/tmp/repo-a1', true)
      ON CONFLICT (user_id, hostname, project_dir) DO UPDATE SET last_seen_at = now()
    `
    const pendingA = await dal.getPendingPrompts(userA)
    const reappeared = pendingA.find((p) => p.project_dir === '/tmp/repo-a1')
    expect(reappeared).toBeUndefined()
  })
})

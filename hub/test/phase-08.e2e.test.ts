/**
 * Phase 08 — headline e2e: GitHub-keyed sessions collapse all worktrees of
 * one repo into ONE session row per user.
 *
 * Gated on `REMO_E2E_DB_URL` (same convention as the other e2e tests in this
 * directory). Skips cleanly without a disposable Postgres so CI stays green.
 *
 * This test is intentionally narrow — it asserts the value prop the user
 * sees in the sidebar (one row, not N). Concurrent-race coverage,
 * legacy-row upgrade, sibling supersede, and the no-git fallback are
 * exhaustively covered by `hub/test/session-keying-dal.test.ts`. The DAL
 * is the same code path the supervisor `repo_inventory` handler invokes
 * for every inventory entry, so exercising it twice with the same
 * `git_origin_github` is a faithful simulation of two supervisor
 * connections from different worktrees.
 *
 * Setup: insert a synthetic user, run `findOrCreateAgentSessionV2` once
 * for `/tmp/repo` and once for `/tmp/repo-w1`, both reporting the same
 * GitHub origin (`test/demo`).
 *
 * Assertion: exactly one row in `sessions` for that user where
 * `repo_key = 'github://test/demo'`, and both calls returned the same
 * session id.
 *
 * Teardown: cascade-delete the user (sessions FK with ON DELETE CASCADE
 * cleans up everything we created).
 *
 * Run with:
 *   REMO_E2E_DB_URL=postgres://... bun test hub/test/phase-08.e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('phase-08 e2e — worktrees of one GitHub repo collapse to one session', () => {
  // `sql` (hub/src/db/postgres.ts) is bound to `config.databaseUrl` at import
  // time, so DATABASE_URL must point at REMO_E2E_DB_URL BEFORE the DAL is
  // imported. Lazy-import inside beforeAll so the describe.skip branch never
  // triggers the import in CI without a test DB.
  let dal: typeof import('../src/db/dal')
  let sql: ReturnType<typeof postgres>
  let userId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    dal = await import('../src/db/dal')
    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 4, idle_timeout: 5 })
    const email = `e2e-phase08-headline-${randomUUID()}@invalid.local`
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, 'x', 'user')
      RETURNING id
    `
    userId = rows[0].id
  })

  afterAll(async () => {
    await sql`DELETE FROM users WHERE id = ${userId}`
    await sql.end({ timeout: 5 })
  })

  test('two worktree connects produce ONE session row with repo_key=github://test/demo', async () => {
    const git = {
      is_git_repo: true,
      is_worktree: true,
      worktree_parent_path: '/tmp/repo',
      git_remote: 'git@github.com:test/demo.git',
      git_origin_github: { owner: 'test', repo: 'demo' },
    }

    // Connection #1: the canonical clone at /tmp/repo.
    const r1 = await dal.findOrCreateAgentSessionV2(
      userId,
      '/tmp/repo',
      'tokenhash-1',
      'claude',
      git,
      'host-e2e',
    )

    // Connection #2: a sibling worktree at /tmp/repo-w1 — same origin.
    const r2 = await dal.findOrCreateAgentSessionV2(
      userId,
      '/tmp/repo-w1',
      'tokenhash-2',
      'claude',
      git,
      'host-e2e',
    )

    // Both calls return the SAME session id — the worktree connect hits the
    // P1 (repo-keyed match) path and reuses the row created by call #1.
    expect(r1.id).toBeTruthy()
    expect(r2.id).toBe(r1.id)
    expect(r1.repo_keyed).toBe(true)
    expect(r2.repo_keyed).toBe(true)

    // The sidebar sees exactly one row for this user + repo.
    const rows = await sql<{ id: string; project_dir: string; github_owner: string; github_repo: string }[]>`
      SELECT id, project_dir, github_owner, github_repo
      FROM sessions
      WHERE user_id = ${userId}
        AND repo_key = 'github://test/demo'
        AND deleted_at IS NULL
    `
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe(r1.id)
    expect(rows[0].github_owner).toBe('test')
    expect(rows[0].github_repo).toBe('demo')

    // Bookkeeping: the worktree-overwrite guard (dal.ts P1, 2026-05-28) keeps
    // the canonical clone path and never downgrades it to a worktree path. The
    // sibling connect (/tmp/repo-w1, is_worktree, parent=/tmp/repo) therefore
    // resolves project_dir to the parent clone, not the worktree checkout.
    expect(rows[0].project_dir).toBe('/tmp/repo')
  })
})

// Always-on sanity test so this file always reports something to bun test,
// matching the convention in scheduled-tasks.e2e.test.ts.
describe('phase-08 e2e — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — phase-08 e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run it.',
      )
    }
  })
})

/**
 * Phase 08 plan 002 — DAL e2e for `findOrCreateAgentSessionV2`.
 *
 * Gated on `REMO_E2E_DB_URL` so CI without a disposable Postgres skips
 * cleanly (same convention as `hub/test/scheduled-tasks.e2e.test.ts`).
 *
 * The test opens its own `postgres` client against REMO_E2E_DB_URL rather
 * than reusing the hub's shared `sql` (which is bound at import time to
 * `config.databaseUrl`). Each test seeds a fresh user UUID + cleans up its
 * own rows so the suite is idempotent.
 *
 * Cases covered (ARCHITECTURE §11 + plan 002 acceptance criteria):
 *   1. Concurrent worktree connects collapse to one repo-keyed row.
 *   2. Legacy project_dir row is upgraded in-place when matching git arrives.
 *   3. Sibling legacy rows: keeper survives, others get superseded_by + deleted_at.
 *   4. No git → legacy path runs + `pending_local_repos` gets a row.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('findOrCreateAgentSessionV2 — DAL e2e', () => {
  // The function-under-test reads `sql` from `hub/src/db/postgres.ts`, which
  // is bound to `config.databaseUrl` at import time. To exercise the real
  // code against the test DB, point DATABASE_URL at REMO_E2E_DB_URL BEFORE
  // importing the DAL. Both must be loaded lazily inside beforeAll so that
  // the `describe.skip` branch (no test DB) never triggers the import.
  let dal: typeof import('../src/db/dal')
  let sql: ReturnType<typeof postgres>

  // Per-test user — never collides with prod data.
  let userId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    dal = await import('../src/db/dal')
    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 4, idle_timeout: 5 })
    // Seed a synthetic user with a unique email so FK references succeed.
    const email = `e2e-p08-${randomUUID()}@invalid.local`
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, 'x', 'user')
      RETURNING id
    `
    userId = rows[0].id
  })

  afterAll(async () => {
    // Cascade FKs handle dependents.
    await sql`DELETE FROM users WHERE id = ${userId}`
    await sql.end({ timeout: 5 })
  })

  test('1. concurrent worktree connects converge on ONE repo-keyed row', async () => {
    const git = {
      is_git_repo: true,
      is_worktree: true,
      worktree_parent_path: '/a/remo-code',
      git_remote: 'git@github.com:acme/widget.git',
      git_origin_github: { owner: 'acme', repo: 'widget' },
    }
    const [r1, r2] = await Promise.all([
      dal.findOrCreateAgentSessionV2(userId, '/a/remo-code', 'th1', 'claude', git, 'host-a'),
      dal.findOrCreateAgentSessionV2(userId, '/a/remo-code-w2', 'th2', 'claude', git, 'host-a'),
    ])
    expect(r1.id).toBe(r2.id)
    expect(r1.repo_keyed).toBe(true)
    expect(r2.repo_keyed).toBe(true)

    const rows = await sql`
      SELECT id FROM sessions
      WHERE user_id = ${userId}
        AND repo_key = 'github://acme/widget'
        AND deleted_at IS NULL
    `
    expect(rows.length).toBe(1)
  })

  test('2. legacy row upgraded in-place when matching git arrives', async () => {
    // Pre-insert a legacy session with no repo_key.
    const legacy = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind)
      VALUES (${userId}, 'legacy', '/b/repo', 'th-legacy', 'claude')
      RETURNING id
    `
    const legacyId = legacy[0].id

    const git = {
      is_git_repo: true,
      is_worktree: false,
      worktree_parent_path: null,
      git_remote: 'git@github.com:acme/legacy.git',
      git_origin_github: { owner: 'acme', repo: 'legacy' },
    }
    const result = await dal.findOrCreateAgentSessionV2(userId, '/b/repo', 'th-new', 'claude', git, 'host-b')
    expect(result.id).toBe(legacyId)
    expect(result.repo_keyed).toBe(true)
    expect((result as any).migrated).toBe(true)

    const rows = await sql<{ repo_key: string; github_owner: string }[]>`
      SELECT repo_key, github_owner FROM sessions WHERE id = ${legacyId}
    `
    expect(rows[0].repo_key).toBe('github://acme/legacy')
    expect(rows[0].github_owner).toBe('acme')
  })

  test('3. sibling legacy worktree rows collapse to one keeper', async () => {
    // Two legacy rows for two sibling worktrees of /c/repo.
    const w1 = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind, last_activity)
      VALUES (${userId}, 'w1', '/c/repo-w1', 'th-w1', 'claude', now() - interval '1 hour')
      RETURNING id
    `
    const w2 = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind, last_activity)
      VALUES (${userId}, 'w2', '/c/repo-w2', 'th-w2', 'claude', now())
      RETURNING id
    `

    // The DAL's P2 select matches `project_dir = ANY([projectDir, worktree_parent_path])`.
    // To make BOTH rows reachable in one call, the connecting agent must
    // present a `project_dir` matching one and a `worktree_parent_path`
    // matching the other (since `/c/repo` itself doesn't have a row).
    const git = {
      is_git_repo: true,
      is_worktree: true,
      worktree_parent_path: '/c/repo-w2', // makes w2 reachable
      git_remote: 'git@github.com:acme/siblings.git',
      git_origin_github: { owner: 'acme', repo: 'siblings' },
    }
    const result = await dal.findOrCreateAgentSessionV2(userId, '/c/repo-w1', 'th-new', 'claude', git, 'host-c')
    expect(result.repo_keyed).toBe(true)
    expect((result as any).migrated).toBe(true)

    // Keeper = most-recently-active (w2). Other = w1 → superseded_by keeper.
    const keeperRows = await sql<{ id: string; repo_key: string }[]>`
      SELECT id, repo_key FROM sessions
      WHERE user_id = ${userId}
        AND repo_key = 'github://acme/siblings'
        AND deleted_at IS NULL
    `
    expect(keeperRows.length).toBe(1)
    expect(keeperRows[0].id).toBe(w2[0].id)

    const supersededRows = await sql<{ id: string; superseded_by: string; deleted_at: Date }[]>`
      SELECT id, superseded_by, deleted_at FROM sessions
      WHERE id = ${w1[0].id}
    `
    expect(supersededRows[0].superseded_by).toBe(w2[0].id)
    expect(supersededRows[0].deleted_at).not.toBeNull()
  })

  test('4. no-git auth → legacy path + pending_local_repos populated', async () => {
    const result = await dal.findOrCreateAgentSessionV2(
      userId,
      '/d/random-folder',
      'th-d',
      'claude',
      undefined,
      'host-d',
    )
    expect(result.repo_keyed).toBe(false)
    // legacy path returns the row from findOrCreateAgentSession — no repo_key.
    const rows = await sql<{ repo_key: string | null }[]>`
      SELECT repo_key FROM sessions WHERE id = ${result.id}
    `
    expect(rows[0].repo_key).toBeNull()

    const pending = await sql`
      SELECT * FROM pending_local_repos
      WHERE user_id = ${userId}
        AND hostname = 'host-d'
        AND project_dir = '/d/random-folder'
    `
    expect(pending.length).toBe(1)
  })
})

// Always-on sanity test so the file reports something to bun test.
describe('findOrCreateAgentSessionV2 — harness sanity', () => {
  test('REMO_E2E_DB_URL is consulted (skips when absent)', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
  })
})

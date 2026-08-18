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
    // Bootstrap connection (default search_path) just to create the namespace.
    const boot = postgres(process.env.REMO_E2E_DB_URL!, { max: 1, idle_timeout: 5, connect_timeout: 10 })
    try { await boot.unsafe(`CREATE SCHEMA IF NOT EXISTS ${NS}`) } finally { await boot.end({ timeout: 5 }) }

    // Pin search_path as a CONNECTION PARAMETER, not a session `SET`: postgres.js
    // pools connections, so a bare `SET search_path` would bind to ONE connection
    // and later statements could land in `public`. `connection.search_path` is sent on
    // EVERY connection in the pool.
    //
    // The path is the private namespace ONLY — `public` is deliberately NOT on it:
    // schema.sql is all `CREATE TABLE IF NOT EXISTS`, and IF-NOT-EXISTS resolves
    // against the whole search_path, so with `public` on the path this test would see
    // the OEE suite's public.* tables, skip creation, and then operate ON THEM —
    // polluting the shared e2e database. gen_random_uuid() lives in pg_catalog
    // (implicitly on the path in pg13+), so nothing here needs `public`.
    sql = postgres(process.env.REMO_E2E_DB_URL!, {
      max: 2,
      idle_timeout: 5,
      connect_timeout: 10,
      connection: { search_path: NS },
    })
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

    const [stillRow] = await sql<{ still: string }[]>`
      SELECT count(*)::text AS still FROM api_keys WHERE user_id = ${user.id} AND revoked_at IS NULL
    `
    expect(Number(stillRow.still)).toBe(3)
  }, 45_000)

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
  }, 20_000)

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

  // Milestone WORK: work_sites / work_repo_allowlist / work_runs must converge through the
  // SAME strict double-apply. The `ALTER TABLE … ADD COLUMN IF NOT EXISTS` statements that
  // grow work_sites/work_runs on the "agent proposes, hub disposes" rewrite are the risky
  // shape — this seeds a row carrying those columns and re-applies schema.sql twice.
  it('work_* tables converge with seeded rows through a double-apply', async () => {
    await applySchemaStrict(sql)

    const email = `work-${randomUUID()}@invalid.local`
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${email}, 'x', 'user') RETURNING id
    `
    const ident = 'github://acme/hyperoptimizedwebsites'
    await sql`INSERT INTO work_repo_allowlist (user_id, repo_ident) VALUES (${user.id}, ${ident})`
    const [site] = await sql<{ id: string; auto_publish: boolean; default_branch: string }[]>`
      INSERT INTO work_sites (user_id, repo_ident, site_key, site_dir, client_emails,
                              build_cmd, verify_url, preview_verify_url, coolify_app_uuid)
      VALUES (${user.id}, ${ident}, 'clientco', 'sites/clientco', ARRAY['owner@clientco.com'],
              'bun run build', 'https://clientco.example/', 'https://preview.example/', 'uuid-1')
      RETURNING id, auto_publish, default_branch
    `
    // Defaults land: auto_publish FALSE, default_branch 'main' (the hub-disposes columns).
    expect(site.auto_publish).toBe(false)
    expect(site.default_branch).toBe('main')

    await sql`
      INSERT INTO work_runs (user_id, session_id, repo_ident, site_key, site_id,
                             request_text, prompt, nonce, branch, status, hub_qc, deploy_status)
      VALUES (${user.id}, 'sess-1', ${ident}, 'clientco', ${site.id},
              'change the headline', 'FULL PROMPT TEXT', 'noncedeadbeef',
              'work/noncedeadbeef', 'verifying', ${JSON.stringify({ ok: false })}::jsonb, 'not_published')
    `

    // Boot 2 + 3 — schema.sql re-runs IN FULL. Must NOT throw with these rows present.
    await applySchemaStrict(sql)
    await applySchemaStrict(sql)

    const [{ c }] = await sql<{ c: string }[]>`
      SELECT count(*)::text AS c FROM work_runs WHERE user_id = ${user.id}
    `
    expect(Number(c)).toBe(1)

    // The unique (user_id, repo_ident, site_key) index still bites.
    let dup = false
    try {
      await sql`
        INSERT INTO work_sites (user_id, repo_ident, site_key, site_dir)
        VALUES (${user.id}, ${ident}, 'clientco', 'sites/clientco')
      `
    } catch { dup = true }
    expect(dup).toBe(true)
  }, 45_000)

  // Milestone once: scheduled_tasks grows `schedule_kind` (CHECK cron|once) +
  // `run_at`. A seeded 'once' row (incl. the new task_type='work') must converge
  // through the SAME strict double-apply, and the CHECK must still bite.
  it('scheduled_tasks converges with a schedule_kind=once / task_type=work row through a double-apply', async () => {
    await applySchemaStrict(sql)

    const email = `once-${randomUUID()}@invalid.local`
    const [user] = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${email}, 'x', 'user') RETURNING id
    `
    const [sess] = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${user.id}, 'once-sess', '/repos/clientco', ${'h-once-' + randomUUID()}) RETURNING id
    `
    // A one-time 'work' task: no cron (@once sentinel), run_at set, schedule_kind='once'.
    const [task] = await sql<{ id: string; schedule_kind: string }[]>`
      INSERT INTO scheduled_tasks (
        user_id, session_id, name, cron_expression, prompt,
        task_type, target_kind, target_id, timezone,
        schedule_kind, run_at, payload
      ) VALUES (
        ${user.id}, ${sess.id}, 'Work · clientco', '@once', '',
        'work', 'session', ${sess.id}, 'UTC',
        'once', now(), ${JSON.stringify({ work_id: 'w1' })}::jsonb
      )
      RETURNING id, schedule_kind
    `
    expect(task.schedule_kind).toBe('once')

    // Boot 2 + 3 — schema.sql re-runs IN FULL. Must NOT throw with the once row present.
    await applySchemaStrict(sql)
    await applySchemaStrict(sql)

    const [row] = await sql<{ schedule_kind: string; run_at: string | null; task_type: string }[]>`
      SELECT schedule_kind, run_at, task_type FROM scheduled_tasks WHERE id = ${task.id}
    `
    expect(row.schedule_kind).toBe('once')
    expect(row.task_type).toBe('work')
    expect(row.run_at).not.toBeNull()

    // Every pre-existing row defaults to schedule_kind='cron' / run_at NULL (no backfill).
    const [legacy] = await sql<{ id: string }[]>`
      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, task_type, target_kind, target_id, timezone)
      VALUES (${user.id}, ${sess.id}, 'Cron dev', '0 * * * *', 'go', 'dev', 'session', ${sess.id}, 'UTC')
      RETURNING id
    `
    const [legacyRow] = await sql<{ schedule_kind: string; run_at: string | null }[]>`
      SELECT schedule_kind, run_at FROM scheduled_tasks WHERE id = ${legacy.id}
    `
    expect(legacyRow.schedule_kind).toBe('cron')
    expect(legacyRow.run_at).toBeNull()

    // The CHECK constraint bites: an out-of-domain schedule_kind is rejected.
    let bad = false
    try {
      await sql`
        INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt, target_kind, timezone, schedule_kind)
        VALUES (${user.id}, ${sess.id}, 'bad', '@once', '', 'session', 'UTC', 'weekly')
      `
    } catch { bad = true }
    expect(bad).toBe(true)
  }, 45_000)
})

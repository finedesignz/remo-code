/**
 * Phase 22 (auto-dev-orchestrator) — global queue + per-session lock + drain.
 *
 * Two layers (mirrors orchestrator-data-model.test.ts):
 *   1. Always-on (no DB): enum/priority ordering, config defaults, and the
 *      dormancy invariant (drainOnce claims nothing without a registered runner).
 *   2. Env-gated e2e (REMO_E2E_DB_URL): real Postgres. Asserts the atomic claim
 *      respects the global cap, the per-session lock coalesces a 2nd cycle,
 *      priority+FIFO ordering, and release-on-error frees the lock.
 *
 * Reqs: R-ADO-05 (global cap), R-ADO-06 (FIFO+priority), R-ADO-07 (per-session lock).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'

// ── Always-on (no DB) ─────────────────────────────────────────────────────────

describe('routine queue — always-on (no DB)', () => {
  test('deploy-fix outranks build (priority enum)', async () => {
    const q = await import('../src/orchestrator/queue.ts')
    expect(q.CyclePriority.DEPLOY_FIX).toBeGreaterThan(q.CyclePriority.BUILD)
  })

  test('global concurrency cap is a positive int (default 2)', async () => {
    const q = await import('../src/orchestrator/queue.ts')
    expect(Number.isInteger(q.GLOBAL_CONCURRENCY)).toBe(true)
    expect(q.GLOBAL_CONCURRENCY).toBeGreaterThan(0)
  })

  test('drainOnce is dormant with no runner registered (claims nothing)', async () => {
    const q = await import('../src/orchestrator/queue.ts')
    q._resetForTests() // ensures no runner
    const claimed = await q.drainOnce()
    expect(claimed).toEqual([])
  })
})

// ── Env-gated e2e (REMO_E2E_DB_URL) ───────────────────────────────────────────

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

describe('routine queue — e2e harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — orchestrator-queue e2e SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

maybe('routine queue — e2e', () => {
  let sql: any
  let q: typeof import('../src/orchestrator/queue.ts')
  let userId: string
  let sA: string
  let sB: string
  let sC: string

  async function mkSession(name: string): Promise<string> {
    const r = await sql`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${userId}, ${name}, ${'/tmp/' + name}, ${`h-${name}-${Date.now()}`})
      RETURNING id
    `
    return r[0].id
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    const SCHEMA = await Bun.file(new URL('../src/db/schema.sql', import.meta.url)).text()
    await sql.unsafe(SCHEMA)
    q = await import('../src/orchestrator/queue.ts')

    const u = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${`adoq-${Date.now()}@e2e.local`}, 'x') RETURNING id
    `
    userId = u[0].id
    sA = await mkSession('qa')
    sB = await mkSession('qb')
    sC = await mkSession('qc')
  })

  afterAll(async () => {
    if (sql && userId) await sql`DELETE FROM users WHERE id = ${userId}`
  })

  beforeEach(async () => {
    q._resetForTests()
    await sql`DELETE FROM routine_queue WHERE session_id IN (${sA}, ${sB}, ${sC})`
  })

  test('claim respects the global cap', async () => {
    // 3 pending across 3 distinct sessions, cap=2 → only 2 claimed.
    await q.enqueueCycle(sA, q.CyclePriority.BUILD)
    await q.enqueueCycle(sB, q.CyclePriority.BUILD)
    await q.enqueueCycle(sC, q.CyclePriority.BUILD)
    const claimed = await q.claimCycles(2)
    expect(claimed.length).toBe(2)
    const running = await sql`SELECT count(*)::int AS n FROM routine_queue WHERE status='running'`
    expect(running[0].n).toBe(2)
    // A subsequent claim with the same cap can't exceed it (2 already running).
    const more = await q.claimCycles(2)
    expect(more.length).toBe(0)
  })

  test('per-session lock: 2nd cycle for a running session is NOT claimed', async () => {
    // Two pending rows for the SAME session; cap 5. Only one may run.
    await q.enqueueCycle(sA, q.CyclePriority.BUILD)
    await q.enqueueCycle(sA, q.CyclePriority.BUILD)
    const claimed = await q.claimCycles(5)
    expect(claimed.length).toBe(1)
    expect(claimed[0].session_id).toBe(sA)
    const running = await sql`SELECT count(*)::int AS n FROM routine_queue WHERE session_id=${sA} AND status='running'`
    expect(running[0].n).toBe(1)
    const pending = await sql`SELECT count(*)::int AS n FROM routine_queue WHERE session_id=${sA} AND status='pending'`
    expect(pending[0].n).toBe(1) // the 2nd is coalesced (stays pending), not stacked into running
  })

  test('priority then FIFO ordering', async () => {
    // sA build (oldest), sB deploy-fix (newer), sC build (newest). cap 1 → deploy-fix wins.
    await q.enqueueCycle(sA, q.CyclePriority.BUILD)
    await new Promise((r) => setTimeout(r, 5))
    await q.enqueueCycle(sB, q.CyclePriority.DEPLOY_FIX)
    await new Promise((r) => setTimeout(r, 5))
    await q.enqueueCycle(sC, q.CyclePriority.BUILD)
    const first = await q.claimCycles(1)
    expect(first[0].session_id).toBe(sB) // highest priority
    await q.releaseCycle(first[0].id, 'done')
    // Now among the two BUILD rows, the OLDER (sA) wins (FIFO).
    const second = await q.claimCycles(1)
    expect(second[0].session_id).toBe(sA)
  })

  test('release-on-error: runner throw -> failed, lock released, retryable', async () => {
    await q.enqueueCycle(sA, q.CyclePriority.BUILD)
    let calls = 0
    q.setCycleRunner(async () => {
      calls++
      throw new Error('boom')
    })
    const claimed = await q.drainOnce()
    expect(claimed.length).toBe(1)
    expect(calls).toBe(1)
    const row = await sql`SELECT status FROM routine_queue WHERE session_id=${sA} ORDER BY enqueued_at DESC LIMIT 1`
    expect(row[0].status).toBe('failed')
    const stillRunning = await sql`SELECT count(*)::int AS n FROM routine_queue WHERE session_id=${sA} AND status='running'`
    expect(stillRunning[0].n).toBe(0) // lock released
  })

  test('drainOnce runs the registered runner and marks done', async () => {
    await q.enqueueCycle(sA, q.CyclePriority.BUILD)
    const seen: string[] = []
    q.setCycleRunner(async (e) => {
      seen.push(e.session_id)
    })
    const claimed = await q.drainOnce()
    expect(claimed.length).toBe(1)
    expect(seen).toEqual([sA])
    const row = await sql`SELECT status FROM routine_queue WHERE session_id=${sA} ORDER BY enqueued_at DESC LIMIT 1`
    expect(row[0].status).toBe('done')
  })
})

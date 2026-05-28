/**
 * Integration tests for the orchestrator-session feature.
 *
 * Env-gated on REMO_E2E_DB_URL — without it, the suite skips cleanly so
 * default `bun test` runs stay green. Mirrors the gate pattern used by
 * chat-tabs.test.ts.
 *
 * Asserts:
 *   1. prefs round-trip (defaults + PUT semantics)
 *   2. createOrchestratorSession works once, and the partial unique index
 *      blocks a second open orchestrator row for the same user
 *   3. mintOrchestratorApiKey revokes prior orchestrator-purpose key but
 *      leaves a supervisor-purpose key alone
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

describe('orchestrator — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log('[e2e] REMO_E2E_DB_URL not set — orchestrator e2e is SKIPPED.')
    }
  })
})

maybe('orchestrator e2e', () => {
  let sql: any
  let dal: typeof import('../src/db/orchestrator-dal.ts')
  let userId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(32)
    const pg = await import('../src/db/postgres.ts')
    sql = pg.sql
    dal = await import('../src/db/orchestrator-dal.ts')

    const schemaFile = Bun.file(new URL('../src/db/schema.sql', import.meta.url))
    await sql.unsafe(await schemaFile.text())

    const u = await sql`
      INSERT INTO users (email, password_hash)
      VALUES (${`orch-${Date.now()}@e2e.local`}, 'x')
      RETURNING id
    `
    userId = u[0].id
  })

  afterAll(async () => {
    if (!sql) return
    if (userId) await sql`DELETE FROM users WHERE id = ${userId}`
    try { await sql.end({ timeout: 1 }) } catch {}
  })

  test('prefs default to disabled + "Orchestrator"', async () => {
    const s = await dal.getOrchestratorState(userId)
    expect(s.orchestrator_enabled).toBe(false)
    expect(s.orchestrator_name).toBe('Orchestrator')
    expect(s.orchestrator_custom_instructions).toBeNull()
  })

  test('updateOrchestratorState only touches supplied keys', async () => {
    const a = await dal.updateOrchestratorState(userId, { orchestrator_enabled: true })
    expect(a.orchestrator_enabled).toBe(true)
    expect(a.orchestrator_name).toBe('Orchestrator')

    const b = await dal.updateOrchestratorState(userId, { orchestrator_name: 'Captain' })
    expect(b.orchestrator_enabled).toBe(true) // unchanged
    expect(b.orchestrator_name).toBe('Captain')

    const c = await dal.updateOrchestratorState(userId, { orchestrator_custom_instructions: 'be terse' })
    expect(c.orchestrator_custom_instructions).toBe('be terse')

    // Reset to disabled for the next test block.
    await dal.updateOrchestratorState(userId, { orchestrator_enabled: false })
  })

  test('partial unique index blocks second open orchestrator session', async () => {
    const first = await dal.createOrchestratorSession({
      userId,
      name: 'O',
      projectDir: '/tmp/repos',
      tokenHash: 'h'.repeat(40),
      hostname: 'host-a',
    })
    expect(first.id).toBeTruthy()
    expect((first as any).is_orchestrator).toBe(true)

    let err: any = null
    try {
      await dal.createOrchestratorSession({
        userId,
        name: 'O2',
        projectDir: '/tmp/repos2',
        tokenHash: 'h'.repeat(40),
        hostname: 'host-b',
      })
    } catch (e) { err = e }
    expect(err).toBeTruthy()
    expect(String(err?.message ?? err)).toMatch(/idx_sessions_orchestrator_unique|duplicate key/i)

    const open = await dal.findOpenOrchestratorSession(userId)
    expect(open?.id).toBe(first.id)

    // Soft-delete the row so the unique index releases the slot for the next test run.
    await sql`UPDATE sessions SET deleted_at = now() WHERE id = ${first.id}`
  })

  test('mintOrchestratorApiKey leaves supervisor-purpose key alone', async () => {
    // Seed a supervisor key directly.
    await sql`
      INSERT INTO api_keys (user_id, key_hash, name, purpose)
      VALUES (${userId}, ${'s'.repeat(64)}, 'supervisor', 'supervisor')
    `
    await dal.mintOrchestratorApiKey(userId, 'a'.repeat(64))
    await dal.mintOrchestratorApiKey(userId, 'b'.repeat(64)) // second mint revokes the first

    const rows = await sql`
      SELECT purpose, revoked_at FROM api_keys
      WHERE user_id = ${userId} ORDER BY created_at
    `
    const sup = rows.filter((r: any) => r.purpose === 'supervisor')
    const orch = rows.filter((r: any) => r.purpose === 'orchestrator')
    expect(sup.length).toBe(1)
    expect(sup[0].revoked_at).toBeNull() // untouched
    expect(orch.length).toBe(2)
    expect(orch[0].revoked_at).not.toBeNull() // first one revoked
    expect(orch[1].revoked_at).toBeNull()     // newest active
  })
})

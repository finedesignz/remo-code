/**
 * Phase 23 (auto-dev-orchestrator) — run-log read/write round-trip.
 *
 *   1. Always-on (no DB): the wrapper re-exports the DAL functions (smoke).
 *   2. Env-gated e2e (REMO_E2E_DB_URL): real Postgres append → recent round-trip,
 *      newest-first ordering, per-session scoping. Mirrors the gating in
 *      orchestrator-queue.test.ts / orchestrator-data-model.test.ts.
 *
 * Reqs: R-ADO-04 / R-ADO-10 (run-log write), R-ADO-08 (run-log read into context).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { appendRunLog, recentRunLog } from '../src/orchestrator/run-log.ts'

describe('run-log — always-on (no DB)', () => {
  test('appendRunLog / recentRunLog are functions', () => {
    expect(typeof appendRunLog).toBe('function')
    expect(typeof recentRunLog).toBe('function')
  })
})

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

if (!HAS_TEST_DB) {
  console.log(
    '[e2e] REMO_E2E_DB_URL not set — orchestrator run-log e2e SKIPPED. ' +
      'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
  )
}

maybe('run-log — e2e round-trip (REMO_E2E_DB_URL)', () => {
  let sql: any
  const sessionId = `sess-runlog-${Date.now()}`

  beforeAll(async () => {
    const mod = await import('../src/db/postgres.ts')
    sql = mod.sql
    const schema = await Bun.file(new URL('../src/db/schema.sql', import.meta.url)).text()
    await sql.unsafe(schema)
  })

  afterAll(async () => {
    try {
      await sql`DELETE FROM routine_run_log WHERE session_id = ${sessionId}`
    } catch { /* ignore */ }
  })

  test('append then recent returns newest-first, scoped to the session', async () => {
    const a = await appendRunLog({
      session_id: sessionId,
      repo_key: 'owner/repo',
      command: 'gsd-execute-phase',
      outcome: 'success',
      pr_url: 'https://github.com/owner/repo/pull/1',
      reviewer_verdict: 'PASS',
    })
    expect(a.id).toBeTruthy()
    expect(a.command).toBe('gsd-execute-phase')

    await appendRunLog({
      session_id: sessionId,
      command: 'gsd-code-review',
      outcome: 'success',
      gap_dimension: 'security',
    })

    // A different session's row must NOT leak in.
    await appendRunLog({ session_id: `other-${sessionId}`, command: 'noise', outcome: 'success' })

    const recent = await recentRunLog(sessionId, 10)
    expect(recent.length).toBe(2)
    // newest first
    expect(recent[0].command).toBe('gsd-code-review')
    expect(recent[1].command).toBe('gsd-execute-phase')

    await sql`DELETE FROM routine_run_log WHERE session_id = ${`other-${sessionId}`}`
  })
})

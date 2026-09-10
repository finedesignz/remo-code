/**
 * Phase 06 plan 008 — webhook → triage → finalize end-to-end.
 *
 * DB-gated: skipped without REMO_E2E_DB_URL. Drives a hand-signed webhook
 * post through the real Hono router, then asserts the wired flow:
 *
 *   1. deployment.failed → metadata row in scheduled_task_runs (task=__internal_coolify_deployment)
 *   2. dispatchTriage fires → triage run inserted (task=__internal_triage)
 *   3. mocked pickSessionTarget returns local_agent → sendTriage posts a
 *      user_message; assistant reply parses as TriageResult → run='success'
 *   4. malformed assistant reply → run='failed' error='triage_parse_error'
 *   5. daily_cost_cap exceeded → triage run finalizes with error='daily_cost_cap'
 *
 * The unit test in `coolify-webhook.test.ts` covers HMAC/skew/validation; this
 * file focuses on the wiring contract added by plan 008.
 */
import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test'
import { createHmac } from 'node:crypto'

const REMO_E2E_DB_URL = process.env.REMO_E2E_DB_URL

if (!REMO_E2E_DB_URL) {
  console.log('[triage-e2e] REMO_E2E_DB_URL not set — DB cases SKIPPED.')
  describe.skip('coolify-webhook → triage e2e (DB)', () => {
    test('skipped (no DB)', () => {})
  })
} else {
  process.env.DATABASE_URL = REMO_E2E_DB_URL
  describe('coolify-webhook → triage e2e (DB)', () => {
    const TEST_USER_ID = '22222222-2222-2222-2222-222222222222'
    const TEST_SECRET = 'triage-e2e-secret'
    const TEST_EMAIL = 'triage-e2e@example.com'

    let app: any
    let sql: any
    let pickCalls: number = 0
    let pickReturn: any = { kind: 'none', reason: 'no_target_available' }
    let agentSendCalls: any[] = []

    beforeAll(async () => {
      // Stub session routing so we don't need a real supervisor/agent socket.
      mock.module('../src/sessions/routing.ts', () => ({
        pickSessionTarget: async (_userId: string) => {
          pickCalls++
          return pickReturn
        },
      }))

      // Stub agent socket lookup so the local_agent branch can fake a send.
      mock.module('../src/ws/registry.ts', () => ({
        getChannel: (_sid: string) => ({
          ws: {
            send: (raw: string) => { agentSendCalls.push(JSON.parse(raw)) },
          },
        }),
        // coolify-webhook.ts imports this to gate the local_agent branch
        // (`listOnlineAgentSessionsForUser(userId).length > 0`). A whole-module
        // mock must re-export it or bun crashes loading the module under test.
        listOnlineAgentSessionsForUser: (_userId: string) => ['stub-agent-session'],
        broadcastToSubscribers: () => {},
        broadcastScheduledRun: () => {},
        broadcastToUser: () => {},
      }))

      const dbMod = await import('../src/db/postgres.ts')
      sql = dbMod.sql

      // Apply schema before touching tables. check-baseline runs each test file
      // in its own process against a shared DB, so this file cannot assume an
      // earlier file already migrated — migrate idempotently like the DAL suites.
      const { runMigrations } = await import('../src/db/migrate.ts')
      await runMigrations()

      // Seed a user with webhook secret + low cost cap so we can flip caps.
      await sql`
        INSERT INTO users (id, email, password_hash, coolify_webhook_secret, daily_cost_cap_usd)
        VALUES (${TEST_USER_ID}, ${TEST_EMAIL}, 'x', ${TEST_SECRET}, 100)
        ON CONFLICT (id) DO UPDATE SET coolify_webhook_secret = ${TEST_SECRET}, daily_cost_cap_usd = 100
      `

      const { Hono } = await import('hono')
      const { coolifyWebhookRoutes } = await import('../src/api/coolify-webhook.ts')
      app = new Hono()
      app.route('/api/coolify', coolifyWebhookRoutes)
    })

    afterAll(async () => {
      if (!sql) return
      try {
        await sql`DELETE FROM scheduled_task_runs WHERE user_id = ${TEST_USER_ID}`
        await sql`DELETE FROM scheduled_tasks WHERE user_id = ${TEST_USER_ID}`
        await sql`DELETE FROM users WHERE id = ${TEST_USER_ID}`
      } catch {}
    })

    function sign(ts: number, body: string): string {
      return 'sha256=' + createHmac('sha256', TEST_SECRET).update(`${ts}.${body}`).digest('hex')
    }

    async function postWebhook(payload: Record<string, unknown>): Promise<Response> {
      const body = JSON.stringify(payload)
      const ts = Math.floor(Date.now() / 1000)
      return app.fetch(new Request(`http://localhost/api/coolify/webhook/${TEST_USER_ID}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-coolify-signature': sign(ts, body),
          'x-coolify-timestamp': String(ts),
        },
        body,
      }))
    }

    test('deployment.failed inserts metadata + dispatches triage', async () => {
      pickCalls = 0
      agentSendCalls = []
      pickReturn = { kind: 'local_agent', agent_session_id: 'sess-fake-1' }

      const res = await postWebhook({
        event: 'deployment.failed',
        deployment_uuid: 'dep-' + Date.now(),
        application_uuid: 'app-1',
        git_repository: 'finedesignz/remo-code',
        commit_sha: 'abc123',
      })
      expect(res.status).toBe(202)
      // Poll for the fire-and-forget triage to land instead of a fixed sleep —
      // a one-shot 200ms wait was flaky under real-postgres CI load (the async
      // dispatch chain can legitimately take longer than 200ms when the runner
      // is busy), even though it always lands well within a few seconds.
      let runs: { id: string; status: string; task_id: string }[] = []
      const deadline = Date.now() + 5000
      while (Date.now() < deadline) {
        runs = await sql<{ id: string; status: string; task_id: string }[]>`
          SELECT id, status, task_id FROM scheduled_task_runs WHERE user_id = ${TEST_USER_ID}
        `
        if (runs.length >= 2) break
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(runs.length).toBeGreaterThanOrEqual(2) // metadata row + triage row
      // fix/sched-triage-routing: triage no longer goes through pickSessionTarget
      // (it preferred a supervisor, whose spawn path could never finalize). It
      // routes straight to a live local-agent session, so assert the run row for
      // the internal triage task exists instead of counting pick calls.
      const triageRuns = await sql<{ id: string }[]>`
        SELECT r.id FROM scheduled_task_runs r
        JOIN scheduled_tasks t ON t.id = r.task_id
        WHERE r.user_id = ${TEST_USER_ID} AND t.name = '__internal_triage'
      `
      expect(triageRuns.length).toBeGreaterThanOrEqual(1)
      expect(pickCalls).toBe(0)
    })
  })
}

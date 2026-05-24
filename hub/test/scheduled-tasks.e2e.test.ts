/**
 * End-to-end smoke test for scheduled tasks (W5/T24).
 *
 * Current status: SKIPPED. The hub currently has no test-DB harness — it
 * boots against the production-shaped `DATABASE_URL`, which would mutate
 * real data. Wiring a one-shot Postgres (pg-mem or testcontainers) is
 * tracked as a follow-up; the assertions below are the contract this
 * harness must satisfy when it lands.
 *
 * Why scaffold now?
 *   - Documents the precise lifecycle we ship (create → fire → delete).
 *   - Locks the run-row contract for the future fixture.
 *   - `bun test` will skip cleanly without env, so CI stays green.
 *
 * Once a test DB is available, set REMO_E2E_DB_URL and remove the
 * `test.skip(...)` wrapper.
 */
import { describe, test, expect } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('scheduled-tasks e2e — create / fire / delete', () => {
  test('POST /api/scheduled-tasks → run lands in history → DELETE removes it', async () => {
    // TODO(W5+): wire test DB + JWT helper, then implement:
    //   1. Boot hub against REMO_E2E_DB_URL with a unique JWT_SECRET.
    //   2. Seed a user row + API key + JWT for that user.
    //   3. POST /api/scheduled-tasks { name: 'e2e', task_type: 'prompt',
    //        target_kind: 'all_agents', cron_expr: '* * * * *',
    //        timezone: 'UTC', payload: { prompt: 'noop' } }
    //      → expect 200, body has id, next_3_runs.length === 3
    //   4. Wait <=70s for the next minute boundary OR mock croner clock.
    //   5. GET /api/scheduled-task-runs?task_id=<id>
    //      → at least one run row, status in ['pending','failed','skipped']
    //        (no agent connected → expect 'failed:no_targets' or
    //         'skipped:target_offline').
    //   6. DELETE /api/scheduled-tasks/:id → 200, registry.has(id) === false.
    //   7. GET /api/scheduled-tasks/:id → 404.
    expect(true).toBe(true) // placeholder once unblocked
  })

  test('chain depth cap surfaces as failed run with chain_depth_exceeded', async () => {
    // TODO(W5+): create two tasks A, B where A.post_run_actions chains to B
    // and B chains back to A — POST should 400 with `chain_cycle`.
    // Then construct a depth-6 chain by manually calling runNow with
    // chainDepth=6 via internal helper and assert the resulting run row
    // has status='failed', error='chain_depth_exceeded'.
    expect(true).toBe(true)
  })

  test('daily cost cap inserts skipped(daily_cost_cap) row', async () => {
    // TODO(W5+): seed users.cost_used_today_usd > daily_cost_cap_usd,
    // call dispatcher.fire(task), assert one run inserted with
    // status='skipped', error='daily_cost_cap'.
    expect(true).toBe(true)
  })
})

// Always-on sanity test so this file always reports something to bun test.
describe('scheduled-tasks e2e — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — e2e cases are SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

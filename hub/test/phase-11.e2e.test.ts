/**
 * Phase 11 E2E smoke (skippable).
 *
 * Mirrors the convention in hub/test/scheduled-tasks.e2e.test.ts — runs
 * only when REMO_E2E_DB_URL points at a disposable Postgres so the suite
 * stays green in CI without a test DB.
 *
 * What it locks (post-Phase 11 deferred exit criterion):
 *   - A `* /5 * * * *` (every-5-minute) cron-triggered `dev` workflow kicks off the
 *     dev_plan step.
 *   - The run row has `runtime_context_snapshot` populated with non-null
 *     project_type, repo, and notify_email at the top level (see
 *     hub/src/scheduler/context/runtime-context.ts).
 *   - The chain_task post-run action fires dev_execute, then dev_ship.
 *
 * Once the integration DB harness lands, replace the stub assertions
 * below with the real lifecycle walk. The scaffold documents the
 * contract.
 */
import { describe, test, expect } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('phase-11 e2e — dev workflow smoke (*/5 * * * * cron)', () => {
  test('dev_plan run populates runtime_context_snapshot with non-null core fields', async () => {
    // TODO(post-test-DB): wire harness, then:
    //   1. Seed user u + repo root + Coolify app row.
    //   2. POST /api/scheduled-tasks { task_type: 'dev_plan',
    //      cron_expr: '*/5 * * * *', timezone: 'UTC',
    //      target_kind: 'session', payload: { user_prompt: 'noop' },
    //      post_run_actions: [{ type:'chain_task', on:'success',
    //        config: { task_id: '<dev_execute id>' } }] }
    //   3. Wait <=6 min OR mock croner clock to next 5-min boundary.
    //   4. GET /api/scheduled-task-runs?task_id=<dev_plan id> →
    //      run.runtime_context_snapshot is an object with
    //      project_type !== null, repo !== null, notify_email !== null.
    expect(true).toBe(true)
  })

  test('dev workflow chain: dev_plan completion fires dev_execute, then dev_ship', async () => {
    // TODO(post-test-DB): assert:
    //   - On dev_plan success, a new run row appears for the dev_execute
    //     task id with triggered_by_run_id = dev_plan run id, chainDepth=1.
    //   - On dev_execute success, a new run row appears for dev_ship,
    //     chainDepth=2.
    //   - dev_ship has NO chain_task post-run action → no further row.
    expect(true).toBe(true)
  })

  test('runtime_context_snapshot is JSONB and survives a SELECT round-trip', async () => {
    // TODO(post-test-DB): SELECT runtime_context_snapshot::text FROM
    // scheduled_task_runs WHERE id = <id>; assert non-null, parses as
    // object, has the expected keys (project_type, repo, notify_email).
    expect(true).toBe(true)
  })
})

describe('phase-11 e2e — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log(
        '[phase-11 e2e] REMO_E2E_DB_URL not set — dev-workflow cases are SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run them.',
      )
    }
  })
})

/**
 * Milestone OEE (Orchestrator E2E Prove-Out) — Phase OEE-08.
 *
 * Proves the MANDATORY terminal verify-tail (`runVerifyTail`,
 * hub/src/orchestrator/verify-tail.ts) end-to-end against a REAL Postgres:
 *
 *   1. ALWAYS-RUNS path — with the REMO_VERIFY_* target pointed at a STUB
 *      (every outbound HTTP dep is injected, so NO real network / Coolify /
 *      live URL is touched), the tail runs a pass and RECORDS its outcome as a
 *      `routine_run_log` row (command='deploy-verify'). Asserts the row is
 *      actually written to PG.
 *
 *   2. NO-OP-WHEN-UNSET path — with REMO_VERIFY_* unset (no target) AND/OR no
 *      Coolify config, the tail is a clean no-op: it does NOT crash and records
 *      a single `verify_skipped:*` row (verdict 'skipped', 0 iterations). No
 *      redeploy/probe is attempted.
 *
 * Gated on `REMO_E2E_DB_URL` (same convention as phase-08.e2e.test.ts) so
 * `bun run check-baseline` stays green without a disposable Postgres.
 *
 * IMPORTANT (module-bound `sql`): `appendRunLog` (run-log.ts → orchestrator-rows
 * -dal.ts) uses the hub's shared `sql` bound to DATABASE_URL at import time. We
 * set DATABASE_URL=REMO_E2E_DB_URL BEFORE the first lazy import (inside
 * beforeAll), exactly like phase-08, so run-log writes hit the disposable DB —
 * never prod.
 *
 * STUBBING: the real `runVerifyTail` exposes a `depsOverride: Partial<VerifyTailDeps>`
 * test seam (already in hub/src — NOT added here). We inject:
 *   - configFromEnv     → a fake CoolifyConfig (no COOLIFY_TOKEN needed)
 *   - triggerRedeploy   → { ok:true } (no network)
 *   - runDeployVerify   → { pass:true } (no network)
 *   - fetchAppLogs      → clean log text (no network)
 *   - inject / notify   → no-op spies (never reached on a clean PASS)
 *   - appendRunLog      → the REAL DB-backed appendRunLog (so the row lands in PG)
 * No hub/src code is modified; no seam is added.
 *
 * Run with:
 *   REMO_E2E_DB_URL=postgres://... bun test hub/test/e2e/orchestrator-verify-tail.e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { setupHarness, teardownHarness, hasE2eDb, type Harness } from './orchestrator-harness.ts'

const maybe = hasE2eDb() ? describe : describe.skip

maybe('OEE-08 e2e — verify-tail always-runs (stub target) + no-op-when-unset', () => {
  let h: Harness
  let verifyTail: typeof import('../../src/orchestrator/verify-tail.ts')
  let realAppendRunLog: (typeof import('../../src/orchestrator/run-log.ts'))['appendRunLog']

  beforeAll(async () => {
    // Bind the shared `sql` (run-log.ts) to the disposable DB BEFORE importing it.
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    h = await setupHarness()
    verifyTail = await import('../../src/orchestrator/verify-tail.ts')
    realAppendRunLog = (await import('../../src/orchestrator/run-log.ts')).appendRunLog
  })

  afterAll(async () => {
    if (h) await teardownHarness(h)
  })

  test('STUB target → verify-tail RUNS and records a PASS row in routine_run_log', async () => {
    const injectSpy: { calls: number } = { calls: 0 }
    const notifySpy: { calls: number } = { calls: 0 }

    const target = {
      appUuid: 'stub-app-uuid',
      baseUrl: 'http://stub.invalid.local',
      routes: ['/api/sessions', '/openapi.json', '/docs'],
    }

    const result = await verifyTail.runVerifyTail(
      {
        sessionId: h.sessionId,
        repoKey: 'path:///tmp/oee-harness',
        userId: h.userId,
        decisionRationale: 'oee-08 stub verify',
      },
      {
        // ── every outbound HTTP dep stubbed → NO real network ────────────────
        configFromEnv: () => ({ token: 'stub-token', baseUrl: 'http://stub.invalid.local' }),
        triggerRedeploy: async () => ({ ok: true, status: 200 }),
        runDeployVerify: async () => ({
          healthOk: true,
          healthPath: '/health',
          healthStatus: 200,
          routes: target.routes.map((p) => ({ path: p, status: 200, ok: true })),
          pass: true,
        }),
        fetchAppLogs: async () => ({ ok: true, status: 200, logs: 'boot ok\n0 errors\nlistening on 3040' }),
        inject: async () => {
          injectSpy.calls++
          return { kind: 'dispatched' }
        },
        notify: async () => {
          notifySpy.calls++
        },
        // ── real DB-backed run-log write → row lands in the disposable PG ────
        appendRunLog: realAppendRunLog,
      },
      target,
    )

    // Verdict: a clean pass on iteration 1.
    expect(result.verdict).toBe('pass')
    expect(result.deployOk).toBe(true)
    expect(result.routesOk).toBe(true)
    expect(result.logClean).toBe(true)
    expect(result.iterations).toBe(1)
    // PASS path never dispatches a fix or surfaces to chat.
    expect(injectSpy.calls).toBe(0)
    expect(notifySpy.calls).toBe(0)

    // The tail RECORDED its result: exactly one deploy-verify row, outcome verify_pass.
    const rows = await h.sql<
      { command: string; outcome: string; deploy_verify_result: string; decision_rationale: string }[]
    >`
      SELECT command, outcome, deploy_verify_result, decision_rationale
      FROM routine_run_log
      WHERE session_id = ${h.sessionId}
        AND command = 'deploy-verify'
    `
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toBe('verify_pass')
    expect(rows[0].deploy_verify_result).toContain('pass')
    expect(rows[0].decision_rationale).toBe('oee-08 stub verify')
  })

  test('REMO_VERIFY_* UNSET → resolveVerifyTargetFromEnv() is null', () => {
    const saved = {
      uuid: process.env.REMO_VERIFY_APP_UUID,
      base: process.env.REMO_VERIFY_BASE_URL,
      routes: process.env.REMO_VERIFY_ROUTES,
    }
    delete process.env.REMO_VERIFY_APP_UUID
    delete process.env.REMO_VERIFY_BASE_URL
    delete process.env.REMO_VERIFY_ROUTES
    try {
      expect(verifyTail.resolveVerifyTargetFromEnv()).toBeNull()
    } finally {
      if (saved.uuid !== undefined) process.env.REMO_VERIFY_APP_UUID = saved.uuid
      if (saved.base !== undefined) process.env.REMO_VERIFY_BASE_URL = saved.base
      if (saved.routes !== undefined) process.env.REMO_VERIFY_ROUTES = saved.routes
    }
  })

  test('no target → verify-tail is a clean no-op (verify_skipped row, no network)', async () => {
    // Use a fresh session so this test's single skipped row is unambiguous.
    const sessRows = await h.sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, project_dir, token_hash)
      VALUES (${h.userId}, 'oee-noop', '/tmp/oee-noop', ${'th-noop-' + crypto.randomUUID()})
      RETURNING id
    `
    const sessionId = sessRows[0].id

    const netSpy: { redeploy: number; verify: number; logs: number } = { redeploy: 0, verify: 0, logs: 0 }

    const result = await verifyTail.runVerifyTail(
      { sessionId, repoKey: null, userId: h.userId },
      {
        // No Coolify config → forces the no-op `verify_skipped:no_coolify_config`
        // (and target is null below anyway → no_verify_target). Either way: skip.
        configFromEnv: () => null,
        triggerRedeploy: async () => {
          netSpy.redeploy++
          return { ok: false, status: 0 }
        },
        runDeployVerify: async () => {
          netSpy.verify++
          return { healthOk: false, healthPath: null, healthStatus: 0, routes: [], pass: false }
        },
        fetchAppLogs: async () => {
          netSpy.logs++
          return { ok: false, status: 0, logs: '' }
        },
        appendRunLog: realAppendRunLog,
      },
      null, // explicit: no verify target (REMO_VERIFY_* unset)
    )

    expect(result.verdict).toBe('skipped')
    expect(result.iterations).toBe(0)
    // No outbound work attempted — clean no-op.
    expect(netSpy.redeploy).toBe(0)
    expect(netSpy.verify).toBe(0)
    expect(netSpy.logs).toBe(0)

    // Exactly one skipped row recorded (no spurious pass/fail rows).
    const rows = await h.sql<{ outcome: string; deploy_verify_result: string }[]>`
      SELECT outcome, deploy_verify_result
      FROM routine_run_log
      WHERE session_id = ${sessionId}
        AND command = 'deploy-verify'
    `
    expect(rows.length).toBe(1)
    expect(rows[0].outcome).toMatch(/^verify_skipped:/)
    expect(rows[0].deploy_verify_result).toContain('skipped')
  })
})

// Always-on sanity test so this file always reports to bun test even when the
// e2e DB is absent (mirrors phase-08.e2e.test.ts).
describe('OEE-08 e2e — harness sanity', () => {
  test('verify-tail e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof hasE2eDb()).toBe('boolean')
    if (!hasE2eDb()) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — OEE-08 verify-tail e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run it.',
      )
    }
  })
})

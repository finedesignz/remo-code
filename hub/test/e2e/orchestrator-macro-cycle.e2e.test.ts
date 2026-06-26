/**
 * Milestone OEE — Phase OEE-05: TMAC `runMacroCycle` + sentinel reconciliation, e2e.
 *
 * Proves the (flag-gated-OFF) Auto-Dev Orchestrator's DEFAULT macro path end-to-end
 * against REAL Postgres via the OEE harness + the scripted bound-session sink. Drives
 * the REAL `runMacroCycle(input, sink.deps)` (no monkeypatching) and asserts:
 *
 *   1. INJECT — one macro prompt is resolved for a given `macro_task_type` and
 *      captured by the sink (the prompt body matches the task_type's macro).
 *   2. RECONCILE — a scripted agent reply carrying <<STATE>>/<<NOTIFY>>/<<GATE>>
 *      is reconciled by the REAL sentinels.ts + macro-cycle reconciliation into a
 *      `routine_run_log` STATE row whose rationale/outcome reflect the STATE block.
 *   3. HALT — an OPEN mandatory <<GATE>> halts re-injection at a halting
 *      lifecycle_stage (production-maintenance / beta) → no resume inject; while a
 *      reply with NO open gate re-injects and continues.
 *
 * Run-log assertions use the REAL DAL (`appendRunLog` → `insertRoutineRunLog`),
 * which binds the hub's shared `sql` to `DATABASE_URL`. We therefore point
 * `DATABASE_URL` at `REMO_E2E_DB_URL` BEFORE the harness/sink import the DAL, and
 * pass `sql: h.sql` to the sink so write-throughs land in the same disposable DB we
 * query — mirroring hub/test/phase-08.e2e.test.ts.
 *
 * Gated on `REMO_E2E_DB_URL`: `describe.skip` (CI-safe import-skip) without it.
 *
 * Run with:
 *   REMO_E2E_DB_URL=postgres://... bun test hub/test/e2e/orchestrator-macro-cycle.e2e.test.ts
 */
import { test, expect, beforeAll, afterAll } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  hasE2eDb,
  maybeDescribe,
  setupHarness,
  teardownHarness,
  createScriptedSink,
  type Harness,
} from './orchestrator-harness.ts';
import type { MacroCycleInput } from '../../src/orchestrator/macro-cycle.ts';

// The hub's shared `sql` (run-log DAL) binds DATABASE_URL at import time, so it
// MUST point at the disposable DB before any DAL is imported (lazy, inside tests).
if (hasE2eDb()) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!;
}

maybeDescribe('OEE-05 e2e — runMacroCycle macro inject + sentinel reconciliation', () => {
  let h: Harness;
  // Lazy-imported AFTER DATABASE_URL is repointed (matches phase-08.e2e.test.ts).
  let runMacroCycle: typeof import('../../src/orchestrator/macro-cycle.ts').runMacroCycle;

  beforeAll(async () => {
    h = await setupHarness();
    ({ runMacroCycle } = await import('../../src/orchestrator/macro-cycle.ts'));
  });

  afterAll(async () => {
    if (h) await teardownHarness(h);
  });

  /** A MacroCycleInput bound to the harness session, parameterized by type+stage. */
  function inputFor(
    macroTaskType: MacroCycleInput['macroTaskType'],
    stage: MacroCycleInput['stage'],
  ): MacroCycleInput {
    return {
      userId: h.userId,
      sessionId: h.sessionId,
      taskId: randomUUID(),
      macroTaskType,
      stage,
      repoPath: '/tmp/oee-harness',
      repoIdent: 'path:///tmp/oee-harness',
      repoKey: 'path:///tmp/oee-harness',
    };
  }

  /** Read all run-log rows for the harness session, newest first. */
  async function runLogRows() {
    return h.sql<
      Array<{ command: string; decision_rationale: string | null; outcome: string | null; deploy_verify_result: string | null }>
    >`
      SELECT command, decision_rationale, outcome, deploy_verify_result
      FROM routine_run_log
      WHERE session_id = ${h.sessionId}
      ORDER BY created_at DESC, id DESC
    `;
  }

  // ── 1. INJECT: one macro prompt per macro_task_type, captured by the sink ─────
  test('resolves and injects ONE macro prompt for the task_type (no prior reply)', async () => {
    // No replies → no reconcile; not run-live → resume injects exactly once.
    const sink = createScriptedSink({ sql: h.sql });
    const result = await runMacroCycle(inputFor('dev', 'development'), sink.deps);

    expect(result.reconciled).toBe(false); // no prior assistant reply
    expect(result.halted).toBe(false);
    expect(result.injected).toBe(true);
    expect(sink.captured.length).toBe(1);

    // The captured prompt is the REAL dev macro (task-macros.ts), substituted.
    const prompt = sink.captured[0].input.prompt;
    expect(prompt).toContain('autonomous DEV routine');
    expect(prompt).toContain('/tmp/oee-harness'); // {repo_path} substituted
    expect(prompt).not.toContain('{repo_path}'); // no unresolved placeholder

    // A resume run-log row was written through to the REAL table.
    const rows = await runLogRows();
    const resume = rows.find((r) => r.command === 'macro:dev' && r.decision_rationale?.includes('resume-heartbeat inject'));
    expect(resume).toBeDefined();
    expect(resume!.outcome).toBe('dispatched');
  });

  test('a DIFFERENT macro_task_type resolves a DIFFERENT macro body', async () => {
    const sink = createScriptedSink({ sql: h.sql });
    await runMacroCycle(inputFor('security', 'development'), sink.deps);
    expect(sink.captured.length).toBe(1);
    expect(sink.captured[0].input.prompt).toContain('autonomous SECURITY-HARDENING routine');
  });

  // ── 2. RECONCILE: STATE sentinel → routine_run_log STATE row ──────────────────
  test('reconciles <<STATE>>/<<NOTIFY>> from a prior reply into a STATE run-log row', async () => {
    const reply = [
      'Did the work.',
      '<<NOTIFY level=info channel=in-app detail="phase 2/6 underway">>',
      '<<STATE',
      'lifecycle: building',
      'milestone: OEE',
      'phase: 2/6',
      'last_action: planned phase OEE-05',
      'next_action: execute phase OEE-05',
      'decisions: backend-architect approved the harness seam',
      'deployed_live: no',
      'STATE>>',
    ].join('\n');

    // development + no gate → reconcile writes STATE row, then resume re-injects.
    const sink = createScriptedSink({ sql: h.sql, replies: [reply] });
    const result = await runMacroCycle(inputFor('dev', 'development'), sink.deps);

    expect(result.reconciled).toBe(true);
    expect(result.halted).toBe(false);
    expect(result.injected).toBe(true); // no open gate in dev → re-injects
    expect(result.sentinels?.state?.lifecycle).toBe('building');

    const rows = await runLogRows();
    const stateRow = rows.find((r) => r.command === 'state');
    expect(stateRow).toBeDefined();
    // STATE → decision_rationale carries the lifecycle position fields.
    expect(stateRow!.decision_rationale).toContain('lifecycle=building');
    expect(stateRow!.decision_rationale).toContain('milestone=OEE');
    expect(stateRow!.decision_rationale).toContain('next=execute phase OEE-05');
    // STATE.lifecycle → outcome; deployed_live → deploy_verify_result.
    expect(stateRow!.outcome).toBe('building');
    expect(stateRow!.deploy_verify_result).toBe('no');
  });

  // ── 3a. HALT: an OPEN mandatory <<GATE>> halts re-inject at a halting stage ───
  test('an open <<GATE>> HALTS re-injection at production-maintenance (no resume inject)', async () => {
    const reply = [
      'Hit a destructive migration; pausing for approval.',
      '<<GATE reason="destructive migration" detail="needs human approval">>',
      '<<NOTIFY level=blocking channel=all detail="awaiting approval on destructive migration">>',
      '<<STATE',
      'lifecycle: building',
      'milestone: OEE',
      'phase: 3/6',
      'last_action: prepared a destructive migration',
      'next_action: await approval, then apply',
      'decisions: none',
      'deployed_live: no',
      'STATE>>',
    ].join('\n');

    const sink = createScriptedSink({ sql: h.sql, replies: [reply] });
    const result = await runMacroCycle(inputFor('dev', 'production-maintenance'), sink.deps);

    expect(result.reconciled).toBe(true);
    expect(result.halted).toBe(true);
    expect(result.injected).toBe(false);
    expect(sink.captured.length).toBe(0); // HALTED → NO resume inject
    expect(result.sentinels?.gate?.reason).toBe('destructive migration');

    // STATE still reconciled before the halt; prod-maintenance gate fans out.
    const rows = await runLogRows();
    expect(rows.some((r) => r.command === 'state')).toBe(true);
    const gateNotify = sink.notifies.find((n) => n.event === 'gate');
    expect(gateNotify).toBeDefined();
    expect(gateNotify!.level).toBe('blocking');
  });

  // ── 3b. CONTINUE: NO open gate → re-injects and continues ─────────────────────
  test('NO open gate at a halting stage → re-injects (continues)', async () => {
    const reply = [
      'Shipped a patch; all green.',
      '<<NOTIFY level=info channel=all detail="maintenance shipped v1.2.4, live">>',
      '<<STATE',
      'lifecycle: idle',
      'milestone: none',
      'phase: none',
      'last_action: shipped v1.2.4',
      'next_action: scan for the next maintenance concern',
      'decisions: none',
      'deployed_live: yes',
      'STATE>>',
    ].join('\n');

    const sink = createScriptedSink({ sql: h.sql, replies: [reply] });
    const result = await runMacroCycle(inputFor('dev', 'production-maintenance'), sink.deps);

    expect(result.reconciled).toBe(true);
    expect(result.halted).toBe(false); // no gate → not halted
    expect(result.injected).toBe(true); // → re-injects
    expect(sink.captured.length).toBe(1);
  });

  // ── 3c. STAGE-SENSITIVITY: same open gate does NOT halt in development ─────────
  test('the same open <<GATE>> does NOT halt in development (dev resolves-and-continues)', async () => {
    const reply = [
      '<<GATE reason="grey-area api shape" detail="picked REST per backend-architect">>',
      '<<STATE',
      'lifecycle: building',
      'last_action: consulted specialist',
      'next_action: implement chosen shape',
      'STATE>>',
    ].join('\n');

    const sink = createScriptedSink({ sql: h.sql, replies: [reply] });
    const result = await runMacroCycle(inputFor('dev', 'development'), sink.deps);

    expect(result.reconciled).toBe(true);
    expect(result.halted).toBe(false); // development does not halt on a gate
    expect(result.injected).toBe(true); // → re-injects
    expect(sink.captured.length).toBe(1);
  });
});

/**
 * Milestone OEE — Phases OEE-01 + OEE-02 smoke test.
 *
 * Gated on REMO_E2E_DB_URL (same convention as phase-08.e2e.test.ts): skips
 * cleanly without a disposable Postgres so `bun run check-baseline` stays green.
 *
 * When set, it:
 *   1. asserts the non-prod DSN guard rejects prod-looking / non-local DSNs and
 *      accepts a local one (this part needs NO DB — always runs),
 *   2. boots the REAL schema.sql against the disposable DB (idempotent re-run),
 *   3. round-trips one scripted prompt+reply through the bound-session sink and
 *      asserts the sentinels parse via the REAL sentinels.ts.
 *
 * Run with:
 *   REMO_E2E_DB_URL=postgres://localhost/remo_e2e bun test hub/test/e2e/orchestrator-harness.smoke.e2e.test.ts
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  hasE2eDb,
  maybeDescribe,
  assertNonProdDsn,
  ProdDsnRefusedError,
  setupHarness,
  teardownHarness,
  createScriptedSink,
  type Harness,
} from './orchestrator-harness.ts';

// ── Non-prod DSN guard — pure, needs no DB, always runs ───────────────────────
describe('OEE-01 non-prod DSN guard', () => {
  test('rejects an empty DSN', () => {
    expect(() => assertNonProdDsn('')).toThrow(ProdDsnRefusedError);
    expect(() => assertNonProdDsn(undefined)).toThrow(ProdDsnRefusedError);
  });

  test('rejects prod-marker DSNs', () => {
    for (const dsn of [
      'postgres://u:p@db.coolify.titaniumlabs.us:5432/remo',
      'postgres://u:p@46.224.61.233:5432/remo',
      'postgres://u:p@xyz.supabase.co:5432/postgres',
      'postgres://u:p@host.rds.amazonaws.com/db',
    ]) {
      expect(() => assertNonProdDsn(dsn, false)).toThrow(ProdDsnRefusedError);
    }
  });

  test('rejects a non-local host without the explicit opt-in', () => {
    expect(() => assertNonProdDsn('postgres://u:p@10.0.0.5:5432/db', false)).toThrow(
      ProdDsnRefusedError,
    );
  });

  test('accepts a non-local host WITH the explicit opt-in', () => {
    expect(() => assertNonProdDsn('postgres://u:p@10.0.0.5:5432/db', true)).not.toThrow();
  });

  test('accepts a local DSN', () => {
    expect(() => assertNonProdDsn('postgres://localhost:5432/remo_e2e', false)).not.toThrow();
    expect(() => assertNonProdDsn('postgres://u:p@127.0.0.1:5432/remo_e2e', false)).not.toThrow();
  });
});

// ── Schema boot + scripted sink round-trip — needs the disposable DB ──────────
maybeDescribe('OEE-01/02 e2e — schema boot + scripted sink round-trip', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setupHarness();
  });

  afterAll(async () => {
    if (h) await teardownHarness(h);
  });

  test('schema.sql booted: orchestrator tables exist', async () => {
    const rows = await h.sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('routine_run_log', 'orchestrator_rows', 'routine_queue', 'sessions', 'users')
    `;
    const names = new Set(rows.map((r) => r.table_name));
    expect(names.has('routine_run_log')).toBe(true);
    expect(names.has('orchestrator_rows')).toBe(true);
    expect(names.has('routine_queue')).toBe(true);
    expect(names.has('sessions')).toBe(true);
  });

  test('scripted sink captures an inject and the canned reply parses real sentinels', () => {
    const reply = [
      '<<STATE',
      'lifecycle: development',
      'milestone: OEE',
      'phase: 2/2',
      'last_action: built harness',
      'next_action: round-trip a reply',
      'decisions: none',
      'deployed_live: no',
      'STATE>>',
      '<<NOTIFY level=info channel=all detail="harness smoke ok">>',
    ].join('\n');

    const sink = createScriptedSink({ replies: [reply] });

    // Drive the sink's seam the way runMacroCycle does: pull the reply, then
    // capture an inject. (Full runMacroCycle drive is OEE-05; here we prove the
    // seam plumbing + real sentinel parse.)
    return (async () => {
      const got = await sink.deps.getLatestAssistantReply('sess-1', h.userId);
      expect(got).toBe(reply);

      const parsed = sink.parseLastReply();
      expect(parsed?.state?.lifecycle).toBe('development');
      expect(parsed?.state?.milestone).toBe('OEE');
      expect(parsed?.notifies.length).toBe(1);
      expect(parsed?.notifies[0].detail).toBe('harness smoke ok');
      expect(parsed?.gate).toBeNull();

      const outcome = await sink.deps.inject({
        userId: h.userId,
        sessionId: 'sess-1',
        token: 'orch:sess-1:macro:dev:1',
        prompt: 'resume the dev macro',
      });
      expect(outcome.kind).toBe('dispatched');
      expect(sink.captured.length).toBe(1);
      expect(sink.captured[0].input.prompt).toBe('resume the dev macro');
    })();
  });

  test('run-log writes through to the REAL table when sql is supplied', async () => {
    const sink = createScriptedSink({ sql: h.sql });
    const stored = await sink.deps.appendRunLog({
      session_id: h.sessionId,
      command: 'smoke',
      decision_rationale: 'oee harness write-through',
      outcome: 'ok',
    });
    expect(sink.runLog.length).toBe(1);
    expect(stored.id).toBeTruthy();

    const rows = await h.sql<{ command: string }[]>`
      SELECT command FROM routine_run_log WHERE session_id = ${h.sessionId} AND command = 'smoke'
    `;
    expect(rows.length).toBe(1);
  });
});

// Always-on sanity so the file always reports to bun test (phase-08 convention).
describe('OEE harness — sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof hasE2eDb()).toBe('boolean');
    if (!hasE2eDb()) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — OEE schema/sink e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable LOCAL Postgres URL to run it.',
      );
    }
  });
});

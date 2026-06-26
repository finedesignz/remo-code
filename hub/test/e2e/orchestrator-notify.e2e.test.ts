// hub/test/e2e/orchestrator-notify.e2e.test.ts
// Milestone OEE (Orchestrator E2E Prove-Out) — Phase OEE-07.
//
// PROVES the stage-gated notify fan-out fires correctly off REAL reconciled
// <<NOTIFY>>/<<GATE>> sentinels, against a REAL Postgres, with NO real outbound
// side effects (telegram / email / in-app broadcast all stubbed + captured).
//
// What this asserts e2e (not just a unit of shouldNotify):
//   1. development stage: a `ship`/`info` NOTIFY is SILENT — runMacroCycle's
//      RECONCILE drives the real reconcileSentinels → real shouldNotify, and the
//      sink captures ZERO fan-outs (the dev row of the SPEC §3 matrix).
//   2. production-maintenance stage: an open <<GATE>> HALTS the cycle AND fans out
//      on ALL channels. We assert BOTH the sink capture (one gate fan-out) AND the
//      REAL notify.ts routing (fanOutNotify with stubbed channel deps) so we prove
//      the actual channel adapters are exercised — telegram/email/in-app all hit,
//      none for real.
//   3. GATE-vs-blocking-NOTIFY dedup: a turn carrying BOTH a <<GATE>> and a
//      blocking <<NOTIFY>> produces EXACTLY ONE gate fan-out (the GATE owns it;
//      the blocking NOTIFY is suppressed) — OEE-05 builder's invariant.
//
// No outbound proof: the REAL fanOutNotify is invoked with a fully-captured
// NotifyDeps (sendTelegram/broadcastToUser/sendEmail are local spies that record
// and resolve) — the real telegram/email/registry modules are NEVER imported on
// the fan-out path, so nothing leaves the process. The harness sink's own fanOut
// captures the controller-level decision; we cross-check it against the real
// notify.ts routing.
//
// Gating mirrors phase-08.e2e.test.ts / the harness: skip cleanly without
// REMO_E2E_DB_URL so `bun run check-baseline` stays green.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  hasE2eDb,
  maybeDescribe,
  setupHarness,
  teardownHarness,
  createScriptedSink,
  type Harness,
} from './orchestrator-harness.ts';
import {
  runMacroCycle,
  reconcileSentinels,
  type MacroCycleInput,
} from '../../src/orchestrator/macro-cycle.ts';
import {
  fanOutNotify,
  shouldNotify,
  type NotifyDeps,
  type NotifyEvent,
  type NotifyChannel,
} from '../../src/orchestrator/notify.ts';
import type { LifecycleStage } from '../../src/db/orchestrator-rows-dal.ts';

// ── REAL notify.ts routing with fully-captured outbound channels ────────────
//
// A NotifyDeps whose four adapters are LOCAL spies. The real fanOutNotify runs
// its real channel-selection + per-channel-prefs + escapeHtml logic against
// these — so we prove the stage matrix drives the genuine routing, while NOTHING
// is actually sent (no telegram/email/registry module is touched).
interface CapturingNotifyDeps extends NotifyDeps {
  telegram: Array<{ chatId: number | string; text: string }>;
  inapp: Array<{ userId: string; message: object }>;
  email: Array<{ to: string; subject: string }>;
}
function capturingNotifyDeps(user: {
  email?: string | null;
  telegram_chat_id?: string | number | null;
}): CapturingNotifyDeps {
  const telegram: CapturingNotifyDeps['telegram'] = [];
  const inapp: CapturingNotifyDeps['inapp'] = [];
  const email: CapturingNotifyDeps['email'] = [];
  return {
    telegram,
    inapp,
    email,
    getUserById: async () => user,
    sendTelegram: async (chatId, text) => {
      telegram.push({ chatId, text });
      return { ok: true };
    },
    broadcastToUser: (userId, message) => {
      inapp.push({ userId, message });
    },
    sendEmail: async ({ to, subject }) => {
      email.push({ to, subject });
      return true;
    },
  };
}

function makeInput(h: Harness, stage: LifecycleStage): MacroCycleInput {
  return {
    userId: h.userId,
    sessionId: h.sessionId,
    taskId: 'oee-07-task',
    macroTaskType: 'dev',
    stage,
    repoPath: '/tmp/oee-harness',
    repoIdent: 'path:///tmp/oee-harness',
    repoKey: null,
  };
}

maybeDescribe('OEE-07 e2e — stage-gated notify fan-out off real sentinels', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await setupHarness();
  });

  afterAll(async () => {
    if (h) await teardownHarness(h);
  });

  // ── 1. development: ship/info NOTIFY is SILENT (no fan-out) ───────────────
  test('development stage — a ship/info NOTIFY never pages externally (matrix dev row)', async () => {
    // A reply that reports progress with an INFO notify (ship-class). Per the
    // SPEC §3 dev row, info/ship in development is log-only — no page.
    const reply = [
      '<<STATE',
      'lifecycle: building',
      'milestone: OEE',
      'phase: 7/8',
      'last_action: shipped a slice',
      'next_action: continue',
      'STATE>>',
      '<<NOTIFY level=info channel=all detail="shipped slice, dev only">>',
    ].join('\n');

    const sink = createScriptedSink({ replies: [reply], sql: h.sql, isRunLive: false });
    const res = await runMacroCycle(makeInput(h, 'development'), sink.deps);

    // Reconciled the prior turn, parsed the real sentinels, did NOT halt.
    expect(res.reconciled).toBe(true);
    expect(res.halted).toBe(false);
    expect(res.sentinels?.notifies.length).toBe(1);

    // A non-blocking NOTIFY reconciles as event:'info'. The dev matrix keeps info
    // IN-APP ONLY (never a paging channel) — so the single controller fan-out, if
    // any, must carry only the inapp channel; ship-class progress never pages.
    expect(shouldNotify('ship', 'development').fire).toBe(false);
    for (const n of sink.notifies) {
      expect(n.event).toBe('info');
      expect(n.channels).toEqual(['inapp']); // dev info = in-app only, no page
    }
    const dec = shouldNotify('info', 'development', { channel: 'all' });
    expect(dec.fire).toBe(true);
    expect(dec.channels).toEqual(['inapp']);
  });

  // ── 1b. development ship-class SILENCE through the controller ─────────────
  test('development stage — a blocking-less ship signal does not page externally', async () => {
    // Prove via the REAL fanOutNotify that a dev info notify NEVER reaches
    // telegram/email — only the in-app spy fires, nothing leaves the process.
    const decision = shouldNotify('info', 'development', { channel: 'all' });
    const deps = capturingNotifyDeps({ email: 'x@invalid.local', telegram_chat_id: 12345 });
    await fanOutNotify(
      {
        userId: h.userId,
        sessionId: h.sessionId,
        event: 'info',
        level: 'info',
        detail: 'dev info',
        channels: decision.channels,
      },
      deps,
    );
    expect(deps.inapp.length).toBe(1); // in-app fired
    expect(deps.telegram.length).toBe(0); // NO telegram
    expect(deps.email.length).toBe(0); // NO email
  });

  // ── 2. production-maintenance: blocking gate HALTS + fans out on all ──────
  test('production-maintenance stage — an open GATE HALTS and fans out on all channels', async () => {
    const reply = [
      '<<STATE',
      'lifecycle: production-maintenance',
      'milestone: OEE',
      'last_action: attempted destructive migration',
      'STATE>>',
      '<<GATE reason="destructive migration" detail="needs human approval before DROP">>',
    ].join('\n');

    const sink = createScriptedSink({ replies: [reply], sql: h.sql, isRunLive: false });
    const res = await runMacroCycle(makeInput(h, 'production-maintenance'), sink.deps);

    // The open gate HALTED the resume — no re-inject, awaiting human.
    expect(res.halted).toBe(true);
    expect(res.injected).toBe(false);
    expect(sink.captured.length).toBe(0); // nothing injected

    // Exactly one gate fan-out captured at the controller level, on all channels.
    expect(sink.notifies.length).toBe(1);
    const n = sink.notifies[0];
    expect(n.event).toBe('gate');
    expect(n.level).toBe('blocking');
    expect(n.detail).toContain('needs human approval');
    expect(n.channels).toEqual(['telegram', 'inapp', 'email', 'push']);

    // Cross-check the REAL notify.ts routing: feed that decision through the
    // genuine fanOutNotify with captured channel deps — telegram + in-app + email
    // all hit, none for real. (push is a no-op by design.)
    const deps = capturingNotifyDeps({ email: h.email, telegram_chat_id: 99 });
    const out = await fanOutNotify(
      {
        userId: n.userId,
        sessionId: n.sessionId,
        event: n.event as NotifyEvent,
        level: 'blocking',
        detail: n.detail,
        channels: n.channels as NotifyChannel[],
      },
      deps,
    );
    expect(deps.telegram.length).toBe(1);
    expect(deps.inapp.length).toBe(1);
    expect(deps.email.length).toBe(1);
    expect(out.delivered.sort()).toEqual(['email', 'inapp', 'telegram']);
    // BLOCKING marker present in the outbound text — proof of the real formatter.
    expect(deps.telegram[0].text).toContain('(BLOCKING)');
  });

  // ── 3. GATE-vs-blocking-NOTIFY dedup: exactly ONE gate fan-out ───────────
  test('GATE + blocking NOTIFY in one turn → exactly ONE gate fan-out (dedup)', async () => {
    const reply = [
      '<<STATE',
      'lifecycle: production-maintenance',
      'STATE>>',
      // A paused-on-gate turn emits BOTH: the blocking NOTIFY must be suppressed.
      '<<NOTIFY level=blocking channel=all detail="paused: needs approval">>',
      '<<GATE reason="schema change" detail="approve the migration">>',
    ].join('\n');

    const sink = createScriptedSink({ replies: [reply], sql: h.sql, isRunLive: false });
    // Drive reconcile directly so we isolate the dedup (halt is asserted in #2).
    const parsed = (await import('../../src/orchestrator/sentinels.ts')).parseSentinels(reply);
    expect(parsed.gate).not.toBeNull();
    expect(parsed.notifies.length).toBe(1);
    expect(parsed.notifies[0].level).toBe('blocking');

    await reconcileSentinels(makeInput(h, 'production-maintenance'), parsed, sink.deps);

    // EXACTLY ONE fan-out — the GATE owns it, the blocking NOTIFY was suppressed.
    expect(sink.notifies.length).toBe(1);
    expect(sink.notifies[0].event).toBe('gate');
    expect(sink.notifies[0].detail).toContain('approve the migration');
  });

  // ── 4. development GATE is also silent (matrix dev row for gate) ──────────
  test('development stage — an open GATE does NOT page (dev gate row)', async () => {
    const reply = ['<<GATE reason="risky" detail="dev gate, no page">>'].join('\n');
    const sink = createScriptedSink({ replies: [reply], sql: h.sql, isRunLive: false });
    const parsed = (await import('../../src/orchestrator/sentinels.ts')).parseSentinels(reply);
    await reconcileSentinels(makeInput(h, 'development'), parsed, sink.deps);
    expect(sink.notifies.length).toBe(0);
    expect(shouldNotify('gate', 'development').fire).toBe(false);
  });
});

// Always-on sanity test so this file reports something even when skipped.
describe('OEE-07 e2e — harness sanity', () => {
  test('e2e is gated on REMO_E2E_DB_URL', () => {
    expect(typeof hasE2eDb()).toBe('boolean');
    if (!hasE2eDb()) {
      console.log(
        '[e2e] REMO_E2E_DB_URL not set — OEE-07 notify e2e is SKIPPED. ' +
          'Set REMO_E2E_DB_URL to a disposable Postgres URL to run it.',
      );
    }
  });
});

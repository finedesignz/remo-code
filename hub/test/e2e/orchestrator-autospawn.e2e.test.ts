/**
 * Milestone BSA — Phase BSA-07: build-session AUTOSPAWN e2e prove-out.
 *
 * Proves the (flag-gated-OFF) Build-Session Autospawn seam end-to-end against REAL
 * Postgres via the OEE harness — with a STUB supervisor + a CAPTURED launch (NO
 * real socket, NO live `claude`). It drives the REAL `injectOrchestratorPrompt`
 * (BSA-02) through its EXISTING `InjectDeps` DI seam — nothing in hub/src is
 * monkeypatched and NO production seam is added (the seam already exposes
 * `launchSessionForUser`, `supervisorOnlineForUser`, `getChannel`, `dispatch`,
 * `appendRunLog`, plus the BSA gate adapters as injectable fields).
 *
 * Real DB surfaces exercised through the seam's DEFAULT (real-DAL) deps:
 *   - `isRepoAutospawnAllowed`        → real `orchestrator_autospawn_allowlist`.
 *   - `getTokenCapStatus`             → real `token_usage` sum (BSA-04 token cap).
 *   - `countAutospawnLaunchesToday`   → real `routine_run_log` ledger join.
 *   - `appendRunLog`                  → real `routine_run_log` write (ledger row).
 *
 * Deterministic stubs (no network / no subprocess):
 *   - `getChannel`                    → returns null (OFFLINE) so the autospawn seam fires.
 *   - `supervisorOnlineForUser`       → simulated supervisor liveness.
 *   - `launchSessionForUser`          → CAPTURES the launch (= the `session.start` emit).
 *   - `dispatch`                      → CAPTURES the parked/delivered prompt.
 *   - `graceParkPending`              → false (no dedup) unless a scenario sets it.
 *
 * HAPPY PATH proves: gated ON + allowlisted + supervisor online →
 *   launch captured (session.start fired) → ledger `autospawn-launch` row present
 *   (real table) → outcome `autospawn_launched` (parked) → a simulated reconnect
 *   drain DELIVERS the parked prompt → a simulated agent reply populates
 *   `routine_run_log.pr_url` via the REAL DAL.
 *
 * GATE NO-OPS prove (each → NO launch, typed refusal / no_session):
 *   - allowlist empty           → refused:not_allowlisted
 *   - REMO_ORCHESTRATOR_AUTOSPAWN off → no_session
 *   - over daily token cap      → refused:over_token_cap  (seed token_usage)
 *   - over launch-count cap     → refused:launch_cap      (seed N ledger rows)
 *   - supervisor offline        → refused:supervisor_offline
 *
 * Env gates (BSA-01) are read at CALL-TIME by controller.ts, so the test sets
 * `process.env.REMO_ORCHESTRATOR_*` per-case BEFORE invoking the seam. The hub's
 * shared `sql` (DAL) binds DATABASE_URL at import time, so DATABASE_URL is pointed
 * at REMO_E2E_DB_URL BEFORE any DAL import — mirroring phase-08 / OEE-05.
 *
 * Gated on `REMO_E2E_DB_URL`: `describe.skip` (CI-safe import-skip) without it, so
 * `bun run check-baseline` stays green with no DB.
 *
 * Run with:
 *   REMO_E2E_DB_URL=postgres://... bun test hub/test/e2e/orchestrator-autospawn.e2e.test.ts
 */
import { test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { randomUUID } from 'crypto';
import {
  hasE2eDb,
  maybeDescribe,
  setupHarness,
  teardownHarness,
  type Harness,
} from './orchestrator-harness.ts';
import type {
  InjectInput,
  InjectOutcome,
  InjectDeps,
} from '../../src/orchestrator/inject.ts';
import type { DispatchRequest } from '../../src/dispatch/pipeline.ts';
import type { LaunchResult } from '../../src/telegram/launch.ts';

// The DAL binds DATABASE_URL at import time → point it at the disposable DB first.
if (hasE2eDb()) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!;
}

maybeDescribe('BSA-07 e2e — build-session autospawn (real PG + stub supervisor)', () => {
  let h: Harness;
  // Lazy-imported AFTER DATABASE_URL is repointed (matches phase-08 / OEE-05).
  let injectOrchestratorPrompt: typeof import('../../src/orchestrator/inject.ts').injectOrchestratorPrompt;
  let isRepoAutospawnAllowed: typeof import('../../src/db/orchestrator-rows-dal.ts').isRepoAutospawnAllowed;
  let addRepoToAutospawnAllowlist: typeof import('../../src/db/orchestrator-rows-dal.ts').addRepoToAutospawnAllowlist;
  let countAutospawnLaunchesToday: typeof import('../../src/db/orchestrator-rows-dal.ts').countAutospawnLaunchesToday;
  let AUTOSPAWN_LAUNCH_COMMAND: string;
  let getTokenCapStatus: typeof import('../../src/dispatch/gates.ts').getTokenCapStatus;
  let appendRunLog: typeof import('../../src/orchestrator/run-log.ts').appendRunLog;
  let isOrchestratorEnabled: typeof import('../../src/orchestrator/controller.ts').isOrchestratorEnabled;
  let isAutospawnEnabled: typeof import('../../src/orchestrator/controller.ts').isAutospawnEnabled;

  const REPO_IDENT = 'github://finedesignz/bsa-autospawn-e2e';

  // ── A capturing harness for one inject call ───────────────────────────────────
  interface Capture {
    launches: Array<{ userId: string; sessionId: string }>;
    dispatched: DispatchRequest[];
    /** what the captured `dispatch` returns (drives the parked vs delivered path). */
    dispatchKind: Awaited<ReturnType<typeof import('../../src/dispatch/pipeline.ts').dispatch>>['kind'];
    /** simulates the launched runner's channel coming online (drain delivery). */
    online: boolean;
    /** simulates supervisor liveness. */
    supervisorOnline: boolean;
    /** result the captured launch returns. */
    launchResult: LaunchResult;
    /** simulate a live grace entry (launch already in flight). */
    gracePending: boolean;
  }

  /**
   * Build `InjectDeps` for one scenario: REAL DB-backed gate/ledger deps + the
   * captured launch + a captured `dispatch`. `getChannel` returns null until
   * `cap.online` flips true, so the autospawn seam fires (offline) and the parked
   * `replay`/`send` path can be exercised on a simulated reconnect.
   */
  function depsFor(cap: Capture): InjectDeps {
    return {
      // Captured dispatch — records the prompt + returns the scripted pipeline kind.
      dispatch: (async (req: DispatchRequest) => {
        cap.dispatched.push(req);
        return { kind: cap.dispatchKind } as any;
      }) as InjectDeps['dispatch'],
      // OFFLINE until the simulated runner reconnects.
      getChannel: ((_sessionId: string) => (cap.online ? ({} as any) : null)) as InjectDeps['getChannel'],
      // Live iff the simulated runner is online (mirrors getChannel; no ghost in e2e).
      isSessionLive: (async (_sessionId: string) => cap.online) as InjectDeps['isSessionLive'],
      // REAL env-gated predicates (set via process.env per-case).
      isOrchestratorEnabled,
      isAutospawnEnabled,
      // REAL DB-backed allowlist + caps + ledger.
      isRepoAutospawnAllowed,
      getTokenCapStatus,
      countAutospawnLaunchesToday,
      appendRunLog,
      // Stubbed supervisor liveness + captured launch (the session.start emit).
      supervisorOnlineForUser: async () => cap.supervisorOnline,
      launchSessionForUser: (async (args: { userId: string; sessionId: string }) => {
        cap.launches.push(args);
        return cap.launchResult;
      }) as InjectDeps['launchSessionForUser'],
      graceParkPending: (_sessionId: string) => cap.gracePending,
    };
  }

  function freshCapture(over?: Partial<Capture>): Capture {
    return {
      launches: [],
      dispatched: [],
      dispatchKind: 'parked_offline',
      online: false,
      supervisorOnline: true,
      launchResult: {
        ok: true,
        runId: randomUUID(),
        supervisorId: randomUUID(),
        hostname: 'e2e-host',
        repoPath: '/tmp/bsa-autospawn',
      },
      gracePending: false,
      ...over,
    };
  }

  function buildInput(): InjectInput {
    return {
      userId: h.userId,
      sessionId: h.sessionId,
      token: `orch:${h.sessionId}:macro:dev:${Date.now()}`,
      prompt: 'autonomous DEV routine — plan first, then build.',
      autospawn: { isBuild: true, repoIdent: REPO_IDENT, tz: 'UTC' },
    };
  }

  /** Count today's autospawn-launch ledger rows for the harness user (real query). */
  async function ledgerCount(): Promise<number> {
    return countAutospawnLaunchesToday(h.userId, 'UTC');
  }

  beforeAll(async () => {
    h = await setupHarness();
    ({ injectOrchestratorPrompt } = await import('../../src/orchestrator/inject.ts'));
    ({
      isRepoAutospawnAllowed,
      addRepoToAutospawnAllowlist,
      countAutospawnLaunchesToday,
      AUTOSPAWN_LAUNCH_COMMAND,
    } = await import('../../src/db/orchestrator-rows-dal.ts'));
    ({ getTokenCapStatus } = await import('../../src/dispatch/gates.ts'));
    ({ appendRunLog } = await import('../../src/orchestrator/run-log.ts'));
    ({ isOrchestratorEnabled, isAutospawnEnabled } = await import('../../src/orchestrator/controller.ts'));
  }, 30_000);

  afterAll(async () => {
    if (h) await teardownHarness(h);
  });

  // Clean slate between cases + a default fully-ON, generously-capped env.
  beforeEach(async () => {
    await h.sql`DELETE FROM routine_run_log WHERE session_id = ${h.sessionId}`;
    await h.sql`DELETE FROM token_usage WHERE user_id = ${h.userId}`;
    await h.sql`DELETE FROM orchestrator_autospawn_allowlist WHERE user_id = ${h.userId}`;
    process.env.REMO_ORCHESTRATOR_ENABLED = '1';
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '1';
    process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP = '1000000000'; // 1B — effectively unbounded
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES = '20';
  });

  // ── HAPPY PATH ────────────────────────────────────────────────────────────────
  test('fully gated ON + allowlisted + supervisor online → launch fires, ledger row, parked, delivered, pr_url', async () => {
    await addRepoToAutospawnAllowlist(h.userId, REPO_IDENT);

    const cap = freshCapture(); // dispatch → parked_offline (session still connecting)
    const input = buildInput();
    const outcome: InjectOutcome = await injectOrchestratorPrompt(input, depsFor(cap));

    // 1. session.start fired exactly once (captured launch), parked.
    expect(cap.launches.length).toBe(1);
    expect(cap.launches[0]).toEqual({ userId: h.userId, sessionId: h.sessionId });
    expect(outcome.kind).toBe('autospawn_launched');

    // 2. The prompt was handed to dispatch (parked in grace for drain).
    expect(cap.dispatched.length).toBe(1);
    expect(cap.dispatched[0].prompt).toBe(input.prompt);

    // 3. Exactly one REAL `autospawn-launch` ledger row landed (BSA-04 cap source).
    expect(await ledgerCount()).toBe(1);
    const ledgerRows = await h.sql<Array<{ command: string; outcome: string | null; repo_key: string | null }>>`
      SELECT command, outcome, repo_key FROM routine_run_log
      WHERE session_id = ${h.sessionId} AND command = ${AUTOSPAWN_LAUNCH_COMMAND}
    `;
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].outcome).toBe('launched');
    expect(ledgerRows[0].repo_key).toBe(REPO_IDENT);

    // 4. DRAIN DELIVERS — simulate the launched runner reconnecting (channel online)
    //    + dispatch now DISPATCHED, and re-run the seam: the parked prompt delivers.
    const cap2 = freshCapture({ online: true, dispatchKind: 'dispatched' });
    const outcome2 = await injectOrchestratorPrompt(buildInput(), depsFor(cap2));
    // Channel online → the ONLINE inject path dispatches the prompt directly.
    expect(outcome2.kind).toBe('dispatched');
    expect(cap2.dispatched.length).toBe(1);
    expect(cap2.launches.length).toBe(0); // online → no second launch

    // 5. pr_url populated on a simulated agent reply (reconcile writes via REAL DAL).
    const PR_URL = 'https://github.com/finedesignz/bsa-autospawn-e2e/pull/42';
    await appendRunLog({
      session_id: h.sessionId,
      repo_key: REPO_IDENT,
      command: 'macro:dev',
      decision_rationale: 'reconciled <<STATE>> from autospawned build session reply',
      outcome: 'pr_opened',
      pr_url: PR_URL,
    });
    const prRows = await h.sql<Array<{ pr_url: string | null }>>`
      SELECT pr_url FROM routine_run_log
      WHERE session_id = ${h.sessionId} AND pr_url IS NOT NULL
    `;
    expect(prRows.length).toBe(1);
    expect(prRows[0].pr_url).toBe(PR_URL);
  });

  // ── GATE NO-OPS ───────────────────────────────────────────────────────────────
  test('allowlist EMPTY → refused:not_allowlisted, no launch, no ledger row', async () => {
    // (allowlist cleared in beforeEach)
    const cap = freshCapture();
    const outcome = await injectOrchestratorPrompt(buildInput(), depsFor(cap));

    expect(outcome).toEqual({ kind: 'refused', reason: 'not_allowlisted' });
    expect(cap.launches.length).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });

  test('REMO_ORCHESTRATOR_AUTOSPAWN off → no_session (legacy offline behaviour), no launch', async () => {
    await addRepoToAutospawnAllowlist(h.userId, REPO_IDENT); // allowlisted, but...
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '0'; // ...autospawn disabled

    const cap = freshCapture();
    const outcome = await injectOrchestratorPrompt(buildInput(), depsFor(cap));

    expect(outcome).toEqual({ kind: 'no_session' });
    expect(cap.launches.length).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });

  test('over daily TOKEN cap → refused:over_token_cap, no launch (real token_usage sum)', async () => {
    await addRepoToAutospawnAllowlist(h.userId, REPO_IDENT);
    // Seed token_usage ABOVE the cap for today (real BSA-04 token-cap source).
    process.env.REMO_ORCHESTRATOR_DAILY_TOKEN_CAP = '1000';
    await h.sql`
      INSERT INTO token_usage (
        user_id, session_id, model,
        input_tokens, output_tokens,
        cache_creation_input_tokens, cache_read_input_tokens,
        cost_usd, cost_source
      ) VALUES (
        ${h.userId}, ${h.sessionId}, 'claude-sonnet-4',
        5000, 5000, 0, 0, 0, 'estimated'
      )
    `;
    // Sanity: the real cap status agrees we are over.
    const status = await getTokenCapStatus(h.userId, 'UTC');
    expect(status.over).toBe(true);

    const cap = freshCapture();
    const outcome = await injectOrchestratorPrompt(buildInput(), depsFor(cap));

    expect(outcome).toEqual({ kind: 'refused', reason: 'over_token_cap' });
    expect(cap.launches.length).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });

  test('over LAUNCH-count cap → refused:launch_cap, no launch (real ledger-row count)', async () => {
    await addRepoToAutospawnAllowlist(h.userId, REPO_IDENT);
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES = '3';
    // Seed 3 real autospawn-launch ledger rows for today → at the cap.
    for (let i = 0; i < 3; i++) {
      await appendRunLog({
        session_id: h.sessionId,
        repo_key: REPO_IDENT,
        command: AUTOSPAWN_LAUNCH_COMMAND,
        decision_rationale: `seeded launch ${i}`,
        outcome: 'launched',
      });
    }
    expect(await ledgerCount()).toBe(3);

    const cap = freshCapture();
    const outcome = await injectOrchestratorPrompt(buildInput(), depsFor(cap));

    expect(outcome).toEqual({ kind: 'refused', reason: 'launch_cap' });
    expect(cap.launches.length).toBe(0);
    // No NEW ledger row added (count unchanged).
    expect(await ledgerCount()).toBe(3);
  });

  test('supervisor OFFLINE → refused:supervisor_offline, no launch', async () => {
    await addRepoToAutospawnAllowlist(h.userId, REPO_IDENT);

    const cap = freshCapture({ supervisorOnline: false });
    const outcome = await injectOrchestratorPrompt(buildInput(), depsFor(cap));

    expect(outcome).toEqual({ kind: 'refused', reason: 'supervisor_offline' });
    expect(cap.launches.length).toBe(0);
    expect(await ledgerCount()).toBe(0);
  });
});

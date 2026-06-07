/**
 * Phase 29 (auto-dev-orchestrator) — off-hours merge-to-main command.
 *
 * `runMergeToMain` is built on INJECTABLE deps (clock + run-log + approvals DAL +
 * inject + notify + appendRunLog), so these tests pass fakes directly — NO real
 * merges, DB, network, or clock. (No mock.module ⇒ no Bun mock-pollution risk.)
 *
 * Covers:
 *   1. WINDOW GATE — out-of-window ⇒ skipped run-log row, nothing injected/merged.
 *   2. WINDOW GATE — in-window ⇒ proceeds (selection runs).
 *   3. SELECTION   — (decision D8/D5) dev-command PRs auto-merge on reviewer PASS
 *                    (NO approval needed); ship/complete-milestone/tag PRs need
 *                    PASS + an unconsumed approval; FAIL / uncertain are HELD +
 *                    surfaced (notifyChatSurface).
 *   4. IDEMPOTENCY — a consumed powerful-command approval is marked CONSUMED; a
 *                    re-fire (no unconsumed marker) re-merges nothing.
 *   5. RUN LOG     — exactly one merge-to-main run-log row per call, with merged +
 *                    held PRs in the rationale.
 *   6. FLAG-OFF    — registerCycleRunnerIfEnabled() returns false with the flag OFF
 *                    (the only path that would route the merge command stays dormant).
 *   7. injectable CLOCK — drives the window test (no wall-clock dependency).
 */
import { describe, test, expect } from 'bun:test';
import {
  runMergeToMain,
  prContentSha,
  MERGE_COMMAND,
  isMergeCommand,
  composeMergePrompt,
  type MergeDeps,
  type MergeRunContext,
} from '../src/orchestrator/merge-command.ts';

// ── Fake-deps factory ────────────────────────────────────────────────────────
function makeDeps(opts: {
  now: Date;
  log: any[];
  approvals: { id: string; content_sha: string }[];
  injectKind?: string;
}) {
  const calls = {
    runLog: [] as any[],
    injected: [] as any[],
    notified: [] as any[],
    consumed: [] as string[],
  };
  const approvals = opts.approvals.map((a) => ({
    id: a.id,
    session_id: 'sess-1',
    command: 'ship',
    content_sha: a.content_sha,
    approved_at: '',
    consumed_at: null as string | null,
    created_at: '',
  }));
  const deps: MergeDeps = {
    now: () => opts.now,
    recentRunLog: async () => opts.log as any,
    listUnconsumedApprovals: async () =>
      approvals.filter((a) => a.consumed_at == null) as any,
    markApprovalConsumed: async (id: string) => {
      calls.consumed.push(id);
      const a = approvals.find((x) => x.id === id);
      if (a) a.consumed_at = 'now';
      return (a as any) ?? null;
    },
    injectOrchestratorPrompt: async (input: any) => {
      calls.injected.push(input);
      return { kind: (opts.injectKind ?? 'dispatched') as any };
    },
    notifyChatSurface: async (input: any) => {
      calls.notified.push(input);
    },
    appendRunLog: async (entry: any) => {
      calls.runLog.push(entry);
      return entry;
    },
  };
  return { deps, calls, approvals };
}

function logRow(pr: string, verdict: string, command = 'execute') {
  return {
    session_id: 'sess-1',
    command,
    pr_url: pr,
    reviewer_verdict: verdict,
    repo_key: 'finedesignz/remo-code',
  };
}

// 01:00–05:00 off-hours window.
const WINDOW = { from: '01:00', to: '05:00' };
function rule(active_window = WINDOW) {
  return { interval: 1, unit: 'days', start_at: '2020-01-01T00:00:00Z', active_window } as any;
}
const baseCtx: Omit<MergeRunContext, 'scheduleRule'> = {
  sessionId: 'sess-1',
  userId: 'user-1',
  repoKey: 'finedesignz/remo-code',
  tz: 'UTC',
};

describe('runMergeToMain — window gate', () => {
  test('out-of-window ⇒ skipped run-log row, nothing injected or merged', async () => {
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T12:00:00Z'), // noon — outside 01:00–05:00
      log: [logRow('https://gh/pr/1', 'PASS')],
      approvals: [{ id: 'a1', content_sha: prContentSha('https://gh/pr/1') }],
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('skipped_out_of_window');
    expect(calls.injected.length).toBe(0);
    expect(calls.consumed.length).toBe(0);
    expect(calls.runLog.length).toBe(1);
    expect(calls.runLog[0].outcome).toBe('skipped_out_of_window');
    expect(calls.runLog[0].command).toBe(MERGE_COMMAND);
  });

  test('in-window ⇒ proceeds (selection runs, injects merge turn)', async () => {
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T03:00:00Z'), // 03:00 — inside 01:00–05:00
      log: [logRow('https://gh/pr/1', 'PASS')],
      approvals: [{ id: 'a1', content_sha: prContentSha('https://gh/pr/1') }],
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('dispatched');
    expect(calls.injected.length).toBe(1);
  });
});

describe('runMergeToMain — selection (decision D8/D5)', () => {
  test('dev PASS PR auto-merges with NO approval marker', async () => {
    const devPass = 'https://gh/pr/dev-pass';
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [logRow(devPass, 'PASS', 'execute')], // dev command, no approval row
      approvals: [],
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('dispatched');
    if (out.kind === 'dispatched') {
      expect(out.merged).toEqual([devPass]);
      expect(out.held).toEqual([]);
    }
    expect(calls.consumed.length).toBe(0); // dev auto-merge consumes no marker
    expect(calls.injected.length).toBe(1);
    expect(calls.injected[0].prompt).toContain(devPass);
    expect(calls.notified.length).toBe(0); // nothing held
  });

  test('ship PASS PR WITHOUT approval ⇒ HELD; ship PASS WITH approval ⇒ merged + consumed', async () => {
    const shipNoApproval = 'https://gh/pr/ship-noapproval';
    const shipApproved = 'https://gh/pr/ship-approved';
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [
        logRow(shipApproved, 'PASS', 'ship'),
        logRow(shipNoApproval, 'PASS', 'ship'),
      ],
      approvals: [{ id: 'a1', content_sha: prContentSha(shipApproved) }],
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('dispatched');
    if (out.kind === 'dispatched') {
      expect(out.merged).toEqual([shipApproved]);
      expect(out.held).toEqual([shipNoApproval]);
    }
    expect(calls.consumed).toEqual(['a1']); // only the approved powerful-cmd marker
    expect(calls.injected[0].prompt).toContain(shipApproved);
    expect(calls.injected[0].prompt).not.toContain(shipNoApproval);
    expect(calls.notified.length).toBe(1);
    expect(calls.notified[0].summary).toContain(shipNoApproval);
  });

  test('merges PASS dev + PASS approved ship; holds FAIL / uncertain / unapproved ship', async () => {
    const devPass = 'https://gh/pr/dev-pass';
    const shipApproved = 'https://gh/pr/ship-approved';
    const milestoneNoApproval = 'https://gh/pr/milestone-noapproval';
    const failDev = 'https://gh/pr/fail';
    const uncertain = 'https://gh/pr/uncertain';
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [
        logRow(devPass, 'PASS', 'execute'),
        logRow(shipApproved, 'PASS', 'ship'),
        logRow(milestoneNoApproval, 'PASS', 'complete-milestone'),
        logRow(failDev, 'FAIL', 'execute'),
        logRow(uncertain, 'UNCERTAIN', 'execute'),
      ],
      approvals: [
        { id: 'a1', content_sha: prContentSha(shipApproved) },
        { id: 'a3', content_sha: prContentSha(failDev) }, // approved but FAIL ⇒ still held
      ],
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('dispatched');
    if (out.kind === 'dispatched') {
      expect(out.merged.sort()).toEqual([devPass, shipApproved].sort());
      expect(out.held.sort()).toEqual([failDev, milestoneNoApproval, uncertain].sort());
    }
    // only the PASS+approved powerful-cmd marker consumed
    expect(calls.consumed).toEqual(['a1']);
    expect(calls.injected.length).toBe(1);
    expect(calls.injected[0].prompt).toContain(devPass);
    expect(calls.injected[0].prompt).toContain(shipApproved);
    expect(calls.injected[0].prompt).not.toContain(milestoneNoApproval);
    expect(calls.injected[0].prompt).not.toContain(failDev);
    // held surfaced once
    expect(calls.notified.length).toBe(1);
    expect(calls.notified[0].summary).toContain(milestoneNoApproval);
  });

  test('no PASS+approved candidates, only holds ⇒ held_only, no inject', async () => {
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [logRow('https://gh/pr/x', 'FAIL')],
      approvals: [],
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('held_only');
    expect(calls.injected.length).toBe(0);
    expect(calls.notified.length).toBe(1);
    expect(calls.runLog[0].outcome).toBe('held_only');
  });

  test('empty run log ⇒ no_candidates, nothing injected/notified', async () => {
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [],
      approvals: [],
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('no_candidates');
    expect(calls.injected.length).toBe(0);
    expect(calls.notified.length).toBe(0);
    expect(calls.runLog[0].outcome).toBe('no_candidates');
  });
});

describe('runMergeToMain — idempotency (consumed marker prevents re-merge)', () => {
  test('re-fired window with the marker already consumed merges nothing (powerful cmd)', async () => {
    const pr = 'https://gh/pr/1';
    const shared = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [logRow(pr, 'PASS', 'ship')], // powerful cmd ⇒ approval-gated, idempotent
      approvals: [{ id: 'a1', content_sha: prContentSha(pr) }],
    });
    // first window: merges + consumes a1
    const first = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, shared.deps);
    expect(first.kind).toBe('dispatched');
    expect(shared.calls.consumed).toEqual(['a1']);
    // second window (same deps — a1 now consumed): no unconsumed marker ⇒ held only
    shared.calls.injected.length = 0;
    const second = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, shared.deps);
    expect(second.kind).toBe('held_only');
    expect(shared.calls.injected.length).toBe(0); // no second merge dispatch
  });
});

describe('runMergeToMain — run-log row', () => {
  test('writes exactly one merge-to-main row with merged + held in rationale', async () => {
    const pr = 'https://gh/pr/1';
    const held = 'https://gh/pr/2';
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [logRow(pr, 'PASS'), logRow(held, 'FAIL')],
      approvals: [{ id: 'a1', content_sha: prContentSha(pr) }],
    });
    await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    const rows = calls.runLog.filter((r) => r.command === MERGE_COMMAND);
    expect(rows.length).toBe(1);
    expect(rows[0].outcome).toBe('merge_dispatched');
    expect(rows[0].decision_rationale).toContain(pr);
    expect(rows[0].decision_rationale).toContain(held);
  });

  test('refused inject (cost cap) ⇒ refused outcome row, no merge claimed', async () => {
    const pr = 'https://gh/pr/1';
    const { deps, calls } = makeDeps({
      now: new Date('2026-06-06T02:00:00Z'),
      log: [logRow(pr, 'PASS')],
      approvals: [{ id: 'a1', content_sha: prContentSha(pr) }],
      injectKind: 'refused_cost_cap',
    });
    const out = await runMergeToMain({ ...baseCtx, scheduleRule: rule() }, deps);
    expect(out.kind).toBe('refused');
    expect(calls.runLog[0].outcome).toBe('refused_refused_cost_cap');
  });
});

describe('helpers + flag-off dormancy', () => {
  test('isMergeCommand recognises only merge-to-main', () => {
    expect(isMergeCommand('merge-to-main')).toBe(true);
    expect(isMergeCommand('ship')).toBe(false);
    expect(isMergeCommand('execute')).toBe(false);
  });

  test('composeMergePrompt lists exactly the given PRs + the ONLY-path guard', () => {
    const p = composeMergePrompt(['https://gh/pr/1', 'https://gh/pr/2'], 'finedesignz/remo-code');
    expect(p).toContain('https://gh/pr/1');
    expect(p).toContain('https://gh/pr/2');
    expect(p).toContain('ONLY sanctioned merge-to-main');
    expect(p).toContain('--squash');
  });

  test('flag OFF ⇒ registerCycleRunnerIfEnabled is false (merge path dormant)', async () => {
    const prev = process.env.REMO_ORCHESTRATOR_ENABLED;
    process.env.REMO_ORCHESTRATOR_ENABLED = '0';
    const { registerCycleRunnerIfEnabled, isOrchestratorEnabled } = await import(
      '../src/orchestrator/controller.ts?p29flagoff'
    );
    expect(isOrchestratorEnabled()).toBe(false);
    expect(registerCycleRunnerIfEnabled()).toBe(false);
    if (prev === undefined) delete process.env.REMO_ORCHESTRATOR_ENABLED;
    else process.env.REMO_ORCHESTRATOR_ENABLED = prev;
  });
});

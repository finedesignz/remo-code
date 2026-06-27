// hub/test/orchestrator-cap-alert.test.ts
// Phase OBSRV-05: Cap-Approach Alerting — unit tests.
//
// Scenarios:
//   1. Below threshold → no alert fired
//   2. Token threshold crossed → exactly one alert, detail mentions token cap
//   3. Cost threshold crossed → exactly one alert, detail mentions cost cap
//   4. Second cycle same day still over threshold → throttled (no duplicate alert)

import { describe, it, expect, afterEach, mock } from 'bun:test';
import {
  evaluateCapAlert,
  _resetCapAlertStateForTests,
  type CapAlertDeps,
} from '../src/observability/cap-alert.ts';
import type { NotifyChannel } from '../src/orchestrator/notify.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeps(): { calls: Array<{ detail: string; channels: NotifyChannel[] }>; deps: CapAlertDeps } {
  const calls: Array<{ detail: string; channels: NotifyChannel[] }> = [];
  const deps: CapAlertDeps = {
    fanOut: async (input) => {
      calls.push({ detail: input.detail, channels: input.channels });
      return { delivered: input.channels };
    },
  };
  return { calls, deps };
}

const USER = 'user-alert-test';
const SESSION = 'sess-alert-test';

afterEach(() => {
  _resetCapAlertStateForTests();
  // Reset env between tests
  delete process.env.REMO_ORCHESTRATOR_CAP_ALERT_PCT;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluateCapAlert', () => {
  it('fires no alert when both caps are below threshold', async () => {
    const { calls, deps } = makeDeps();
    // 50% usage, 80% threshold → no alert
    await evaluateCapAlert(
      {
        userId: USER,
        sessionId: SESSION,
        tokenStatus: { tokens: 25_000_000, cap: 50_000_000 },
        costStatus: { spent: 5, cap: 10 },
      },
      deps,
    );
    expect(calls).toHaveLength(0);
  });

  it('fires exactly one alert when token threshold is crossed', async () => {
    const { calls, deps } = makeDeps();
    // 85% of 50M tokens, threshold 80%
    await evaluateCapAlert(
      {
        userId: USER,
        sessionId: SESSION,
        tokenStatus: { tokens: 42_500_000, cap: 50_000_000 },
        costStatus: { spent: 0, cap: 0 }, // cap disabled (cap=0 → skip)
      },
      deps,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].detail).toContain('token');
    expect(calls[0].channels).toContain('inapp');
    expect(calls[0].channels).toContain('telegram');
  });

  it('fires exactly one alert when cost threshold is crossed', async () => {
    const { calls, deps } = makeDeps();
    // $9 of $10 cap = 90% → over 80% threshold
    await evaluateCapAlert(
      {
        userId: USER,
        sessionId: SESSION,
        tokenStatus: { tokens: 0, cap: 0 }, // token cap disabled
        costStatus: { spent: 9, cap: 10 },
      },
      deps,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].detail).toContain('cost');
  });

  it('throttles: second cycle same day still over threshold fires no duplicate', async () => {
    const { calls, deps } = makeDeps();
    const params = {
      userId: USER,
      sessionId: SESSION,
      tokenStatus: { tokens: 42_500_000, cap: 50_000_000 },
      costStatus: { spent: 0, cap: 0 },
    };
    // First cycle → alert fires
    await evaluateCapAlert(params, deps);
    expect(calls).toHaveLength(1);

    // Second cycle same day → throttled
    await evaluateCapAlert(params, deps);
    expect(calls).toHaveLength(1);
  });

  it('respects REMO_ORCHESTRATOR_CAP_ALERT_PCT env override', async () => {
    process.env.REMO_ORCHESTRATOR_CAP_ALERT_PCT = '95';
    const { calls, deps } = makeDeps();
    // 85% usage → below 95% threshold → no alert
    await evaluateCapAlert(
      {
        userId: USER,
        sessionId: SESSION,
        tokenStatus: { tokens: 42_500_000, cap: 50_000_000 },
        costStatus: { spent: 0, cap: 0 },
      },
      deps,
    );
    expect(calls).toHaveLength(0);
  });

  it('fires two alerts when both token and cost caps are crossed in same cycle', async () => {
    const { calls, deps } = makeDeps();
    await evaluateCapAlert(
      {
        userId: USER,
        sessionId: SESSION,
        tokenStatus: { tokens: 42_500_000, cap: 50_000_000 }, // 85%
        costStatus: { spent: 9, cap: 10 }, // 90%
      },
      deps,
    );
    expect(calls).toHaveLength(2);
    const details = calls.map((c) => c.detail);
    expect(details.some((d) => d.includes('token'))).toBe(true);
    expect(details.some((d) => d.includes('cost'))).toBe(true);
  });

  it('is fail-open: a throwing fanOut does not propagate', async () => {
    const deps: CapAlertDeps = {
      fanOut: async () => {
        throw new Error('network failure');
      },
    };
    // Should not throw
    await expect(
      evaluateCapAlert(
        {
          userId: USER,
          sessionId: SESSION,
          tokenStatus: { tokens: 45_000_000, cap: 50_000_000 },
          costStatus: { spent: 0, cap: 0 },
        },
        deps,
      ),
    ).resolves.toBeUndefined();
  });
});

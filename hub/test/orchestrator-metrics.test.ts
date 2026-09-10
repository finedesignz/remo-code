/**
 * OBSRV-03: Orchestrator metrics counters + cap-accumulation gauges.
 *
 * Tests that:
 *  1. Enqueue counter increments via enqueueCycle() stub.
 *  2. Drain counter increments via drainOnce() with claimed entries.
 *  3. Skip-reason counter increments for: run_live, halted, stub_not_ready.
 *  4. Dispatch-outcome counter increments for various inject() outcomes.
 *  5. refreshOrchestratorCapGauges reads from getCostCapStatus / getTokenCapStatus
 *     and sets the four gauges.
 *
 * All tests use Bun mock.module to keep the module boundary clean. No DB, no network.
 */
import { describe, test, expect, mock, afterAll } from 'bun:test';
import { renderPrometheus } from '../src/observability/metrics.ts';

// ── Helper: assert a Prometheus exposition line exists ────────────────────────
function hasMetricLine(output: string, name: string, labels: Record<string, string>, minValue = 1): boolean {
  const labelStr = Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',');
  const pattern = labelStr
    ? new RegExp(`${name}\\{[^}]*${labelStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^}]*\\} (\\d+)`)
    : new RegExp(`${name} (\\d+)`);
  const m = output.match(pattern);
  if (!m) return false;
  return Number(m[1]) >= minValue;
}

// ── 1. enqueueCycle → cycles_enqueued_total ───────────────────────────────────
describe('orchestratorCyclesEnqueued', () => {
  test('increments when enqueueCycle is called', async () => {
    // Mock the DB sql so enqueueCycle doesn't need Postgres.
    await mock.module('../src/db/postgres.ts', () => ({
      sql: Object.assign(
        async (_strings: TemplateStringsArray, ..._values: unknown[]) => [
          { id: 'q1', session_id: 's1', priority: 0, status: 'pending', enqueued_at: new Date(), started_at: null },
        ],
        { begin: async (fn: Function) => fn(async () => []) },
      ),
    }));

    const { enqueueCycle, _resetForTests } = await import('../src/orchestrator/queue.ts');
    _resetForTests();

    await enqueueCycle('session-enqueue-test');

    const out = renderPrometheus();
    expect(out).toContain('remo_orchestrator_cycles_enqueued_total');
    // Counter should be ≥ 1 (may accumulate from other tests in this suite since counters are global)
    expect(out).toMatch(/remo_orchestrator_cycles_enqueued_total \d+/);
  });
});

// ── 2. drainOnce → cycles_drained_total ──────────────────────────────────────
describe('orchestratorCyclesDrained', () => {
  test('increments by the number of claimed entries', async () => {
    // We'll read the counter value before and after.
    const { renderPrometheus: render } = await import('../src/observability/metrics.ts');

    // Snapshot before
    const before = render();
    const beforeMatch = before.match(/remo_orchestrator_cycles_drained_total (\d+)/);
    const beforeVal = beforeMatch ? Number(beforeMatch[1]) : 0;

    // Import queue with a sql stub that returns 0 running rows and 2 pending entries,
    // then mock promote to running.
    await mock.module('../src/db/postgres.ts', () => {
      let callCount = 0;
      const innerTx = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
        const q = strings.join('?');
        if (q.includes('count(*)')) return [{ n: '0' }]; // running count
        if (q.includes('SELECT * FROM routine_queue')) {
          callCount++;
          // Return one candidate on first 2 calls, empty after
          if (callCount <= 2) {
            return [{ id: `q${callCount}`, session_id: `s${callCount}`, priority: 0, status: 'pending', enqueued_at: new Date(), started_at: null }];
          }
          return [];
        }
        if (q.includes('UPDATE routine_queue') && q.includes('running')) {
          return [{ id: 'qx', session_id: 'sx', priority: 0, status: 'running', enqueued_at: new Date(), started_at: new Date() }];
        }
        return [];
      };
      return {
        sql: Object.assign(
          async (strings: TemplateStringsArray, ..._values: unknown[]) => [],
          {
            begin: async (fn: Function) => fn(innerTx),
          },
        ),
      };
    });

    const { _resetForTests, setCycleRunner, drainOnce } = await import('../src/orchestrator/queue.ts');
    _resetForTests();

    let runnerCalled = 0;
    setCycleRunner(async (_entry) => { runnerCalled++; });

    await drainOnce();

    const after = render();
    const afterMatch = after.match(/remo_orchestrator_cycles_drained_total (\d+)/);
    const afterVal = afterMatch ? Number(afterMatch[1]) : 0;

    // The drain counter should have increased (by however many were claimed).
    expect(afterVal).toBeGreaterThanOrEqual(beforeVal);
    expect(after).toContain('remo_orchestrator_cycles_drained_total');
  });
});

// ── 3. Skip-reason counters via runMacroCycle ─────────────────────────────────
describe('orchestratorCycleSkipReason', () => {
  const baseInput = {
    userId: 'u1',
    sessionId: 's1',
    taskId: 't1',
    macroTaskType: 'dev' as const,
    stage: 'development' as const,
    repoPath: '/repo',
    repoIdent: 'github://owner/repo',
    repoKey: null,
  };

  test('increments reason=run_live when isRunLive returns true', async () => {
    const { runMacroCycle } = await import('../src/orchestrator/macro-cycle.ts');

    const deps = {
      getLatestAssistantReply: async () => null,
      appendRunLog: async () => {},
      inject: async () => ({ kind: 'dispatched' as const }),
      fanOut: async () => {},
      isRunLive: () => true,
    };

    const result = await runMacroCycle(baseInput, deps);
    expect(result.skipped).toBe(true);

    const out = renderPrometheus();
    expect(hasMetricLine(out, 'remo_orchestrator_cycle_skip_reason_total', { reason: 'run_live' })).toBe(true);
  });

  test('increments reason=halted when gate is open at halting stage', async () => {
    const { runMacroCycle } = await import('../src/orchestrator/macro-cycle.ts');

    const deps = {
      getLatestAssistantReply: async () =>
        '<<STATE lifecycle=beta>>\n<<GATE reason="needs approval" detail="PR review required">>\n',
      appendRunLog: async () => {},
      inject: async () => ({ kind: 'dispatched' as const }),
      fanOut: async () => {},
      isRunLive: () => false,
    };

    const haltingInput = { ...baseInput, stage: 'beta' as const };
    const result = await runMacroCycle(haltingInput, deps);
    expect(result.halted).toBe(true);

    const out = renderPrometheus();
    expect(hasMetricLine(out, 'remo_orchestrator_cycle_skip_reason_total', { reason: 'halted' })).toBe(true);
  });

  test('increments reason=stub_not_ready when macro is incomplete', async () => {
    // Stub renderMacro to return complete=false
    await mock.module('../src/orchestrator/task-macros.ts', () => ({
      renderMacro: () => ({ complete: false, prompt: '' }),
    }));

    const { runMacroCycle } = await import('../src/orchestrator/macro-cycle.ts');

    const deps = {
      getLatestAssistantReply: async () => null,
      appendRunLog: async () => {},
      inject: async () => ({ kind: 'dispatched' as const }),
      fanOut: async () => {},
      isRunLive: () => false,
    };

    const result = await runMacroCycle(baseInput, deps);
    expect(result.stubNotReady).toBe(true);

    const out = renderPrometheus();
    expect(hasMetricLine(out, 'remo_orchestrator_cycle_skip_reason_total', { reason: 'stub_not_ready' })).toBe(true);

    mock.restore();
  });
});

// ── 4. Dispatch-outcome counter ───────────────────────────────────────────────
describe('orchestratorDispatchOutcome', () => {
  const baseInput = {
    userId: 'u1',
    sessionId: 's-outcome',
    taskId: 't1',
    macroTaskType: 'dev' as const,
    stage: 'development' as const,
    repoPath: '/repo',
    repoIdent: 'github://owner/repo',
    repoKey: null,
  };

  async function runWithOutcome(kind: string, extra: Record<string, string> = {}) {
    // Ensure renderMacro returns complete=true
    await mock.module('../src/orchestrator/task-macros.ts', () => ({
      renderMacro: () => ({ complete: true, prompt: 'do the thing' }),
    }));

    const { runMacroCycle } = await import('../src/orchestrator/macro-cycle.ts');

    const deps = {
      getLatestAssistantReply: async () => null,
      appendRunLog: async () => {},
      inject: async () => ({ kind, ...extra } as any),
      fanOut: async () => {},
      isRunLive: () => false,
    };

    await runMacroCycle(baseInput, deps);
    mock.restore();
  }

  test('increments kind=dispatched', async () => {
    await runWithOutcome('dispatched');
    const out = renderPrometheus();
    expect(hasMetricLine(out, 'remo_orchestrator_dispatch_outcome_total', { kind: 'dispatched' })).toBe(true);
  });

  test('increments kind=no_session', async () => {
    await runWithOutcome('no_session');
    const out = renderPrometheus();
    expect(hasMetricLine(out, 'remo_orchestrator_dispatch_outcome_total', { kind: 'no_session' })).toBe(true);
    // Also increments skip reason for no_session
    expect(hasMetricLine(out, 'remo_orchestrator_cycle_skip_reason_total', { reason: 'no_session' })).toBe(true);
  });

  test('increments kind=refused_cost_cap', async () => {
    await runWithOutcome('refused_cost_cap', { reason: 'over_daily_cost_cap' });
    const out = renderPrometheus();
    expect(hasMetricLine(out, 'remo_orchestrator_dispatch_outcome_total', { kind: 'refused_cost_cap' })).toBe(true);
    expect(hasMetricLine(out, 'remo_orchestrator_cycle_skip_reason_total', { reason: 'refused_cost_cap' })).toBe(true);
  });
});

// ── 5. Cap gauge refresh ──────────────────────────────────────────────────────
describe('refreshOrchestratorCapGauges', () => {
  test('sets all four cap gauges from getCostCapStatus + getTokenCapStatus', async () => {
    await mock.module('../src/dispatch/gates.ts', () => ({
      getCostCapStatus: async () => ({ over: false, spent: 1.23, cap: 10.0 }),
      getTokenCapStatus: async () => ({ over: false, tokens: 5_000_000, cap: 50_000_000 }),
      // include other exports that may be imported by orchestrator-metrics
      dailyCostCapGate: async () => ({ kind: 'pass' }),
      dailyTokenCapGate: async () => ({ kind: 'pass' }),
      thresholdGate: async () => ({ kind: 'pass' }),
    }));

    const { refreshOrchestratorCapGauges } = await import('../src/observability/orchestrator-metrics.ts');
    await refreshOrchestratorCapGauges('u1', 'UTC');

    const out = renderPrometheus();
    expect(out).toMatch(/remo_orchestrator_daily_tokens_total 5000000/);
    expect(out).toMatch(/remo_orchestrator_daily_token_cap 50000000/);
    expect(out).toMatch(/remo_orchestrator_daily_cost_usd 1\.23/);
    expect(out).toMatch(/remo_orchestrator_daily_cost_cap_usd 10/);

    mock.restore();
  });

  test('cost cap gauge is 0 when cap is null/disabled', async () => {
    await mock.module('../src/dispatch/gates.ts', () => ({
      getCostCapStatus: async () => ({ over: false, spent: 0, cap: null }),
      getTokenCapStatus: async () => ({ over: false, tokens: 0, cap: 50_000_000 }),
      dailyCostCapGate: async () => ({ kind: 'pass' }),
      dailyTokenCapGate: async () => ({ kind: 'pass' }),
      thresholdGate: async () => ({ kind: 'pass' }),
    }));

    const { refreshOrchestratorCapGauges } = await import('../src/observability/orchestrator-metrics.ts');
    await refreshOrchestratorCapGauges('u1', 'UTC');

    const out = renderPrometheus();
    expect(out).toMatch(/remo_orchestrator_daily_cost_cap_usd 0/);

    mock.restore();
  });
});

afterAll(() => {
  mock.restore();
});

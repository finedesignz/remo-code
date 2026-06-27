// hub/src/observability/orchestrator-metrics.ts
// Phase OBSRV-03 — orchestrator-specific Prometheus metrics.
//
// INSTRUMENTATION ONLY: zero behavior change to any dispatch/cap/gate path.
// All metric calls are fail-open (wrapped at the call site in try/catch so a
// metrics error never wedges a cycle).
//
// Metrics exposed:
//   remo_orchestrator_cycles_enqueued_total  — counter, by session (no label — keep card low)
//   remo_orchestrator_cycles_drained_total   — counter, incremented per claimed+run entry
//   remo_orchestrator_cycle_skip_reason_total — counter by reason (run_live|halted|stub_not_ready|…)
//   remo_orchestrator_dispatch_outcome_total — counter by outcome kind (dispatched|queued|no_session|…)
//   remo_orchestrator_daily_tokens_total     — gauge, today's accumulated token total (READ only)
//   remo_orchestrator_daily_token_cap        — gauge, configured daily token ceiling
//   remo_orchestrator_daily_cost_usd         — gauge, today's accumulated cost USD (READ only)
//   remo_orchestrator_daily_cost_cap_usd     — gauge, configured daily cost cap USD

import { counter, gauge } from './metrics.ts';

// ── Cycle lifecycle counters ──────────────────────────────────────────────────

/** Incremented in enqueueCycle() each time a cycle is inserted into routine_queue. */
export const orchestratorCyclesEnqueued = counter(
  'remo_orchestrator_cycles_enqueued_total',
  'Total orchestrator cycles enqueued into routine_queue.',
);

/** Incremented in drainOnce() per claimed entry handed to the runner. */
export const orchestratorCyclesDrained = counter(
  'remo_orchestrator_cycles_drained_total',
  'Total orchestrator cycles claimed from routine_queue and handed to the runner.',
);

// ── Skip-reason counter ───────────────────────────────────────────────────────
// Labels kept to a small, bounded set (reason values come from finite code paths).
// Known reasons:
//   run_live        — SPEC §2.3: a run is already in-flight for this session
//   halted          — an open gate forces a halt at a halting lifecycle stage
//   stub_not_ready  — macro_task_type has a stub prompt (complete=false)
//   no_session      — session offline, inject returns no_session
//   refused_cost_cap — daily dollar cost cap over
//   refused         — other dispatch refusal (with sub-reason in the reason label)
//   failed          — inject threw or returned 'failed'

/** Incremented when a macro cycle skips or halts, labelled by reason. */
export const orchestratorCycleSkipReason = counter(
  'remo_orchestrator_cycle_skip_reason_total',
  'Total orchestrator macro cycle non-dispatch events, labelled by reason.',
);

// ── Dispatch-outcome counter ──────────────────────────────────────────────────
// Mirrors InjectOutcome.kind values from inject.ts + sub-reasons for 'refused'.

/** Incremented for every inject call, labelled by outcome kind. */
export const orchestratorDispatchOutcome = counter(
  'remo_orchestrator_dispatch_outcome_total',
  'Total orchestrator inject() calls by outcome kind.',
);

// ── Daily cap-accumulation gauges ─────────────────────────────────────────────
// These are best-effort READ-ONLY snapshots refreshed after each macro tick via
// refreshOrchestratorCapGauges(). A single label-less series per gauge (no
// per-user cardinality — the orchestrator runs one user in prod).

/** Today's accumulated token total (sum of token_usage rows for today's tz-day). */
export const orchestratorDailyTokensTotal = gauge(
  'remo_orchestrator_daily_tokens_total',
  "Today's accumulated orchestrator token total (read from token_usage).",
);

/** Configured daily token ceiling (REMO_ORCHESTRATOR_DAILY_TOKEN_CAP, default 50M). */
export const orchestratorDailyTokenCap = gauge(
  'remo_orchestrator_daily_token_cap',
  'Configured daily orchestrator token ceiling.',
);

/** Today's accumulated cost in USD (sum of cost_usd from token_usage for today). */
export const orchestratorDailyCostUsd = gauge(
  'remo_orchestrator_daily_cost_usd',
  "Today's accumulated orchestrator cost in USD (read from token_usage).",
);

/** Configured daily cost cap in USD (users.daily_cost_cap_usd, or 0 if disabled). */
export const orchestratorDailyCostCapUsd = gauge(
  'remo_orchestrator_daily_cost_cap_usd',
  'Configured daily orchestrator cost cap in USD (0 = disabled).',
);

// ── Cap gauge refresh helper ──────────────────────────────────────────────────

/**
 * Refresh the four cap-accumulation gauges from the READ-ONLY sources.
 *
 * Called after each macro tick (best-effort: caller wraps in try/catch).
 * Imports gates.ts lazily to avoid circular deps; all reads are non-mutating.
 */
export async function refreshOrchestratorCapGauges(userId: string, tz: string): Promise<void> {
  const { getCostCapStatus, getTokenCapStatus } = await import('../dispatch/gates.ts');
  const [costStatus, tokenStatus] = await Promise.all([
    getCostCapStatus(userId, tz),
    getTokenCapStatus(userId, tz),
  ]);
  orchestratorDailyTokensTotal.set(tokenStatus.tokens);
  orchestratorDailyTokenCap.set(tokenStatus.cap);
  orchestratorDailyCostUsd.set(costStatus.spent);
  orchestratorDailyCostCapUsd.set(costStatus.cap ?? 0);
}

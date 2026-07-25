# OBSRV-03: Orchestrator Metrics Counters — Plan

## Goal
Add Prometheus counters, histograms, and gauges for the auto-dev orchestrator's
cycle lifecycle, skip-reason distribution, dispatch outcomes, and daily
cap-accumulation totals.

## Constraint
INSTRUMENTATION ONLY. Zero behavior change to any dispatch path, gate, or cap
decision. All metric calls fail-open (try/catch).

## Files Changed

| File | Change |
|------|--------|
| `hub/src/observability/orchestrator-metrics.ts` | **NEW** — exports all orchestrator metric instances + `refreshOrchestratorCapGauges` helper |
| `hub/src/orchestrator/queue.ts` | Import metrics; `enqueueCycle` → inc `cycles_enqueued_total`; `drainOnce` → inc `cycles_drained_total` by claimed count |
| `hub/src/orchestrator/macro-cycle.ts` | Import metrics; inc `cycle_skip_reason_total` at halted/run_live/stub_not_ready; inc `dispatch_outcome_total` per inject outcome; call `refreshOrchestratorCapGauges` (fail-open) |
| `hub/test/orchestrator-metrics.test.ts` | **NEW** — 10 tests; all pass |

## Metrics Exported

| Metric | Type | Labels |
|--------|------|--------|
| `remo_orchestrator_cycles_enqueued_total` | counter | (none) |
| `remo_orchestrator_cycles_drained_total` | counter | (none) |
| `remo_orchestrator_cycle_skip_reason_total` | counter | `reason` |
| `remo_orchestrator_dispatch_outcome_total` | counter | `kind` |
| `remo_orchestrator_daily_tokens_total` | gauge | (none) |
| `remo_orchestrator_daily_token_cap` | gauge | (none) |
| `remo_orchestrator_daily_cost_usd` | gauge | (none) |
| `remo_orchestrator_daily_cost_cap_usd` | gauge | (none) |

## Skip-reason Values
- `run_live` — SPEC §2.3: a run is already in-flight
- `halted` — open gate at halting stage (beta/production-maintenance)
- `stub_not_ready` — macro prompt marked complete=false
- `no_session` — inject returned no_session (offline session)
- `refused_cost_cap` — daily cost cap exceeded
- `refused_<sub>` — other dispatch refusal with sub-reason
- `failed` — inject threw or returned 'failed'

## Success Criteria
- 10/10 tests pass (`bun test hub/test/orchestrator-metrics.test.ts`)
- All new instrumentation wrapped in try/catch (fail-open)
- Zero diff to control flow, gate decisions, or cap behavior

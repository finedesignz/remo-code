# OBSRV-05: Cap-Approach Alerting — Plan

**Milestone:** OBSRV (Observability)
**Branch:** `OBSRV-05-cap-approach-alerting`
**Goal (METRIC-03):** Fire a stage-gated, throttled `notify.ts` fan-out when daily token OR cost accumulation crosses a configurable % threshold of either cap.

## Hard Constraints

- ZERO behavior change to dispatch path or cap enforcement (`gates.ts` read-only).
- Alert is informational only (`event: 'info'`) — never blocks a cycle.
- Fail-open: any error in the alert path is swallowed; the cycle continues.
- Throttled: fire at most once per cap per UTC calendar day per user.
- New env knob: `REMO_ORCHESTRATOR_CAP_ALERT_PCT` (default 80, range 1–100).

## Implementation

### New file: `hub/src/observability/cap-alert.ts`

- `evaluateCapAlert(params, deps?)` — public API, never throws.
- `_resetCapAlertStateForTests()` — exported reset for test cleanup.
- In-memory `alertedToday: Set<string>` keyed `${userId}:token:${date}` / `${userId}:cost:${date}`.
- Mark alerted BEFORE calling `fanOut` (so a throw in fanOut doesn't allow a retry).
- Skips checks when `cap <= 0` (disabled caps).
- Injectable `CapAlertDeps.fanOut` seam for testing.

### Modified: `hub/src/orchestrator/macro-cycle.ts`

- Import `evaluateCapAlert` from new module.
- Add optional `evaluateCapAlert?` field to `MacroCycleDeps` interface.
- Wire call immediately after OBSRV-03 gauge refresh block (same fail-open pattern):
  - Lazy-import `getCostCapStatus` / `getTokenCapStatus` from `gates.ts`.
  - Pass `d.fanOut` via `CapAlertDeps` for test spy coverage.

### New test: `hub/test/orchestrator-cap-alert.test.ts`

7 scenarios:
1. Below threshold → no alert
2. Token threshold crossed → one alert (detail contains "token")
3. Cost threshold crossed → one alert (detail contains "cost")
4. Second cycle same day still over → throttled (no duplicate)
5. `REMO_ORCHESTRATOR_CAP_ALERT_PCT` env override respected
6. Both caps crossed → two alerts
7. Throwing fanOut → fail-open (no propagation)

## Environment Variables

| Var | Default | Description |
|-----|---------|-------------|
| `REMO_ORCHESTRATOR_CAP_ALERT_PCT` | `80` | Alert threshold % (1–100). Invalid values fall back to 80. |

## Injection Point

After line ~232 in `macro-cycle.ts` (post OBSRV-03 gauge refresh, pre run-log append).

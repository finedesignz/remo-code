# Auto-Dev Orchestrator — Enablement Runbook (go / no-go)

How to flip `REMO_ORCHESTRATOR_ENABLED` in prod **with evidence**. This runbook is the
bridge between the OEE (Orchestrator E2E Prove-Out) milestone — which proved the live
path against real Postgres in CI — and a deliberate, human-gated prod enablement.

> **The prod flag-flip is OUT OF SCOPE of the OEE milestone.** OEE proves the wiring;
> turning it on in prod is a **separate, later, HUMAN go/no-go decision**. This document
> is the checklist for that decision, not authorization to perform it.

Architecture: [auto-dev-orchestrator.md](auto-dev-orchestrator.md). Flag semantics:
[CLAUDE.md](../CLAUDE.md) (`REMO_ORCHESTRATOR_ENABLED`).

## What the OEE suite proves

The 8 e2e files under `hub/test/e2e/` drive the REAL hub orchestrator code (no
monkeypatching of the units under test) against a REAL, disposable Postgres. Each
proves one live-path invariant:

| Phase | File | Invariant proven (against real PG) |
|---|---|---|
| OEE-01/02 | `orchestrator-harness.smoke.e2e.test.ts` | Non-prod DSN guard (refuses prod-looking `DATABASE_URL`); harness schema + scripted bound-session sink boot cleanly. |
| OEE-03 | `orchestrator-queue-lock.e2e.test.ts` | `routine_queue` enqueue + drain worker claim with the per-session lock — no double-claim, lock released on completion. |
| OEE-04 | `orchestrator-due-waves.e2e.test.ts` | DB-backed due-scan (`computeDueRowsForTask`) → controller dependency-aware **wave** ordering from real `orchestrator_rows` + `schedule_rule` windows. |
| OEE-05 | `orchestrator-macro-cycle.e2e.test.ts` | Default TMAC `runMacroCycle` + `<<STATE>>`/`<<NOTIFY>>`/`<<GATE>>` sentinel reconciliation → `routine_run_log`. |
| OEE-06 | `orchestrator-costcap.e2e.test.ts` | Non-bypassable daily cost cap halts the cycle (real `token_usage`-backed `isOverCostCap`). |
| OEE-07 | `orchestrator-notify.e2e.test.ts` | Stage-gated notify matrix (dev = silent, prod = halt+notify) fan-out. |
| OEE-08 | `orchestrator-verify-tail.e2e.test.ts` | Mandatory terminal verify-tail (`runVerifyTail`) always-runs path against a stub `REMO_VERIFY_*` target. |

Together: queue/lock, due→waves, macro-cycle + sentinels, cost-cap, notify matrix,
and verify-tail are all exercised end-to-end. (OEE-09 covered the
`REMO_ORCHESTRATOR_LEGACY_WAVES` rollback lever; the flag and the legacy wave path
were DELETED — rollback to a subsystem that never shipped a PR is rollback to
nothing. The macro path is the only cycle path.)

## How to run the suite

The suite is gated on `REMO_E2E_DB_URL`. Without it, every e2e file **skips cleanly**
(so `bun run check-baseline` stays green on hosts with no Postgres).

```bash
# Local — point at a DISPOSABLE Postgres (NEVER the Coolify prod DB):
REMO_E2E_DB_URL=postgres://localhost:5432/remo_e2e bun run orchestrator:e2e
```

**In CI it runs automatically on every PR to `main`.** `.woodpecker/qc.yaml` stands up
a `postgres:16` service, exports `REMO_E2E_DB_URL`, and runs `bun run orchestrator:e2e`
explicitly (and `bun run check-baseline` also executes each e2e file per-process). A
green PR-gate IS the standing proof that the live path works against real Postgres.

## Companion env knobs (set BEFORE enabling)

| Env | Default | Purpose |
|---|---|---|
| `REMO_ORCHESTRATOR_ENABLED` | OFF (`0`) | The single live-path gate. Accepts `1\|true\|yes\|on`. |
| `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY` | `2` | Global cap on concurrent cycles. Start at `1` in staging. |
| `REMO_ORCHESTRATOR_DRAIN_INTERVAL_MS` | `1000` | Queue drain-worker interval. |
| `REMO_ORCHESTRATOR_TICK_INTERVAL_MS` | `60000` | Due-scan enqueue tick interval. |
| `REMO_VERIFY_APP_UUID` / `REMO_VERIFY_BASE_URL` / `REMO_VERIFY_ROUTES` | unset / default routes | Verify-tail target (no-op when unset). Confirm these point at the right app before enabling. |
| `COOLIFY_TOKEN` | — | Needed for verify-tail deploy/redeploy. |

## Staging-first flip checklist

1. **CI green.** Confirm the latest `main` PR-gate is green — OEE e2e + check-baseline passed against real PG.
2. **Pick a NON-PROD hub** (staging / a disposable Coolify app with its own non-prod DB). Never the prod DB.
3. **Set companion knobs conservatively:** `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY=1`, default intervals, verify-tail `REMO_VERIFY_*` pointed at a non-prod app, `COOLIFY_TOKEN` present.
4. **Enable on staging:** set `REMO_ORCHESTRATOR_ENABLED=1`, redeploy.
5. **Watch `routine_run_log`** for at least one full tick: rows appear, sentinels reconcile, no errors, lock acquired/released.
6. **Watch cost:** confirm the daily cost cap is respected and per-tick cost is within expectation (`GET /api/usage/cost`). The cap is non-bypassable, but verify it actually engages.
7. **Confirm notify matrix:** dev-stage rows stay silent; a prod-stage mandatory gate halts + notifies as designed.
8. **Soak** for a representative window (hours/days) on staging. No runaway enqueues, no stuck locks, no double-claims.
9. **Prod go/no-go (HUMAN):** only after staging soak is clean, present evidence (run-log excerpts + cost) to the human gate. Enabling prod is a separate authorized decision — this runbook does not authorize it.

## Rollback

- **Instant disable:** unset / set `REMO_ORCHESTRATOR_ENABLED=0` and redeploy. With the flag OFF, nothing registers, enqueues, or injects — the system returns to fully dormant.
- **Macro→legacy path rollback: REMOVED.** `REMO_ORCHESTRATOR_LEGACY_WAVES` and the legacy per-micro-command-row wave path are deleted; `REMO_ORCHESTRATOR_ENABLED=0` is the only rollback lever.

## Out of scope (explicit)

Flipping `REMO_ORCHESTRATOR_ENABLED` in **prod** is a separate human go/no-go and is
NOT performed by this milestone. OEE proves the path; a human decides — with the
evidence this runbook produces — when prod turns on.

# Phase 32 — legacy-task-migration-and-docs · SUMMARY

**Status:** Complete · commits `252a132` (wiring), `17a739f` (migration), `6b685eb` (docs) on `feat/auto-dev-orchestrator`

Final phase: closes the Phase-25 controller→wave deferral (end-to-end wiring), legacy-task migration, docs sweep, milestone QC.

## Delivered
1. **Controller→wave end-to-end wiring** — `makeCycleRunner`→`resolveCycleContext(session_id)` (→user/repo + orchestrator task + lifecycle_stage) → `buildControllerContext` (DUE rows) → `runWavesFromDueRows` (`planWaves` + per-command `executeCommand` cost-capped inject) → `dispatchMergeIfDue` (off-hours) → `runVerifyTail` (always). New flag-gated due-scan enqueue tick `scanAndEnqueueDueCycles` (`REMO_ORCHESTRATOR_TICK_INTERVAL_MS`, default 60s). Boot-wired `registerCycleRunnerIfEnabled()` in `index.ts` + shutdown stop. **Async/tick model:** `executeCommand` returns at dispatch; PR/reviewer run in the agent turn; reconciled on a later tick via run-log re-read.
2. **Migration** — `hub/scripts/migrate-legacy-tasks-to-orchestrator.ts`: one-shot, idempotent, `--dry-run`, `import.meta.main`-guarded (no auto-run); folds dev/qc/security/log_check → one orchestrator task/session + parked rows; disables (not deletes) legacy tasks. Not in schema.sql.
3. **Docs** — new `docs/auto-dev-orchestrator.md` (source of truth) + Docs-map row + env documentation in CLAUDE.md (all `REMO_ORCHESTRATOR_*` + `REMO_VERIFY_*` + off-hours window) + README bullet.

## Safety
Flag-OFF default absolute: unset `REMO_ORCHESTRATOR_ENABLED` ⇒ no runner registered, tick never starts ⇒ nothing enqueued/injected/merged. Hub text-only; cost cap on every inject; schema.sql idempotent-only.

## QC
`build:web` clean; `check-baseline` pass=1488 fail=0; orchestrator suite (10 files, 147 tests) 0 fail; no-indigo pass.

## REMAINING ENABLEMENT GATE (before `REMO_ORCHESTRATOR_ENABLED=1` in prod)
1. Real-Postgres e2e soak (queue/lock/idempotency/approvals/run-log/schema) — never run (no PG on build host). **Primary blocker.**
2. Confirm `REMO_VERIFY_APP_UUID/BASE_URL/ROUTES` + `COOLIFY_TOKEN` in prod.
3. Monitored canary (one repo, development stage) before fleet-wide.

# OEE-10/11 — entrypoint, enablement runbook, CI wiring, docs sweep — SUMMARY

**Files (worktree → branch feat/orchestrator-e2e-proveout):**
- `package.json` (root): `"orchestrator:e2e": "bun test hub/test/e2e/*.e2e.test.ts"` entrypoint.
- `.woodpecker/qc.yaml`: appended `bun run orchestrator:e2e` after the orchestrator-critical test line — the OEE suite runs explicitly against the real `postgres:16` service (`REMO_E2E_DB_URL` already set there), making the proof visible in CI logs. (check-baseline already runs each e2e file per-process.)
- `docs/orchestrator-e2e-runbook.md` (new): go/no-go enablement runbook — invariant-proven table, how to run (REMO_E2E_DB_URL / CI auto-run), staging-first flip checklist, companion env knobs (GLOBAL_CONCURRENCY, DRAIN/TICK intervals, REMO_VERIFY_*), rollback (`REMO_ORCHESTRATOR_ENABLED=0` + `REMO_ORCHESTRATOR_LEGACY_WAVES=1`), and the explicit statement that the prod flag-flip is a separate HUMAN go/no-go (out of scope).
- `docs/auto-dev-orchestrator.md`: "e2e-unproven" language replaced with the proven matrix + runbook link; flag-OFF-in-prod statement kept.

**OEE-11 QC:** e2e suite 0-fail (skip-clean without DB; runs green vs real PG in CI). No openapi/route changes → no `docs:sync` needed. No `schema.sql`/`hub/src` behavior change. Prod flag default untouched.

**Proof location:** the permanent green real-PG run is the Woodpecker `qc` PR-gate (real postgres:16 + REMO_E2E_DB_URL). Green CI on the milestone PR = the orchestrator e2e proof.

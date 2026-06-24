# Phase 21 — orchestrator-data-model · SUMMARY

**Status:** Complete · commit `7fcc433` on `feat/auto-dev-orchestrator` · QC: READY (4/4 PASS)

Foundational additive DDL for the Auto-Dev Orchestrator. No behavior wired — schema + thin DAL only.

## Delivered
- `scheduled_tasks.task_type` CHECK extended with `'orchestrator'` (named-constraint drop/add, idempotent). [R-ADO-01]
- `idx_scheduled_tasks_orchestrator_unique` — partial unique on `(session_id) WHERE task_type='orchestrator'` (one orchestrator per session). [R-ADO-01]
- `scheduled_tasks.lifecycle_stage TEXT NOT NULL DEFAULT 'development'` + guarded CHECK `{development,beta,production-maintenance}`. [R-ADO-02]
- Table `orchestrator_rows` (FK→scheduled_tasks ON DELETE CASCADE, `schedule_rule` JSONB, `command`, `enabled`, `frequency_label`, `micro_prompt`, `sort_order`) + idx `(task_id, sort_order)`. [R-ADO-03]
- Table `routine_run_log` (FK→sessions; command, decision_rationale, outcome, gap_dimension, pr_url, reviewer_verdict, deploy_verify_result) + idx `(session_id, created_at DESC)`. [R-ADO-04]
- Table `routine_queue` (FK→sessions; priority, status, timestamps) + guarded status CHECK + partial unique `idx_routine_queue_session_running (session_id) WHERE status='running'` (per-session lock) + pending-drain index. [R-ADO-04]
- `hub/src/db/orchestrator-rows-dal.ts` — thin typed insert/select helpers (`sql.json()` JSONB pattern).

## Files
`hub/src/db/schema.sql` (+95) · `hub/src/db/orchestrator-rows-dal.ts` (new) · `hub/test/orchestrator-data-model.test.ts` (new) · `.planning/phases/21-orchestrator-data-model/PLAN.md`

## Tests
schema.sql double-boot idempotency + one-per-session + running-lock rejection; `check-baseline` fail=0; `migrate.test` 13 pass (splitter tokenizes the 12 new statements incl. DO-blocks).

## Notes
- schema.sql re-runs every boot — all DDL idempotent; zero inline backfill.
- Deviation: `command`/`frequency_label` are free TEXT at the DB layer; Never/Once semantics enforced by the controller in Phase 23+.

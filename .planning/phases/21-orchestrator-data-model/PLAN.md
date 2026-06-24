# Phase 21: orchestrator-data-model — PLAN

- Milestone: `m-auto-dev-orchestrator` (Auto-Dev Orchestrator, Phases 21–32)
- Mode: standard · Depends on: [] · Requirements: R-ADO-01, R-ADO-02, R-ADO-03, R-ADO-04
- Source: `.planning/architecture/auto-dev-orchestrator-SPEC.md` §2 + decisions D1, D3, D4, D10

## Goal

Foundational, **additive, idempotent** DDL for the orchestrator task model. **No behavior
is wired** — schema + thin DAL + idempotency test only. Phase 22+ consume these objects.

## Invariants (carried)

- `schema.sql` re-runs IN FULL every hub boot → only idempotent DDL (`CREATE … IF NOT
  EXISTS`, `ADD COLUMN IF NOT EXISTS`, guarded `ADD CONSTRAINT` via `DO $$ … EXCEPTION WHEN
  duplicate_object`). Any backfill → one-shot in `hub/scripts/` (none needed this phase).
- Reuse the existing `ScheduleRule` JSONB shape (`hub/src/scheduler/schedule-rules.ts`).
- Mirror prior `task_type` CHECK extension (DROP IF EXISTS + ADD named constraint) and the
  existing idempotency-table / partial-unique-index patterns already in `schema.sql`.

## Deliverables

1. `scheduled_tasks.task_type` CHECK extended to include `'orchestrator'` (in the existing
   named `scheduled_tasks_task_type_check`). *(R-ADO-01, D3)*
2. Partial unique index `idx_scheduled_tasks_orchestrator_unique ON scheduled_tasks(session_id)
   WHERE task_type = 'orchestrator'` — one orchestrator task per session. *(R-ADO-01, D3)*
3. `scheduled_tasks.lifecycle_stage TEXT NOT NULL DEFAULT 'development'` + guarded CHECK in
   `{development, beta, production-maintenance}`. *(R-ADO-02, D10)*
4. New idempotent tables: *(R-ADO-03, R-ADO-04, D1/D4/D10)*
   - `orchestrator_rows` (id, task_id FK→scheduled_tasks ON DELETE CASCADE, command, enabled,
     schedule_rule JSONB, frequency_label, micro_prompt, sort_order, timestamps) + index
     `(task_id, sort_order)`.
   - `routine_run_log` (id, session_id FK→sessions, repo_key, command, decision_rationale,
     outcome, gap_dimension, pr_url, reviewer_verdict, deploy_verify_result, created_at) +
     index `(session_id, created_at DESC)`.
   - `routine_queue` (id, session_id FK→sessions, priority, status, enqueued_at, started_at) +
     guarded status CHECK + partial unique `(session_id) WHERE status='running'` (per-session
     lock) + pending-drain index `(priority DESC, enqueued_at) WHERE status='pending'`.
5. Thin typed DAL `hub/src/db/orchestrator-rows-dal.ts`: insert/select helpers for the three
   tables (no business logic), `ScheduleRule`-typed.

## Test (TDD)

`hub/test/orchestrator-data-model.test.ts`:
- Always-on (no DB): assert `schema.sql` declares each object with its idempotent/partial shape.
- Env-gated (`REMO_E2E_DB_URL`): boot `schema.sql` **twice** (idempotency), assert tables
  exist, `lifecycle_stage` default+CHECK, one-orchestrator-per-session rejects a 2nd row,
  `routine_queue` running-lock rejects a 2nd running row, DAL round-trip.

## Out of scope (later phases)

Queue drain / global concurrency (P22), controller tick / prompt / decision parser (P23+),
UI, presets, migration of legacy tasks (P32).

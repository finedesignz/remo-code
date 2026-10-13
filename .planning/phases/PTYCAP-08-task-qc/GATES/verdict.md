# Phase 8 fork panel - LOCKED VERDICT

Seats: A (sonnet, refute-first), B (sonnet, blast-radius), Codex (read-only judge). Raw: seat-A.md, seat-B.md, seat-codex.md. All three: ACCEPT-WITH-AMENDMENT on both forks.

| Fork | LOCKED |
|---|---|
| FORK-1 engine | A: deterministic hub-side engine, NO model turn |
| FORK-2 home | A: system-owned scheduled_tasks row task_type='task_qc' |

## Mandatory amendments (planner MUST encode each as a task + test)

FORK-1
- Rewrite 08-SPEC TQC-07 and the 09-SPEC inherited-budget table (drop REMO_TASK_QC_TOKEN_CAP; CQ-04) IN THIS PR.
- task_qc is terminal across the whole lifecycle: suppress generic post-run actions and legacy chaining for this task type (post-run/dispatcher.ts:305-385, chain.ts:45-49) even if malformed data is in the DB. Test: a run produces NO user_message, dispatch call, session launch, chain_task, token_usage row.
- Replace the dropped token bound with deterministic bounds: max audited tasks, max history rows per task, max auto-fixes per pass, statement/wall-clock timeout, max rows written per run.
- Expose a pure `runTaskQcPass(scope)` entry; scope can only narrow (seam for Phase 9).
- Digest email built only from typed fields (no raw task text injected unescaped).
- Remove the stale "cost is unmeasurable" rationale (run cost IS written now, dispatcher.ts:48-76,764-778).

FORK-2
- Dedicated task_qc branch in fireTask immediately after the kill-switch check, BEFORE quota/cost gates and target resolution (null session would otherwise fail no_targets, targets.ts:32-35). Checks the flag before inserting a run; atomically claims the one-open-run slot; one null-session run; runs engine; updates fire timestamps; finalizes; returns.
- Verify session_id nullability in schema.sql (seat B claims NOT NULL+CASCADE, codex claims nullable). If NOT NULL, do NOT anchor on a deletable session; choose an additive nullable path or a stable anchor with re-seed check - document which.
- Seed before registry.loadAll + catchup (index.ts:747-752) or register explicitly. Flag OFF: exclude task_qc from registry loading AND catchup; an armed callback returns before inserting a run. Flag OFF = true no-op (test).
- CHECK constraint: just add 'task_qc' to the list re-applied at schema.sql:205-231 (precedent teab/work). Enum-sync test across scheduled-tasks.ts, DAL, auto-name.ts, run-reaper.ts and the TaskType union.
- System-owned row: API PATCH/DELETE (api/scheduled-tasks.ts:576-608) reject task_type/target/prompt/payload/email/post-run/schedule_kind changes and deletion; allow only enable/disable + validated cadence/timezone.
- Session-scope halt on any anchor must not silently stop QC without a test pinning the behaviour; hub kill switch DOES stop it.
- __internal_* rows enabled=false by design: never flagged/fixed.

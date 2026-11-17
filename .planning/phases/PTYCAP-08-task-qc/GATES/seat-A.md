# Seat A (refute-first) - PTYCAP-08 forks

## FORK-1 (deterministic hub sender): ACCEPT-WITH-AMENDMENT
- Refutation attempted: does no-LLM fail SC1-5 / OPTIMIZE? No. 08-SPEC.md:60-79 defines all six detectors as
  "pure functions over rows"; OPTIMIZE (SPEC:69) is three row heuristics (no-change ratio >=90%, prompt-length
  top decile, identical (task_type,target,prompt) triple) - all computable in code, no prose judgement needed.
  TQC-03/05 writer = literal allowlist, TQC-07 "diagnostic prompt" is the only model-dependent text and nothing
  in TQC-02..06 acceptance consumes model output.
- Phase 9 CQ-04/CQ-05 (09-SPEC.md:109-135) need a scoped Phase-8 pass + run-count ceiling; examples
  recompute_next_run_at / backfill_payload_from_sibling are pure code. Fits.
- Amendments: (1) SPEC column names are wrong vs schema: SPEC says last_run_at/next_run_at, schema has
  last_fire_at/next_fire_at (schema.sql ~L1xx ADD COLUMN) - detectors must use real names, pin by test.
  (2) TQC-07 acceptance (QC ceiling, over_task_qc_token_cap, token-cap-coverage inclusion) must be rewritten as
  "module-graph guard + zero token_usage rows"; 09 CQ-04 text "uses Phase 8's REMO_TASK_QC_TOKEN_CAP" must be
  amended to drop that knob. (3) Sender must not use a gates:[ list (no dispatch) - confirm token-cap-coverage
  scan has no false positive; keep recursion guard (QC cannot enqueue QC) as a code-level test.
  (4) Keep a seam (detector output = typed findings) so a model digest can be layered later.

## FORK-2 (scheduled_tasks row, task_type='task_qc'): ACCEPT-WITH-AMENDMENT
- CHECK constraint: schema.sql:205-231 already does DROP CONSTRAINT IF EXISTS scheduled_tasks_task_type_check
  then ADD CONSTRAINT with the full list on EVERY boot (precedent: 'teab','work','triage' added by editing this
  list). Adding 'task_qc' = edit that list literal; superset of old list so ADD validates existing rows; idempotent
  and re-run safe. NOT a data migration (rule 6 untouched). No separate ALTER needed - do NOT add a second
  constraint statement. Caveat: DROP+ADD is two statements, brief window without constraint; accepted precedent.
  Note the line-181 inline CHECK on the original ADD COLUMN is only for fresh DB then superseded by L205.
- Dispatcher: kill-switch pre-gate at dispatcher.ts:241-248 precedes task_type branches; must add an explicit
  `if (task.task_type === 'task_qc')` branch before the `switch` at ~L699 (otherwise default case / agent sender
  risk). Model it on the 'work' branch (L439). Switch must not route it to senders/agent.ts.
- Amendments: enum sync in api/scheduled-tasks.ts, scheduled-tasks-dal.ts, auto-name.ts, run-reaper.ts (all
  reference task types) + sync assertion test; partial unique index per user mirroring orchestrator index
  (schema.sql ~L289-294); exclude task_qc and __internal_* from audit set; email_summary=false per D-20;
  create/edit guards (D-25). Standalone timer rejected: agree (repo rule against hand-rolled schedulers).

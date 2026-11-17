# PTYCAP-08 QC - correctness + test-honesty lens

Scope: git diff ec2237e..HEAD -- hub/ tools/. Ran every new task-qc-* test file, scheduler/post-run/chain suites, workflows-fanout: all pass, 0 fail.

VERDICT: CONTENT-BLOCK (1 MAJOR)

## Findings

1. MAJOR - PATCH converts any user task into task_qc, bypassing the "machine-seeded only" rule (F2-B5/D-25).
   hub/src/api/scheduled-tasks.ts: POST rejects task_type 'task_qc' (~L336), and PATCH on an EXISTING task_qc row locks task_type (L~519). But PatchSchema = CreateSchema.partial() accepts task_type:'task_qc' and the generic PATCH path (L~640 `task_type: data.task_type` -> updateTaskV2, dal L350) writes it for any NON-task_qc row. No guard exists; task-qc-api-guards.test.ts only covers create/delete/patch-of-existing-qc. Effects: user-created row becomes an auditor (null target, no model), idx_scheduled_tasks_task_qc_unique makes a second conversion 500; with flag OFF the converted task is silently never armed (registry skip). Fix: in PATCH, if data.task_type === 'task_qc' and existing.task_type !== 'task_qc' return 400 task_qc_machine_seeded (before any write); add a test.

2. MINOR - 08-07 digest deviation ("applied + newly recorded only") loses findings on a failed send and on same-day re-runs.
   hub/src/scheduler/senders/task-qc.ts L~108 (report), engine.ts recordProposal (`if (res.inserted)`). Dedupe key includes day, so a still-true condition IS re-recorded and re-mailed next day (the in-code comment "not re-mailed every day" is wrong). But: if sendEmail returns false, rows are already recorded, so a Run Now the same day mails nothing for them; a Run Now after the scheduled run yields no digest at all. SC4 ("everything not auto-fixed becomes one digest") is only met per first-recording. Not wrong enough to block (locked tracer test requires zero emails when the row exists); fix: record a delivered flag or mail unconditionally and dedupe only the row. At minimum correct the comment.

3. MINOR - normalize_timezone is reported "applied" but does not re-arm the job.
   safe-fixes.ts updateTimezone writes only the DB. registry.registerInternal reads timezone at arm time (new Cron(..., {timezone})); an invalid-tz job was never armed, and the engine cannot import registry. Task stays unarmed until next boot (detector then re-proposes reregister_job). Fix: document in digest/applied text, or have the sender call registry.replace for applied normalize_timezone fixes.

4. MINOR - SKIP_FOREVER benign list omits real routine skip reasons.
   detectors.ts BENIGN_EXACT lacks 'daily_cost_cap', 'target_offline', 'no_online_supervisor', 'launch_pending' (all emitted by dispatcher/senders). A task skipping on the daily cap or an offline laptop N times gets a propose_disable proposal (warn). Proposal only, no write. Confirm against D-09 intent; add daily_cost_cap at least.

5. MINOR - NEVER_FIRED ignores schedule_rules gating.
   load.ts SELECT omits schedule_rules; registry arms rules via ruleToCron + shouldSkipFire (start_at, N-week anchoring, active window), which produce NO run row. A rule-gated task with zero runs older than 2 intervals yields 'no_runs' -> reregister_job proposal (false positive). Proposal only.

6. MINOR - digest mailed even when the in-pass kill-switch check reported halted.
   engine.ts gate() only blocks writes; sender still calls sendDigest. Window is a race after fireTask's own halt check; low impact.

## Verified clean (no finding)
- Detectors: __internal_* / enabled=false / task_qc / orchestrator / once excluded by isAuditable AND by SQL AND re-checked under FOR UPDATE in the writer. log_check 'skipped' never counts as FAILING; no_errors_detected benign. Columns used (next_fire_at, last_fire_at, finished_at, error, completed_at) all exist in schema.sql.
- Writer: KINDS frozen, kind check precedes runner use; three fixed UPDATEs, none touch enabled; in-flight refusal reads DB under row lock; no registry/dispatch/pipeline imports; no model turn, chain, session launch or token_usage path.
- Flag OFF true no-op: seed returns before any DB call; registry skips arming; catchup skips; fireTask early-returns before run claim; runNow also yields no run. Chain/post-run refuse task_qc both directions.
- Seed idempotent (partial unique index + ON CONFLICT); no backfill in schema.sql; CHECK drop/re-add pattern consistent.
- check-baseline: workflows-fanout ECONNREFUSED was caused by this branch (chain.ts now reads getTaskById); fixed in 08-10 by stubbing the DAL read. File passes 4/4 now; other chain/post-run suites pass. Baseline diff raises pass/total only; pass_min/skip_max/fail_max untouched; no .skip/.todo in new tests except gated flag-off/detectors helper usage. Minor: never-disables runs 6 tests vs 5 in the baseline note.

# PTYCAP-08 QC - Security / Blast-Radius lens (adversary)

Diff reviewed: ec2237e..HEAD -- hub/ (api, dispatcher, post-run, task-qc/*, sender, seed, schema). Static review; no test run needed for the finding below.

## Findings

1. MAJOR - PATCH on any non-task_qc task can set `task_type: 'task_qc'`, bypassing the create guard and the hourly cadence floor.
   - File: hub/src/api/scheduled-tasks.ts, PATCH handler non-qc path (~lines 545-650; `task_type: data.task_type` passed to updateTaskV2 at ~646). `TaskTypeEnum` now includes `task_qc` and `PatchSchema = CreateSchema.partial()`. The only task_qc guards are POST (line ~337, rejects create) and PATCH keyed on `existing.task_type === 'task_qc'` (line ~519). Nothing rejects `data.task_type === 'task_qc'` when the EXISTING row is another type. Tests (task-qc-api-guards.test.ts) only cover PATCH of an existing task_qc row.
   - Exploit: authenticated user (or compromised api key) PATCHes own task `{task_type:'task_qc', cron_expr:'* * * * *'}`. validateTaskQcCadence is never run on this path, so the row becomes a task_qc firing every minute (engine pass up to 60s of bounded DB reads + lifetime-counter reservation per run), contradicts the "system-owned, seeded only" invariant (F2-B5/D-25), and the row is then undeletable (DELETE returns 409). A second conversion violates idx_scheduled_tasks_task_qc_unique and surfaces as an unhandled 500. The converted row also keeps its stale prompt/payload/post_run_actions (inert only because the qc branch ignores them), and the auto-name path is invoked with task_type task_qc. No model spend (task_qc branch is deterministic), so not CRITICAL, but it defeats the P-08 cadence floor ("never faster than hourly", the 2026-07-11 tick-loop guard) and the create-rejection contract.
   - Fix: in PATCH, before the non-qc path, `if (data.task_type === 'task_qc') return 400 { error: 'task_qc_machine_seeded' }`. Add a test for a non-qc existing row.

## Verified OK (no finding)

- (a) task_qc row mutation: PATCH restricted to enabled/cron_expr/timezone with cadence validation; DELETE 409; POST rejected; run-now allowed only as plain manual (runNow refuses triggeredByRunId/chainDepth); post-run actions and email summary suppressed for task_qc (post-run/dispatcher.ts); chain parent and child refused (chain.ts); routeToSender misroute finalizes skipped. No path found to repurpose into a model-spending task other than finding 1 (which still never spends).
- (b) Digest injection: all free text via safeText + HTML escape; ids validated by SAFE_ID before commands; fixed templates; sqlLiteral quoting; ASCII-only; recipient is the owner's own users.email; no header-controlled fields (subject built from counts only).
- (c) No recursion: task_qc terminal in chain/post-run/runNow.
- (d) Kill switch: fireTask kill-switch precedes the qc branch; engine fix gate calls haltBeforeMachineSend (fresh, user-anchored, fail-closed; autofix throws halt_check_required without it). Flag OFF = early no-op.
- (e) Tenant scoping: every query in load.ts, safe-fixes.ts (SELECT FOR UPDATE and UPDATEs by id AND user_id), sibling/live-session lookups, seed, findings is user_id-scoped.
- (f) Bounds: LIMIT maxAuditedTasks+1, ROW_NUMBER window per task, statement_timeout, rows-written and fix caps, digest caps (200 findings / 100k chars).
- (g) Dispatch: task_qc branch bypasses quota/cost gates deliberately because it spends zero tokens; imports no dispatch/agent sender.
- Fix allowlist is frozen and the three UPDATE templates never touch `enabled`. E4A path uses the shared sendEmail helper (not changed in this diff; from_inbox_id handled there).

## Minor notes (non-blocking)

- Halt check is cached for the whole pass (up to 60s, 25 fixes); a kill switch engaged mid-pass is not seen until the next run. Acceptable given bounds.

## Verdict: CONTENT-BLOCK (1 MAJOR)

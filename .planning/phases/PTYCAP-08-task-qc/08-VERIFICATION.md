# Phase 8 (PTYCAP-08 Periodic Task QC) - Verification

Verifier: independent goal-backward pass. Branch `phase-ptycap-08-task-qc` (PR #513 draft), HEAD e84fed3 at start.
Method: source grep + each test file run in its own `bun test` process (hub/). SUMMARY claims not relied on.

## Ship verdict: SHIP-WITH-OPEN-ITEMS

All five ROADMAP success criteria and all fork-panel amendments are delivered in code and proven by
passing tests. One QC-confirmed MAJOR (whole-run deadline not hard in the sender) is OPEN and was
independently re-confirmed in the source. The feature is flag-gated default OFF (no seed, no registry,
no catchup, no run insert), so merging the OFF code is safe; **the open MAJOR is a hard precondition
for arming `REMO_TASK_QC_ENABLED`**. Note the /qc gate itself reads BLOCKED (2-round cap hit); the
orchestrator owns the decision to merge versus fix first.

## Test evidence (each file its own process, hub/)

- 31 `test/task-qc-*.test.ts` files: every one 0 fail (e.g. api-guards 38, detectors 61, safe-fixes 55,
  load 23, proposals 22, digest-escape 19, tracer 15, engine 14, flag-off 11, terminal 8, never-disables 6).
- Phase 4 pins: token-cap-coverage 3/0, kill-switch-coverage 10/0, reserve-caller-guard 9/0,
  counter-key-assignment-guard 5/0, scheduler-halt 12/0, scheduler 49/0 - all 0 fail.
- Real-Postgres proofs: `test/e2e/task-qc-checks.ts` is invoked from `orchestrator-tokencap.e2e.test.ts`
  (0 pass / 5 skip locally) and `schema-double-apply.e2e.test.ts` (0 pass / 10 skip locally). Skipped
  without `REMO_E2E_DB_URL`; they run in Woodpecker qc (postgres:16). => PARTIAL (CI-pending) for the
  items marked "PG-only" below.
- NOT run by me: `bun run check-baseline` (full suite) and `tsc`. The QC record claims check-baseline
  pass 3165 / fail 0 and the 08-10 SUMMARY claims tsc 427 = pre-phase 427; both are unverified here.

## Success criteria

| SC | Verdict | Evidence |
|---|---|---|
| SC1 six detectors classify without writing | PASS | `hub/src/task-qc/types.ts:8-13` enumerates FAILING/SKIP_FOREVER/NEVER_FIRED/MISCONFIGURED/DEAD_SESSION/OPTIMIZE; `detectors.ts:131,158,209,259,284,345` implement them, `runDetectors` `:428` composes them as pure functions. `task-qc-detectors-purity.test.ts` 2/0 (purity), `task-qc-detectors.test.ts` 61/0 incl. real log_check payload fixture. Reads only via `load.ts`; zero UPDATE/INSERT in detectors. |
| SC2 literal allowlist; writer rejects unlisted kind | PASS | `safe-fixes.ts:26` frozen `KINDS` = normalize_timezone / backfill_payload_from_sibling / rebind_dead_session; `:32` `SAFE_FIXES` frozen set; `:48` `UnlistedFixKindError`; `:175` kind check is the first statement of `applyFix`. Guard: `task-qc-safe-fixes.test.ts` 55/0 (unlisted fix throws, add() rejected). |
| SC3 never auto-disables / never mutates in-flight / no dev loop, no model spend | PASS | Never-disables: no allowlisted kind touches `enabled`; `load.ts:89`/`seed.ts:43` only read `enabled = true`; FAILING is always a proposal (`detectors.ts:131`); `task-qc-never-disables.test.ts` 6/0 (static grep guard + 500-failure fixture stays enabled). In-flight: `safe-fixes.ts:191-230` row `FOR UPDATE`, DB-truth open-run probe on the task and on the shared session, returns `skipped_in_flight`; `task-qc-in-flight.test.ts` 9/0. No model: closed import set over `src/task-qc/*` (no dispatch/pipeline, inject, task-macros, senders/agent; grep confirms); `task-qc-no-llm-guard.test.ts` 8/0; `task-qc-terminal.test.ts` 8/0 (no user_message, dispatch, launch, chain, token_usage). Bounded by `flags.ts` frozen `TASK_QC_BOUNDS` and the Phase 4 lifetime counter (`senders/task-qc.ts` `reserveInject`; `task-qc-counter.test.ts` 12/0). Row-lock atomicity under real concurrency is PG-only (CI-pending). |
| SC4 one digest, proposal per non-fixed finding | PASS (note) | `digest.ts:276-284` `deliverDigest` is one `sendEmail` per call, null digest (zero findings) sends nothing; `:91-146` fixed template per proposal kind; engine turns every non-applied finding into a typed proposal (`fix-plans.ts:42`, `engine.ts:248`). `task-qc-proposals.test.ts` 22/0 (one email, zero writes), `task-qc-digest-escape.test.ts` 19/0. Note: render cap `MAX_FINDINGS_RENDERED=200` / `MAX_BODY_CHARS=100000` (`digest.ts:37-38`); overflow findings stay unmarked and are re-reported next run, with an explicit "not shown" line. Acceptable, not a loss. |
| SC5 flag OFF true no-op; empty allowlist => report-only | PASS (PG parts CI-pending) | Flag OFF: `dispatcher.ts:251` early return before any run insert, `registry.ts:85` never armed, `catchup.ts:92` excluded, seed gated (`seed.ts`); `task-qc-flag-off.test.ts` 11/0, `task-qc-run-insert-untouched.test.ts` 2/0, `task-qc-boot-order.test.ts` 4/0. Report-only: `REMO_TASK_QC_AUTOFIX` default OFF and inert without ENABLED (`flags.ts` `isTaskQcAutofixEnabled`); `fix-plans.ts:42` turns every would-be fix into a proposal with `would_fix` evidence; the allowlist itself is a non-empty code constant, so the ROADMAP phrase "empty allowlist" is realized as AUTOFIX-off per SPEC TQC-08 (interpretation, accepted by the SPEC). Row-for-row report-only snapshot is PG-only (CI-pending). |

## Fork-panel amendments (GATES/verdict.md)

| # | Amendment | Verdict | Evidence |
|---|---|---|---|
| F1-1 | Rewrite SPEC TQC-07 and the 09-SPEC inherited table (drop REMO_TASK_QC_TOKEN_CAP) in this PR | PASS | 09-SPEC inherited table (`09-SPEC.md:169-170`) now lists only `REMO_TASK_QC_ENABLED`; 08-SPEC `:175` states superseded; remaining mentions are historical/explanatory (CONTEXT, FORKS, CLAUDE.md:308). `task-qc-spec-supersession.test.ts` 10/0. |
| F1-2 | task_qc terminal: suppress generic post-run + legacy chaining, even with malformed DB data | PASS | `post-run/dispatcher.ts:170-177,313` `suppressTaskQc`; `post-run/chain.ts:32-41` refuses task_qc as parent or child; `dispatcher.ts:195` refuses chained task_qc fire; `:776` `task_qc_not_routable`. `task-qc-terminal.test.ts` 8/0. |
| F1-3 | Deterministic bounds replace the token bound | PASS | `flags.ts` `TASK_QC_BOUNDS` frozen (500 tasks, 50 runs/task, 25 fixes/pass, 200 rows/run, 60s) + `clampBounds` can only lower; engine arms per-tx `statement_timeout` via deadline armer (`engine.ts:90-94`). `task-qc-bounds.test.ts` 9/0, `task-qc-deadline.test.ts` 12/0. See open item 1 for the sender-side gap. |
| F1-4 | Pure `runTaskQcPass(scope)`; scope can only narrow | PASS | `engine.ts:79` export; scope intersected `:106-113`; `task-qc-engine-scope.test.ts` 9/0. |
| F1-5 | Digest built only from typed fields | PASS | `digest.ts:3-6` header + enum/validated-id rendering; `task-qc-digest-escape.test.ts` 19/0. |
| F1-6 | Remove stale "cost is unmeasurable" rationale | PASS | grep for "unmeasurable" over `hub/src` and `08-SPEC.md` returns nothing. |
| F2-1 | Dedicated task_qc branch after kill switch, before quota/cost/targets; flag checked before insert; atomic single-open-run claim; null-session run; fire timestamps; finalize; return | PASS | `dispatcher.ts:244-262` kill switch, `:298-357` branch precedes quota gate (`:360`); `run-claim.ts` advisory lock + open-run probe + NULL-session insert; `updateFireTimestamps` + `finalizeRun` (`senders/task-qc.ts`); `task-qc-fire-branch.test.ts` 10/0, `task-qc-tracer.test.ts` 15/0. Atomic claim under real PG concurrency: PG-only (CI-pending). |
| F2-2 | Verify session_id nullability; document the path | PASS | `schema.sql:280` `scheduled_tasks.session_id DROP NOT NULL`; `scheduled_task_runs.session_id` nullable `ON DELETE SET NULL` (`schema.sql:459`); run-claim inserts NULL. No deletable-session anchor. `task-qc-schema.test.ts` 8/0 (real PG binding check is PG-only). |
| F2-3 | Seed before registry.loadAll + catchup; flag OFF excludes from registry and catchup; armed callback returns before inserting a run | PASS | `index.ts:752-754` seed precedes load; `registry.ts:85`, `catchup.ts:92`, `dispatcher.ts:251`; `task-qc-boot-order.test.ts` 4/0, `task-qc-seed.test.ts` 11/0, `task-qc-flag-off.test.ts` 11/0. |
| F2-4 | CHECK constraint add; enum-sync test across carriers | PASS | `schema.sql:205-231` includes `'task_qc'`; per-user partial unique index `:299`; `auto-name.ts:23,70`, `api/scheduled-tasks.ts:63`; `task-qc-enum-sync.test.ts` 8/0. Constraint re-apply on real PG: PG-only (CI-pending, `schema-double-apply.e2e`). |
| F2-5 | System-owned row: PATCH/DELETE reject immutable fields and deletion; allow enable/disable + validated cadence/timezone | PASS | `api/scheduled-tasks.ts:336-338` POST refused, `:501-540` PATCH allowlist + `validateTaskQcCadence`, `:518` conversion to task_qc refused, `:678` DELETE 409. `task-qc-api-guards.test.ts` 38/0. |
| F2-6 | Session-scope halt must not silently stop QC without a pinning test; hub kill switch does stop it | PASS | `task-qc-halt-scope.test.ts` 7/0; user-anchor `haltCheck` in sender (`haltBeforeMachineSend`); `scheduler-halt` 12/0. |
| F2-7 | `__internal_*` rows (enabled=false) never flagged or fixed | PASS | `detectors.ts:112-118` `isAuditable` excludes disabled, `task_qc`, `orchestrator`, `INTERNAL_PREFIX`, non-cron kinds; covered in `task-qc-detectors.test.ts`. |

## Open items

1. **OPEN MAJOR (QC/VERDICT.md, round 3 Codex) - CONFIRMED in source.** `hub/src/scheduler/senders/task-qc.ts`: `const deadline = Date.now() + clampBounds().passTimeoutMs` (~line 91) is created AFTER the recipient `SELECT` and the `reserveInject` lifetime reservation (~lines 71-82), and `markDelivered` (~line 59) computes `left` before `sql.begin`, so pool acquisition is unbounded and a late-acquired connection can still `UPDATE task_qc_findings` after the deadline. Effect: a run can stay open after the email, delaying `finalizeRun` and holding the one-open-run slot so later QC claims are dropped as `task_qc_already_running`. Fix: start the deadline at run claim, deadline-aware transaction acquisition, recompute remaining time inside the acquired callback and abort when expired. Reachable only with the flag ON. **Must be fixed before arming.**
2. agy QC seat was MISSING (contained disposable-copy path not set up); QC panel was Sonnet x2 + Codex only.
3. Postgres-only proofs (CHECK re-apply, partial unique index, NULL-session binding, row-for-row report-only snapshot, writer lock serialization, atomic claim) skip locally; pending Woodpecker qc on PR #513 => PARTIAL until CI is green.
4. Full-suite `check-baseline` and `tsc` not re-run by this verifier (claims from QC record / 08-10 SUMMARY only).
5. Doc nit: ROADMAP SC5 wording "empty allowlist" does not match the implemented control (AUTOFIX flag off); consider aligning the ROADMAP text to TQC-08.

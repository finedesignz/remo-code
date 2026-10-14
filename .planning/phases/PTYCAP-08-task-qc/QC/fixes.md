# PTYCAP-08 QC - Round 1 fixes

Branch phase-ptycap-08-task-qc. Every touched test file run in its own process (`bun test <file>`): all task-qc-*, token-cap-coverage, counter-key-assignment-guard, workflows-fanout, scheduler: 0 fail. schema-lint OK. Flag-OFF no-op, report-only default, task-qc-no-llm-guard, task-qc-never-disables unchanged and green.

## Round 1 fixes

| # | Finding | Commit | Test |
|---|---------|--------|------|
| 1 | MAJOR (codex, correctness, adversary): PATCH converts a user task to task_qc | bace778 | task-qc-api-guards.test.ts "PATCH cannot convert another task into task_qc" (4 red-first cases: plain flip, sub-hour cadence, once schedule, free fields; plus real-row and non-qc type-change controls). 400 task_qc_machine_seeded before any write/re-arm. DAL-level guard not added (API guard + unique index suffice; smallest diff). |
| 2 | codex MAJOR 2: wall-clock bound not hard | dc5b84f | task-qc-deadline.test.ts (new, 7 tests): arm precedes the advisory lock and every read statement; fix tx arms first; DB cancel (57014/55P03) of a fix / proposal insert / lookup ends the pass truncated with an unpersisted `deadline` proposal and no throw; ordinary errors still propagate; a never-answering resolver cannot hold the pass past its deadline. task-qc-bounds / task-qc-load updated (re-armed per statement). |
| 3 | codex MAJOR 3: TOCTOU on shared-session in-flight check | dc5b84f | task-qc-in-flight.test.ts (lock after row lock, before probes and the UPDATE, one tx; held on refusal; none without a session); task-qc-schema.test.ts (trigger + identical key). Fix: advisory lock `taskqc-session:<sid>` in the writer + BEFORE INSERT trigger on scheduled_task_runs taking the same lock (CREATE OR REPLACE, schema-lint pragma). Row lock changed to FOR NO KEY UPDATE so it cannot deadlock with the FK key-share of a concurrent run insert. |
| 4a | correctness MINOR 2: digest loses findings on failed send / same-day rerun; wrong comment | 3bdd982 | task-qc-tracer.test.ts "digest delivery marks findings" (4 tests), task-qc-schema.test.ts (digest_sent_at). `task_qc_findings.digest_sent_at` (additive); proposals re-reported until a delivered digest marks them. Sender comment corrected. |
| 4b | correctness MINOR 3: normalize_timezone not re-armed | 960d8b6 | task-qc-proposals.test.ts: reclassified/documented in the digest (applied block says re-armed at next restart or edit). Engine cannot import registry (closed import allowlist). |
| 4c | correctness MINOR 4: SKIP_FOREVER benign list | 308cd9b | task-qc-detectors.test.ts: target_offline, no_online_supervisor, launch_pending, daily_cost_cap and over_daily_cost_cap prefix. over_daily_token_cap NOT added: task-qc-flags hygiene test forbids any token-cap string in hub/src/task-qc. |
| 4d | correctness MINOR 6: digest after mid-pass halt | 3bdd982 | Documented explicitly in the sender comment (digest is read-only; engine gates its writes). |

## Notes / not done

- Fix 2 and 3 share commit dc5b84f (overlapping hunks in safe-fixes.ts, engine.ts, schema.sql).
- Lock-race and trigger SQL are verified statically and over the strict fake only. No live Postgres was available (no DB access by rule); schema-double-apply e2e is skipped without REMO_E2E_DB_URL. A real-Postgres barrier test (race run insert vs applyFix) is still owed for CI.
- Red-first order was followed for fix 1 (4 failing, then green). Fixes 2-4 had implementation written before the new tests (ordering assertions would fail against the old code by construction).
- Not addressed (outside the requested set): codex MINOR 4 (120-char reason truncation), MINOR 5 (DEAD_SESSION rollback guard on target-only rows), MINOR 6 (history bound before status filter), correctness MINOR 5 (NEVER_FIRED ignores schedule_rules).
- Commits use trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` as instructed.

## Round 2 fixes

Sources: QC/round2-codex.md (authoritative), QC/round2-sonnet.md. Each touched or new test file was run in its own process (`bun test <file>`): all `task-qc-*`, token-cap-coverage, counter-key-assignment-guard, schema-sql-lint, scheduler, workflows-fanout: 0 fail. Flag-OFF no-op, report-only default, task-qc-no-llm-guard, task-qc-never-disables, schema-lint green. No live Postgres (rule); the real-Postgres barrier test is still owed to CI.

| # | Finding | Commit | Test |
|---|---------|--------|------|
| 1 | codex new MAJOR 1: unconditional INSERT trigger breaks flag-OFF true no-op | 12bf0b1 | task-qc-run-insert-untouched (new: insertRunV2 statement pinned byte-for-byte, one statement, no lock/begin; no trigger/advisory text in the run-insert sources; schema attaches nothing to scheduled_task_runs), task-qc-schema (no CREATE TRIGGER/FUNCTION, idempotent DROP of the retired pair guarded by a pg_trigger existence check so a converged boot takes no lock). Design: trigger removed; atomicity moved wholly to the writer. |
| 2 | codex new MAJOR 2: null-session own-run race after FOR NO KEY UPDATE | 12bf0b1 | task-qc-in-flight (task row locked `FOR UPDATE`, never NO KEY; null-session path asserted separately; sessions row locked `FOR UPDATE` after the task row and before probes/write; no advisory lock). Run inserts take FOR KEY SHARE on the task row (task_id FK) and on the sessions row (session_id FK, non-null only), both conflicting with FOR UPDATE, so every open-run creation path is serialised with zero change to the insert. Lock order task then session; an insert holds only key-shares so no cycle. |
| 3 | codex MAJOR 2 (NOT-FIXED): deadline not hard | f894853 | task-qc-deadline (5 new, slow-fake based, red on the old code): slow pool for the read and the fix transaction returns on time and late callbacks issue nothing; every fix statement preceded by its own SET LOCAL; deadline between UPDATE and audit insert rolls the fix back whole; never-answering haltCheck cannot hold the pass and is treated as not cleared to write. task-qc-tracer: email request capped to time left, delivery mark in a timeout-armed tx, no email/mark once the run deadline passed. `boundedBegin` races only connection ACQUISITION (the callback re-checks and rolls back before any statement), never an in-flight write tx. `sendEmail` gained `timeoutMs`. `task-qc-no-llm-guard` allowlist gained the pure `task-qc/flags.ts` import for the sender. |
| 4 | codex new MAJOR 3: truncated digest marks never-shown findings delivered | 462df42 | task-qc-tracer "size-cut digest marks the shown rows" (150 long tasks: marked ids == rendered blocks < recorded). buildDigest returns `shown`; engine returns `recorded: {finding,id}[]` (replaces `recordedIds`); `deliverDigest` added, `sendDigest` kept. |
| 5a | codex MINOR 5: target-only dead-session rollback no-op | d2cdd31 | task-qc-proposals / task-qc-digest-escape: command rewrites whichever of session_id/target_id holds the stale id and matches on either. |
| 5b | codex MINOR 4: long skip reasons collapse | 5e4b41c | task-qc-detectors: reasons differing past 120 chars no longer group; evidence stays truncated. |
| 5c | codex MINOR 6: ignored runs consume the history bound | 5e4b41c | task-qc-detectors (cancelled/in_flight/pending ahead of failures do not hide the streak), task-qc-load (counted and ignored statuses ranked in separate partitions, so the ignored partition still feeds NEVER_FIRED). |

### Notes

- sonnet MINOR "dead 55P03 branch": not changed (harmless; lock_not_available is a legitimate cancellation class).
- sonnet MINOR flag-OFF wording: superseded by fix 1 (the claim is now literally true).
- Still owed to CI (no DB access here): real-Postgres barrier test for the writer's task/session row locks against a concurrent run insert (session-bound and NULL-session).

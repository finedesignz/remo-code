---
phase: PTYCAP-08-task-qc
plan: 07
subsystem: scheduler
tags: [task-qc, digest, lifetime-counter, kill-switch, engine-failure, guards, tdd]
status: complete
requires: [PTYCAP-08-03, PTYCAP-08-04, PTYCAP-08-06]
provides:
  - hub/src/task-qc/digest.ts (buildDigest, sendDigest: typed fields, fixed command templates, escaping, caps)
  - hub/src/scheduler/senders/task-qc.ts (taskqc:<userId> reserve/release, injected halt check, ENGINE failure email, finalize)
  - pins for the new reserveInject caller and the taskqc: key family
affects: [PTYCAP-08-08, PTYCAP-08-09]
requirements: [TQC-05, SC4, F1-A5, F2-B6]
plan_head_before: 98f6ceaf984e5079a99f586e5bd9209b4939f347
actuals:
  tokens: 30000
  tasks: 3
  commits: 5
key-files:
  created:
    - hub/test/task-qc-proposals.test.ts
    - hub/test/task-qc-digest-escape.test.ts
    - hub/test/task-qc-counter.test.ts
    - hub/test/task-qc-engine-failure.test.ts
  modified:
    - hub/src/task-qc/digest.ts
    - hub/src/scheduler/senders/task-qc.ts
    - hub/test/reserve-caller-guard.test.ts
    - hub/test/counter-key-assignment-guard.test.ts
    - hub/test/task-qc-no-llm-guard.test.ts
    - hub/test/task-qc-never-disables.test.ts
    - hub/test/fixtures/task-qc-fire-harness.ts
key-decisions:
  - "Digest source is applied fixes plus newly recorded proposals (the sender builds the view), not every open finding: the locked plan 03 tracer requires zero emails for an already-recorded same-day finding"
  - "Applied fixes render first in the digest so a size cut can never hide a rollback; a rollback containing non-ASCII/control data is not rendered (it would be corrupted by ASCII folding) and points at task_qc_findings.rollback_sql instead"
  - "Kill-switch adapter calls haltBeforeMachineSend({ userId }) with no sessionId (null anchor): a session-scoped halt on an unrelated session cannot affect the auditor"
  - "Engine failure email: claimEngineFailure on (user, QC task id, UTC day); a failing claim sends nothing and is logged at error level; raw message goes to the error log only"
---

# Phase PTYCAP-08 Plan 07: Digest and sender hardening Summary

The auditor's two outward edges are now bounded and safe: the digest is built only from typed fields with fixed per-kind PATCH/UPDATE templates, separate text/HTML escaping and ASCII-only output, and the sender reserves one lifetime-counter slot per run under `taskqc:<userId>` before the engine, injects a user-anchored kill-switch check, and can never fail silently (one plain typed-code failure email per user per UTC day).

## Commits
- de9da73 feat: typed-field digest, fixed command templates, escaping, caps (Task 1)
- a6691a1 feat: sender lifetime counter, injected halt check, ENGINE failure email (Task 2)
- 007f137 test: reserve-caller and counter-key pins for the taskqc: family (Task 3)
- b10d96b test: digest.ts named as the text-only UPDATE renderer in the TQC-04 guard
- (5th) test: type the digest-escape callbacks
- this summary is committed separately

## Verification (each file in its own process, from hub/)
- task-qc-proposals 21 pass, task-qc-digest-escape 19 pass, task-qc-counter 12 pass, task-qc-engine-failure 13 pass
- Guards: reserve-caller-guard 9, counter-key-assignment-guard 5, session-start-senders-guard 7 (unchanged, no entry needed: the QC sender has no session.start literal), token-cap-coverage 3, scheduler-counter-keys 8, scheduler-halt 12, kill-switch-coverage 10
- Plan 03 tracer unchanged and green (7 pass, test file untouched); fire-branch 10, terminal 8, no-llm-guard 8, never-disables 6, plus every other task-qc-* suite green
- `git grep -e inbox_id` over hub/src/task-qc and the sender prints nothing
- tsc: no error in any file this plan touched
- Hostile-input suite: 12 per-class tests plus forged-header, SQL-quote, hostile-id, rollback-with-non-ASCII, nested-evidence tests; asserts characters 9/10/32-126 on subject, text and html

## Deviations from Plan
- [Rule 3 - Blocking] Digest source. Plan: "digest only when findings exist" and `buildDigest(result)`. The locked tracer test (must pass unchanged) requires zero emails when the finding row already exists. The sender therefore passes `findings = applied findings + result.proposals` (newly recorded), while `buildDigest` itself follows the plan (null on empty findings). This is the A-07 follow-up plan 06 flagged; the tracer expectation is not revisited here.
- [Rule 3 - Blocking] `task-qc-no-llm-guard.test.ts` closed allowlist extended deliberately: digest.ts gains `../lib/email.ts` and `./safe-fixes.ts` (sendDigest and sqlLiteral, both named by the plan); the sender gains `findings.ts` and `types.ts`. File not listed in the plan's files_modified.
- [Rule 3 - Blocking] `task-qc-never-disables.test.ts`: the TQC-04 writer scans found `UPDATE scheduled_tasks` text in digest.ts (owner-runnable command templates, never executed). digest.ts is now the single named text-only exemption from the two writer scans, with a new pin (no db import, no sql tag, UPDATE text never mentions the on/off column, still scanned by the on/off-column test). No assertion removed. File not listed in the plan's files_modified.
- [Rule 3] `fixtures/task-qc-fire-harness.ts` (additive): the harness's controls mock gained `reserveInject` (recorded, configurable result) and a `haltBeforeMachineSend` that honours `h.halt`.
- [Process] digest and sender implementations were verified RED first (all new suites failed before the code); Task 3 tests were written alongside the guard entries.
- The plan's "Applied automatically" heading renders as the column-0 header `APPLIED AUTOMATICALLY (n)`; data lines are always indented so no data can forge a header.
- The counter-key family pin names three `taskqc:` spellers: the sender (ledger key) and the two advisory-lock names in run-claim.ts and load.ts (lock identities, not counter keys).

## Known Stubs
None. REPLACE_WITH_* tokens in rendered commands are intentional owner-choice placeholders (new cron, timezone, application uuid, repo ident, live session id).

## Threat Flags
None beyond the plan's threat model (T-08-32..37 mitigated and covered by tests).

## Self-Check: PASSED

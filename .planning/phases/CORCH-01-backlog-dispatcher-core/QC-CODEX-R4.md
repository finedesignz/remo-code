# QC-CODEX-R4

Seat: Codex (codex exec, read-only by prompt, bypass sandbox flag). Model: as configured in codex CLI (not printed in a parseable header). Range reviewed: 317408d..b6a723a. HEAD before and after: b6a723a (unchanged); git status shows only pre-existing untracked .planning files.

VERDICT: PASS

Reviewed `317408d..b6a723a`.

1. **HIGH (R3): FIXED** - `hub/src/dispatch/pipeline.ts:442-479` checks exact hook identity before deleting the hook, updating run status, or releasing/promoting the queue. The regression at `hub/test/dispatch-release-closed-run.test.ts:100` verifies successor B retains its slot and finalization hook after cancelled A rejects; C queues behind B.

2. **MED (R3): FIXED** - `hub/src/corch/dispatcher.ts:692-699` resolves the DAL before the insert guard at `:668-669`. No dynamic-import await remains between that guard and calling DAL insertion. Tests at `hub/test/corch-gates.test.ts:782,807` verify cancellation during loading produces zero inserts/sends and a live run inserts/sends once. Already-ended runs remain idempotent through `hub/src/corch/store.ts:285-290` and `dispatcher.ts:332`.

**Non-CORCH impact:** No additional behavioral change or new defect found. While the original hook remains active, cleanup is unchanged. Behavior differs when release/finalization has already removed it, preventing duplicate cleanup and successor corruption. Reservation release remains token-scoped; shared sender defaults are unchanged.

Validation: **271 tests passed, zero failed**, across 15 isolated suites; diff whitespace check passed. PostgreSQL E2E not run. No files changed.

END-OF-REVIEW: yes (present)

Raw output: C:\Users\artic\AppData\Local\Temp\claude\fdec0d3bcd1acdef\2a36e0be-9bb9-40dd-aa7d-63031f1d90fb\scratchpad\qc-corch01-r4-out.txt

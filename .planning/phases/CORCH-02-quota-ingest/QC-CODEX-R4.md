# QC-CODEX-R4

- Seat: Codex (external, read-only intent; run with bypass flag per brief), via `codex exec`
- Model: not reported in output (Codex CLI default)
- Range reviewed: 6bf7e36..HEAD (HEAD 8d9e954, unchanged before/after; git status clean)
- END-OF-REVIEW present: yes
- Raw output: scratchpad qc-corch02-r4-out.txt

## Verdict (verbatim)

VERDICT: CONTENT BLOCK

R3 #1 (MED): **FIXED.** `hub/src/corch/dispatcher.ts:328` caps quota-refusal deadlines at `min(earliestEligibleAt, now + 600s)`. The regression at `hub/test/e2e/corch-quota.e2e.test.ts:390` includes the previously missing intervening quota refusal.

R3 #2 (MED): **FIXED.** `hub/src/corch/quota-store.ts:66` permits replacement of stored timestamps beyond server time +120 seconds. The regression at `hub/test/e2e/corch-quota.e2e.test.ts:453` seeds a poisoned 2099 row and verifies replacement and block clearing.

1. **MED** - Recovery can still leave an item held for five hours.
   `hub/src/corch/dispatcher.ts:397` retains the five-hour item hold when `markDeath` fails/returns null or `runContext` throws. A subsequent healthy snapshot triggers evaluation but does not clear that deadline; `hub/src/corch/store.ts:252` excludes the item. Reproduction: death -> transient block-write failure -> successful requeue -> healthy snapshot -> item remains unavailable beyond 600 seconds. This is pre-existing fallback behavior, not introduced by this diff. Tests at `hub/test/corch-quota-death.test.ts:203` verify the long hold but omit recovery afterward.

2. **LOW** - Recovery test does not prove automatic redispatch.
   `hub/test/e2e/corch-quota.e2e.test.ts:422` disables timers; lines 449-450 manually advance the deadline and call `claimNext`. It proves reclaimability, not timer-driven recovery.

No additional unintended fail-open path identified. Unknown 5h quota explicitly permits one run when 7d is known and below ceiling (`hub/src/corch/quota-eligibility.ts:88`); therefore blanket "unknown quota always refuses" is not true under the existing policy.

Validation: 136 tests passed, six individual files; PostgreSQL E2E inspected, not executed. HEAD 8d9e954; worktree unchanged.

END-OF-REVIEW

# QC-CODEX-R3 (CORCH-02 round 3)

Seat: Codex (codex exec, bypass-sandbox flag, read-only by prompt)
Model: gpt-6-astra
Range reviewed: f68df22..6bf7e36 (HEAD unchanged before/after; git status clean)
Tests: 135 passed across six individually run files; PostgreSQL E2E inspected, not executed.
VERDICT: CONTENT BLOCK
END-OF-REVIEW present: yes

## Findings (verbatim from Codex)

1. **MED - R2 #1: NOT FIXED completely. A subsequent quota refusal restores the long item hold.**
   `hub/src/corch/dispatcher.ts:386` correctly applies the 600-second backoff; null/undefined/throwing block writes now receive five hours. However, `hub/src/corch/dispatcher.ts:321-325` still copies `earliestEligibleAt` into the item's deadline.

   Reproduction: death -> fresh reading still over ceiling -> 600-second backoff expires -> quota refusal writes the future reset deadline -> healthy reading arrives before reset. Snapshot ingestion triggers evaluation, but `hub/src/corch/store.ts:252` excludes the item until that deadline. Account recovery therefore still need not release the work item.

   **Test gap:** `hub/test/e2e/corch-quota.e2e.test.ts:380-387` clears quota *before* advancing the backoff and calls `claimNext` directly. It misses the intervening refusal. Add recovery coverage through that second refusal; distinguish a quota wakeup deadline from an unconditional item hold.

2. **MED - R2 #2: FIXED for new ingestion; existing poisoned rows remain unrepaired.**
   `hub/src/api/quota.ts:120-125` rejects account and snapshot timestamps beyond server time +120 seconds before writing or evaluating. Boundary and rejection tests pass.

   Limitation: a previously stored 2099 timestamp still rejects genuine readings through `hub/src/corch/quota-store.ts:61-63`. The new E2E case rejects the future reading before storage; it does not demonstrate recovery of an already-poisoned row. This matters if the earlier implementation has ingested data.

3. **LOW - R2 #3: NOT FIXED end-to-end; acceptable residual under the stated fixed-token design, not HIGH.**
   `hub/src/corch/dispatcher.ts:543-549` now rejects a missing, changed, throwing, or unavailable current binding. However, `hub/src/dispatch/governed-launch.ts:168-191` awaits reservation and ledger operations afterward, and `hub/src/ws/supervisor-registry.ts:371-374` sends through the current connection without checking its account.

   With one fixed account token per supervisor container, ordinary reconnects preserve the binding, making this an acceptable documented operational constraint. It is not an enforced code invariant. The binding tests cover changes before resolution, not during those subsequent awaits.

4. **LOW - R2 #4: NOT FIXED; accepted publisher-trust residual.**
   `hub/src/corch/quota-store.ts:50-58` still accepts publisher-declared `source: 'live'` and `fetched_at > blocked_at` as clear provenance. Explicit `quota:publish` authorization and key-owner scoping constrain the effect. Assistant text alone cannot perform that clear.

The blocking recovery defect is finding 1. No additional newly introduced fail-open path was identified beyond the documented binding residual.

END-OF-REVIEW

Raw transcript: C:\Users\artic\AppData\Local\Temp\claude\fdec0d3bcd1acdef\2a36e0be-9bb9-40dd-aa7d-63031f1d90fb\scratchpad\qc-corch02-r3-out.txt

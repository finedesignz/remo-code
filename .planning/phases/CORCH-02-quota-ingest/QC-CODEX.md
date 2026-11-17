# CORCH-02 QC - Codex seat

- Seat: Codex (codex exec, read-only by brief; run with bypass flag, HEAD unchanged 77fe72a, no files modified by seat)
- Model: gpt-6-astra
- Diff: 0f12261..77fe72a
- END-OF-REVIEW present: yes
- VERDICT: CONTENT BLOCK

## Findings (verbatim)

1. **HIGH - Assistant-controlled text can block an account.**
   hub/src/corch/dispatcher.ts:390
   **Evidence:** `onFinalize` passes ordinary assistant content into `classifyQuotaDeath`, which directly triggers `markDeath`. A prompt injection requesting the exact response `Claude AI usage limit reached|1999999999` can impose a years-long account block. Whole-text anchoring does not establish trusted provenance.
   **Fix:** Require a structured, runner-originated quota-error signal distinct from generated text. Test identical text in normal assistant output versus authenticated runtime error events.

2. **HIGH - Selected quota account is not bound to the actual launch.**
   hub/src/corch/gates.ts:70
   **Evidence:** The gate reduces the selected account to `ok`; the provider returns `supervisor_id: null`. `launchSessionForUser` independently selects a supervisor by session hostname (`hub/src/telegram/launch.ts:170`). Thus eligible account A can authorize execution on supervisor B, whose account has missing or exhausted quota. A subsequent death also blocks recorded account A instead of actual account B.
   **Fix:** Bind selection, launch, and final dispatch to the same verified account/supervisor. Although targeting is deferred to CORCH-09, this phase must refuse dispatch when that binding cannot be established. Add a two-supervisor mismatch test.

3. **HIGH - Account capacity claim has a concurrent write-skew race.**
   hub/src/corch/quota-store.ts:92
   **Evidence:** Concurrent updates to different run rows can both observe account count zero and both claim capacity one. The advisory lock in `claimNext` ends with that earlier transaction, before account selection. With the user cap above one, overlapping evaluations can therefore overbook a null-5h account and pass pre-launch gating. Later dispatch rechecks do not make the original reservation atomic. The database test exercises sequential claims only.
   **Fix:** Serialize account capacity checks and assignment within one transaction using a shared account lock. Add a concurrent, two-connection PostgreSQL test.

4. **HIGH - Failed account blocking permits immediate redispatch.**
   hub/src/corch/dispatcher.ts:373
   **Evidence:** A failed `runContext` or `markDeath` is logged, then the run ends with no attempt consumed and `notBefore: null`. `afterRunEnd` immediately evaluates the user again. If subsequent database operations succeed, the unchanged, apparently eligible account can be selected again, repeating quota deaths without consuming the retry budget. The existing test explicitly accepts the failed-write behavior without checking redispatch.
   **Fix:** Persist account quarantine and run finalization atomically, or retain a durable fail-closed hold until blocking succeeds. Test transient block-write failure followed by successful reads.

5. **HIGH - A later death can shorten an existing block.**
   hub/src/corch/quota-store.ts:113
   **Evidence:** `markDeath` unconditionally replaces `blocked_until`. With multiple active runs, a weekly-limit death can establish a seven-day block, then a session-limit death replaces it with the earlier 5h reset. The account can become eligible before its known weekly reset.
   **Fix:** Preserve all outstanding window blocks, or conservatively retain the later deadline while preserving indefinite blocks. Test weekly/session deaths in both orders.

6. **MED - GET reports eligibility without enforcing the null-5h concurrency rule.**
   hub/src/api/quota.ts:151
   **Evidence:** GET calls `evaluateAccounts` without `busyByAccount`; missing counts default to zero. An account with unknown 5h usage and one live run therefore reports `eligible: true`, while the dispatch provider rejects it.
   **Fix:** Include user-scoped live account counts in GET evaluation and test an occupied null-5h account.

Validation: 107 tests passed across ingest, eligibility, selection, death, and flag-OFF files. PostgreSQL concurrency was not exercised. No files changed. No auth-scope bypass, cross-user quota query leak, or destructive DDL was found in the reviewed paths.

END-OF-REVIEW

Raw output: C:\Users\artic\AppData\Local\Temp\claude\fdec0d3bcd1acdef\2a36e0be-9bb9-40dd-aa7d-63031f1d90fb\scratchpad\qc-corch02-codex-out.txt

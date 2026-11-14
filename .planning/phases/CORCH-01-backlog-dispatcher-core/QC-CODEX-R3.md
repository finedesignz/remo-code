# QC-CODEX-R3 (final re-QC, delta ad5c461..317408d)

Seat: Codex (codex exec, read-only by brief, --dangerously-bypass-approvals-and-sandbox transport)
Model line: model: gpt-6-astra / provider: openai
HEAD before and after: 317408d (unchanged); git status: only pre-existing untracked .planning files.
END-OF-REVIEW present: yes

VERDICT: CONTENT BLOCK

1. **HIGH - Cancellation can corrupt a replacement dispatch's ownership.** `hub/src/corch/dispatcher.ts:525`; `hub/src/dispatch/pipeline.ts:459,469`.
   Reclaim releases the old hook and promotes a waiter through `releaseClosedRunByToken`. When the paused old dispatch resumes, its new cancellation guard throws. The pipeline catch then **unconditionally deletes the session's current hook and releases its queue slot**, even if the promoted run now owns both. That run loses finalization tracking, and another prompt can overlap it. Cleanup must check token ownership. Add a regression with a queued successor that starts before the cancelled dispatch resumes.

2. **MED - An await remains between the insert guard and the actual insertion.** `hub/src/corch/dispatcher.ts:667-669`; `hub/src/heal/sinks/shared.ts:23`.
   `guard.assertLive()` calls `base.insertMessage`, whose real implementation first executes `await import('../../db/dal.ts')`. Cancellation can occur during that await; afterward, the DAL inserts the message without rechecking. The socket guard prevents transmission, but cancelled prompts can still enter history, contradicting `docs/corch.md:130`. Resolve the DAL before the final insert guard. The new E2E pauses before entering the sender, so it misses this boundary.

Positive: the actual socket boundary has no intervening await (`dispatcher.ts:660-661`). Refusal, failure, finalization, and reclaim synchronously remove sendable tokens before their first await, including refusal's delegated call. No separate token-cleanup leak or flag-OFF regression found. Baseline increase matches one added DB-gated test; existing guard assertions not weakened.

Validation: 164 tests passed, zero failed, across 13 suites; diff whitespace check passed. PostgreSQL E2E not run. No files changed.

END-OF-REVIEW

Raw output: C:\Users\artic\AppData\Local\Temp\claude\fdec0d3bcd1acdef\2a36e0be-9bb9-40dd-aa7d-63031f1d90fb\scratchpad\qc-corch01-r3-out.txt

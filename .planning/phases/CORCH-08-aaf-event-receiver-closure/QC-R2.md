# QC-R2 (Codex, external seat responded) - verdict QC-FAIL

Diff: phase-corch-04-gsd-console-ingestion...c3536af. Raw Codex output:

1. **MED — `hub/src/corch/aaf-events.ts:124` — A fresh notification claim can permanently lose delivery.** If the process crashes after claiming `sending` but before notifying, a retry within five minutes gets `null` from `claimAafNotify` and returns 200. The sender stops retrying; no background worker reclaims the notification. Distinguish “already delivered” from “currently claimed” and return 503 for unfinished delivery. Tests cover stale claims directly, but miss this HTTP retry scenario.

2. **MED — `hub/src/corch/store.ts:349` — Closure still permits a send already past its database liveness check.** After `markDispatched` succeeds, dispatch awaits the final halt check, module loading, channel lookup, and message insertion before writing to the socket. An AAF closure during those awaits ends the database run but never clears the dispatcher's `sendable` guard. Consequently, the socket write can execute after the item becomes blocked or done. The existing closure test checks database gates, not closure during an in-flight send.

3. **MED — `hub/src/corch/store.ts:343` — The claimed run-before-item lock order has a phantom-run gap.** Suppose `claimNext` holds the queued item's lock and is creating its run. The closure's run query cannot see that uncommitted run, then waits for the item. Once claiming commits, closure acquires the item while `endRunAndRequeue` acquires the newly visible run. Closure's `endRuns` waits for that run; run-end waits for the item: deadlock. PostgreSQL aborts one transaction, potentially rolling back closure and allowing requeue until webhook retry. No concurrent claim/closure/run-end regression covers this ordering.

4. **MED — `hub/src/corch/aaf-events.ts:65` — Notification opt-outs cause permanent 503 retries.** For a user with both `email` and `telegram` disabled in `notify_channels`, `fanOutNotify` correctly returns no delivered channels. This adapter interprets intentional suppression as failure, resets the event to `pending`, and returns `notification_pending` on every duplicate indefinitely. Handle intentional suppression separately or persist an owner-visible notification without overriding preferences.

5. **MED — `hub/src/corch/store.ts:389` — Notification completion is not bound to its claim.** When a send exceeds five minutes, another request can reclaim it and send again. The original request can subsequently mark the replacement claim `sent` or reset it to `pending`, because completion checks only `event_id` and `sending`. This permits duplicate deliveries and overlapping retries. Use claim ownership fencing and delivery idempotency; current tests exercise neither overlapping stale claims nor late completion.

Validation: 72 non-e2e tests passed using the requested environment. Mount-order tests logged missing-table audit errors. No e2e tests ran; repository status remained unchanged.

QC-FAIL
## Resolution (commit 3676cca)
1. MED fresh sending claim => silent 200: FIXED. claimAafNotify returns claimed|busy|none; busy => 503 notification_pending. Unit 'a fresh claim held by another delivery is NOT a success', e2e stale/busy test.
2. MED in-flight send past liveness check: FIXED. applyAafEvent returns endedRunIds; route calls cancelRunSendsNow (dispatcher sendable.delete, the same synchronous cancel reclaimRun uses). Tests: unit cancel once, e2e 'closure ... cancels its in-process send guard'.
3. MED phantom-run deadlock: FIXED by one global lock order, item row first then run rows: lockItemOfRun in endRunAndRequeue and endRunMarkPrOpen, claimNext (already item then run insert), closure (item then runs, no run pre-lock). e2e 'no deadlock' races closure vs claimNext vs run end 12x, run 3x clean.
4. MED notification opt-out => permanent 503: FIXED. notifyFailed treats an owner who opted out of BOTH durable channels (applyChannelPrefs empty) as handled.
5. MED completion not bound to claim: FIXED. notify_claim_token (uuid) set at claim, finishAafNotify fenced by token. e2e 'claim fencing'.

# QC-R3 (Codex, external seat responded) - verdict QC-FAIL

Diff: phase-corch-04-gsd-console-ingestion...3676cca. Raw Codex output:

1. **MED — `hub/src/corch/aaf-events.ts:146,162` — Cancellation still permits dispatch after closure.** A send that already passed its database liveness check retains its `sendable` guard while the closure handler awaits notification delivery. If Telegram/email is slow, the pending socket write can execute after `pr.failed` committed the blocked item and ended run. Cancel the send guards immediately after the transition, before notification I/O.

2. **MED — `hub/src/corch/store.ts:405-407` — Overlapping retries can acknowledge an undelivered notification.** Request A owns `sending`; request B’s claim UPDATE returns no rows. A then fails delivery and resets the state to `pending` before B’s SELECT. B interprets `pending` as `none` and returns 200, allowing the sender to stop retrying despite zero deliveries. Treat both `pending` and `sending` as unfinished.

Validation: 323 non-e2e tests passed. No e2e tests ran. Repository status remained unchanged.

QC-FAIL
## Resolution
1. MED cancel after notification I/O: FIXED. cancelRunSends now runs immediately after the transition, before any notification I/O. Unit test asserts the guard is cancelled when notifyFailed is entered.
2. MED overlapping retries ack an undelivered notification: FIXED. claimAafNotify treats a 'pending' read after a lost claim race as busy (503); only none/sent are done. e2e covers the pending-after-release state.

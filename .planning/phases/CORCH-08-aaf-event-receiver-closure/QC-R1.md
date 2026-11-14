# QC-R1 (Codex, external seat responded) - verdict QC-FAIL

Diff: phase-corch-04-gsd-console-ingestion...5870e8c. Raw Codex output:

1. **MED — `hub/src/corch/aaf-events.ts:120` — Notification failures are permanently discarded.** The event and blocked transition commit before `notifyFailed` runs. If notification delivery fails—or the process crashes after commit—the receiver still acknowledges success or subsequently returns `duplicate` at line 117. Neither replay nor another failed event retries notification. The owner receives zero notifications, violating criterion 2. Persist notification intent transactionally and track delivery separately. Existing tests assert HTTP 200 on notifier failure but do not test recovery.

2. **MED — `hub/src/corch/store.ts:353` — Blocking an item does not invalidate its pending dispatch.** `applyAafEvent` changes the item but leaves its live run and dispatch cancellation guard intact. If a run is parked offline when `pr.closed` or `pr.failed` arrives, reconnect can dispatch its prompt afterward: `dispatcher.ts:513` checks only whether the run ended, `gates.ts:24` likewise checks only `ended_at`, and `markRunRunning` ignores item status. Thus automation can execute a blocked item. Closure must invalidate pending sends, with regression coverage for parked replay and closure during launch.

Validation: 25 receiver/provisioning tests passed. Mount-order tests failed during import with `JWT_SECRET must be at least 32 characters`; mount-order execution remains unverified. Database E2E tests were not run.

QC-FAIL
## Resolution (commit c3536af)
1. MED notification durability: FIXED. corch_events.notify_state (pending/sending/sent) persisted in the transition tx; atomic claim; undelivered => 503 notification_pending so the sender retries the same event_id (duplicate for the transition, retry for the notification). Tests: unit 'a failed notification is not lost', e2e 'a failed notification is durable', 'stale sending claim'.
2. MED closure does not invalidate pending dispatch: FIXED. done/blocked transitions end the item's live run in the same tx (end_reason aaf_pr_*), lock order run then item. Every dispatch gate and the parked-turn replay read corch_runs.ended_at. Test: e2e 'closure invalidates a pending send' (all three events; gate verdict corch_run_not_live; slot freed).
Note: the mount-order import failure in the Codex run was its own env (JWT_SECRET unset); mount-order passes 33/33 with the CI env.

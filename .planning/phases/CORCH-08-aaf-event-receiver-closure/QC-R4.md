# QC-R4 (Codex, external seat responded) - verdict QC-FAIL

Diff: phase-corch-04-gsd-console-ingestion...596c124. Raw Codex output:

1. **MED — `hub/src/corch/dispatcher.ts:733-735` — Closure leaves the session queue occupied.** Cancellation deletes only the send guard; it never calls `pipeline.releaseByToken`. If AAF closes a dispatched run whose agent remains connected but never sends its final reply, the active hook and queue slot remain indefinitely. CORCH reconciliation excludes the ended run, and the shared hook reaper skips CORCH’s store because it lacks `shouldFinalize`. Subsequent dispatches to that session remain queued.

2. **MED — `hub/src/corch/aaf-events.ts:152-156` — Notification delivery is still not idempotent.** If Telegram/email succeeds but `finishAafNotify` fails before recording `sent`, the receiver returns 503. After five minutes, retry reclaims `sending` and sends the notification again. No stable delivery idempotency key reaches the notifier. R2’s token fencing protects database updates, but does not fix duplicate delivery.

Validation: focused non-e2e tests passed; mount-order tests logged missing audit-table errors. No e2e tests ran. Repository status remained clean.

QC-FAIL
## Resolution
1. MED closure leaves the session queue occupied: FIXED. cancelRunSends now also calls pipeline.releaseByToken(buildCorchRunToken(id), 'aaf_closure') per run (what reclaimRun does), failures logged per run. e2e 'cancelRunSends releases the pipeline slot'.
2. MED notification not idempotent if the bookkeeping write fails after a successful send: ADJUDICATED by design, see QC-ADJUDICATION.md (partially mitigated: one immediate retry of the bookkeeping write).

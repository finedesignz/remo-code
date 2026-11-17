# Phase 7 /qc verdict - BLOCKED (1 open MAJOR after 2 fix rounds)

Seats: sonnet correctness lens, sonnet adversary lens, Codex read-only (cross-model). agy not run (contained disposable-copy path not set up this session; seat MISSING).

| Round | Sonnet | Codex | Result |
|---|---|---|---|
| 1 | correctness CONTENT-BLOCK (2 MAJOR), adversary CONTENT-BLOCK (1 MAJOR) | CONTENT-BLOCK (1 CRITICAL, 7 MAJOR) | fix rounds A+B |
| 2 | PASS (all 10 fixed) | all 8 FIXED, 5 new MAJOR | fix round 2 |
| 3 (final) | - | 5/5 FIXED, 2 new MAJOR | 1 type-only (fixed as build hygiene, b7e18fa), 1 BLOCKED |

## Open MAJOR (BLOCKED)

1. Crash-recovered scheduled-task launches can produce ZERO owner notifications (QC/round3-codex.md #1). After round-2 fix 5 the scheduler default email is the sole owner for scheduled-task heals; it is sent only after the awaited heal hook returns (hub/src/scheduler/dispatcher.ts ~812). A hub crash between the heal claim and that send leaves the event with no email, and the sweep is claim-only for scheduled tasks. Real fix: persist the pending default-email obligation (notification outbox row on the heal event) and have the sweep deliver it once.

Reachable only with REMO_HEAL_UNIFIED ON (default OFF; OFF = exact legacy behaviour, hub/test/heal-flag-off.test.ts).

## Fixed in rounds 1-2 (detail in fixes.md)
Coolify live-session bypass, own-reservation self-block at cap, one-notification ownership (claim-based) across sources, only_if_active misuse, error-capture event reconstruction in sweep, crash-recoverable autospawn_starting state, atomic per-repo/per-task ceilings (advisory xact lock), skip-permissions forced false for every heal spawn (incl. orchestrator sessions), PTY gate on heal list, strict release with sweep retry, sweep keeps events whose source terminalization failed, deferred error-capture notices, periodic follow-up sweep.

Type hygiene: tsc errors in phase files 64 -> 19 (the 19 pre-exist at ec2237e). check-baseline OK (pass 3271, skip 280, fail 0).

## Repair round (post-BLOCKED)

Open MAJOR (round3-codex #1) implemented as a durable owner-email outbox, commit 84787dd:
- heal_events gains owner_email JSONB, owner_email_claimed_at, owner_email_delivered_at (idempotent additive DDL, no backfill, partial index for pending rows).
- claimHealEvent writes the obligation in the SAME transaction as the claim (scheduled_task, only when the default failure email applies: dispatcher computes it via defaultFailureEmailApplies).
- Scheduler (healFailedRunHook) sends it through heal/owner-email.ts and marks delivered; default post-run email suppressed only when an obligation exists. Lease CAS (5 min) on claimed_at; delivered_at is the terminal flag. A heal outcome for such an event appends its reason to the obligation and never sends a second ownerless email.
- Heal sweep (boot + follow-up) redelivers every undelivered obligation once. REMO_HEAL_UNIFIED OFF: nothing new runs (hook returns before, sweep returns before); hub/test/heal-flag-off.test.ts unchanged, 133 pass.

Evidence: hub/test/heal-owner-email-outbox.test.ts 13 pass (crash between claim and send -> sweep sends exactly 1, second sweep 0; normal path exactly 1, sweep 0 after; scheduler/sweep race -> 1; failed send retried -> 1; mid-send crash honours lease; SQL pins). All hub/test/heal-*.test.ts and self-heal-routing individually 0 fail. check-baseline OK (pass 3284, skip 280, fail 0). tsc: no errors in touched files.

Codex read-only re-QC (QC/round4-codex.md): CONTENT-BLOCK, two NEW MAJORs, recorded NOT fixed per instruction:
1. Failed sends are retried only by the boot sweep and the single follow-up (50 rows per pass), and pruneHealEvents (heal-events-dal.ts ~114) can delete an undelivered obligation row -> permanent loss for a send failure after the follow-up sweep. Fix direction: exclude owner_email_delivered_at IS NULL obligations from prune; add a bounded periodic outbox sweep (event driven retry on send failure) or exponential-backoff re-attempt.
2. If hasObligation probe throws, deliverOwnerEmailForRun returns false -> legacy default email also sent, and the persisted obligation is later swept -> duplicate email. Fix direction: on probe error treat as obligation present (fail toward suppression) or decide from the claim result already in hand.

Ship verdict: still BLOCKED (draft PR #512 stays draft) until these two are fixed and re-QC'd.

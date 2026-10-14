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

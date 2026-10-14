# Phase 8 /qc verdict - BLOCKED (1 open MAJOR after 2 fix rounds)

Seats: sonnet correctness lens, sonnet adversary lens, Codex read-only (cross-model). agy not run (contained disposable-copy path not set up this session; seat MISSING).

| Round | Sonnet | Codex | Result |
|---|---|---|---|
| 1 | correctness CONTENT-BLOCK (1 MAJOR), adversary CONTENT-BLOCK (1 MAJOR, same) | CONTENT-BLOCK (3 MAJOR) | fix round 1 |
| 2 | PASS | 1 fixed, 1 not fixed, 3 new MAJOR | fix round 2 |
| 3 (final) | - | 6/6 FIXED, 1 new MAJOR | BLOCKED per 2-round cap |

## Open MAJOR (BLOCKED)

1. Whole-run deadline is not hard in the sender (QC/round3-codex.md): hub/src/scheduler/senders/task-qc.ts ~71/91 creates the deadline after the recipient query and lifetime reservation, and `markDelivered` computes the remaining time before `sql.begin`, so pool acquisition is unbounded and a late-acquired connection can still update findings after the deadline. Effect: the run can stay open after the email, delaying finalization and blocking later QC claims via the open-run slot. Real fix: start the deadline at run claim, use deadline-aware transaction acquisition, recompute remaining time inside the acquired callback and abort when expired.

Reachable only with the task-QC flag ON (default OFF; no seed, no registry/catchup load, ordinary run inserts unchanged). No model spend path exists (deterministic engine; guard tests).

## Fixed in rounds 1-2 (detail in fixes.md)
PATCH conversion to task_qc rejected; engine-pass deadline hard (SET LOCAL statement_timeout); shared-session and null-session in-flight races closed with writer-side row locks (global trigger removed, ordinary run-insert SQL unchanged); digest marks only rendered findings delivered and re-reports undelivered ones; benign skip reasons; dead-session rollback guards; history bound ignores ignored runs.

check-baseline: OK (pass 3165, skip 259, fail 0).

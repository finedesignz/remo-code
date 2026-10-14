# Phase 5 /qc verdict - BLOCKED (2 open MAJOR after 2 fix rounds)

Seats: sonnet correctness lens, sonnet adversary lens, Codex read-only (cross-model). agy not run (contained disposable-copy path not set up this session; seat MISSING).

| Round | Sonnet | Codex | Result |
|---|---|---|---|
| 1 | correctness PASS, adversary CONTENT-BLOCK (1 MAJOR) | CONTENT-BLOCK (2 CRITICAL, 4 MAJOR) | fix rounds A+B |
| 2 | PASS | CONTENT-BLOCK (4 not fixed, 2 new MAJOR) | fix round 2 |
| 3 (final) | - | CONTENT-BLOCK (2 MAJOR) | BLOCKED per 2-round cap |

## Open MAJOR (BLOCKED)

1. Budget attribution (codex #4): the durable detector compares aggregate counts (completed assistant turns vs token_usage rows since armed_at, hub/src/db/token-usage-dal.ts ~279-288). A turn whose usage row is lost can be masked by an extra usage row from another turn. Real fix: per-turn correlation (turn id carried on usage_event and token_usage) or a durable usage outbox keyed to the proof run.
2. Kill-switch ownership (codex new #2): arm refuses a pre-existing foreign session halt, but a MANUAL emergency engage made AFTER arm cannot be distinguished from the proof-owned row because the partial unique index permits one engaged session row (schema.sql ~1641); `--enable` could then release it. Real fix: allow multiple engaged rows per scope with owner tags (or a separate proof halt mechanism) so a manual engage is never released by proof code.

Both are reachable only when the owner has armed the proof (flags default OFF; arming is an owner GO/NO-GO gate). Neither weakens flag-OFF behaviour.

## Fixed in rounds 1-2 (summary; detail in fixes.md)
Exclusivity (global advisory lock), stale queued/in-flight prompts (proofRunId + send-boundary recheck under the arm/disarm lock), disarm ordering, dev-macro fallback under any flag combination, PR scope (fork + off-prefix + pagination), canonical repo identity, merge refusal fail-closed on null repoKey, unverified agent permission refused, bounded budgets, allowlist case-twin removal.

check-baseline: OK (pass 3169, skip 259, fail 0) on rerun; first run hit the known flaky transcript-adapter-codex timeout (AgentAutofix 74489ffe).

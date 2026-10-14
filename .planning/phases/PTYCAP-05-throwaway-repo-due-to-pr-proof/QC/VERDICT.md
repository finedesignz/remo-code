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

## Repair round (post-BLOCKED)

Commit 932c71b. Both Open MAJORs fixed at the root.

1. Budget attribution (codex #4): nullable additive `turn_id` on `messages` and `token_usage` (idempotent ADD COLUMN IF NOT EXISTS, no backfill). Supervisor `claude-runner` stamps one id on a turn's `assistant_message` and its `result`; `session-bridge` forwards it on `usage_event`; hub persists both. Chose this over a usage outbox: smaller, no new table. `sumSessionTokensSince` now anti-joins each completed assistant message (outside the 120s grace) to a `token_usage` row with the same (session_id, turn_id); aggregate counts removed. A message with no turn_id (older supervisor) fails closed. Regression: lost row masked by an extra row (dup turn, and a null-turn row) now detected; no-turn_id message fails closed; supervisor test proves message and result share a turn_id and turns differ.
2. Kill-switch ownership (codex new #2): session halt unique index is now `(session_id, engaged_by) WHERE scope='session' AND engaged` (DROP INDEX IF EXISTS old + CREATE IF NOT EXISTS new, no data mutation). Halt effective if ANY row engaged (existing read). A manual engage after arm is a separate row (`alreadyEngaged=false`); `--enable` releases only the proof row by id. Regression: manual engage after arm survives `--enable`.

Evidence: `bun test` touched files individually: orchestrator-proof-dal 48 pass, ptycap-usage-attribution-loss 7 pass, automation-schema 7 pass, supervisor claude-runner-turn-id/usage-capture/askuserquestion 8 pass. `bun run check-baseline`: OK (pass 3173, skip 259, fail 0).

Codex read-only re-QC of the repair diff: fixes 1 and 2 raise no defect. ONE NEW MAJOR, recorded, NOT fixed per brief:
- token-usage-dal.ts ~285: the 120s grace keys on `messages.created_at`, which is the streaming placeholder insert time, not completion time. A turn whose first text precedes its result by more than 120s has its `assistant_message` finalized before its `usage_event`; if the proof budget gate runs in that gap, the anti-join reports `attributionLost` and the run terminates `budget_attribution_lost`. Fail-closed false positive (never a bypass); the same grace-on-created_at existed in the pre-repair aggregate detector. Fix direction: grace on a completion timestamp (`messages.updated_at`/finalized_at) instead of `created_at`.

Status: both original MAJORs FIXED; 1 new MAJOR (false-positive, fail-closed) open. PR stays draft.

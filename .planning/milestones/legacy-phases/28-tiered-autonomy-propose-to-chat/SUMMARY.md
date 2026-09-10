# Phase 28 — tiered-autonomy-propose-to-chat · SUMMARY

**Status:** Complete (PASS) · commits `741f2fd`, `039e8e7` on `feat/auto-dev-orchestrator`

Tiered autonomy: powerful commands (ship / complete-milestone / tag) surface a one-tap approval to chat instead of auto-executing.

## Delivered
- `hub/src/orchestrator/propose.ts` — `proposeToChat(unit, ctx)` + `notifyChatSurface(...)` + pure `composeProposalMessage`. Reuses P3 `executeEmail`/`executeTelegram` senders + `notifications_sent` throttle (kind `propose_roadmap`, 6h TTL, sha key, namespaced `orch-propose:`/`orch-verify:`). No schema change. Notify-only — never PR/merge/tag.
- `wave-runner.ts` — live `proposeToChat` seam (stub removed).
- `verify-tail.ts` — exhausted-fix surface now binds `notifyChatSurface`.

## HITL contract (Phase-29 seam)
Proposal id `(sessionId, command, contentSha)`; approval marker (proposed `orchestrator_approvals` table, deferred to Phase 29) consumed by the off-hours merge command. No auto-execute here.

## Safety
Flag-OFF; only PROPOSE_COMMANDS propose; all sends/DB mocked in tests.

## Verification
13 pass / 0 fail; baseline 1424 / 0 fail.

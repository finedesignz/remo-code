---
phase: 28-tiered-autonomy-propose-to-chat
status: passed
verified_by: main-thread orchestrator (pacing under transient rate-limit)
---

# Phase 28 — tiered-autonomy-propose-to-chat · VERIFICATION

**Verdict: PASS** · commits `741f2fd`, `039e8e7`
**Tests:** `orchestrator-propose.test.ts` 13 pass / 0 fail (54 expects) · `check-baseline` 1424 pass / 0 fail

## Per-requirement
| Req | Item | Status | Evidence |
|---|---|---|---|
| Tiered autonomy (decision 5) | only ship/complete-milestone/tag propose; build/QC auto | PASS | only `PROPOSE_COMMANDS` route to `proposeToChat`; build/qc/plan/execute/audit-fix/gap-scan/code-review do not — test-asserted |
| Reuse P3 propose machinery | surfaceProposal building blocks + throttle | PASS | reuses `executeEmail`/`executeTelegram` senders + `notifications_sent` throttle (kind `propose_roadmap`, record-before-send, 6h TTL, sha key); namespaced keys `orch-propose:`/`orch-verify:`; NO schema change |
| No auto-execute | notify only | PASS | grep: `gh pr`/`merge` only in doc comments; module never opens PR/merges/tags |
| Verify-tail surface | exhausted-fix uses same notify | PASS | `verify-tail.ts` binds `notify: notifyChatSurface` (dead stub removed) |
| Run-log `proposed` | single row, no double-log | PASS | written by `runUnit` (wave-runner); propose.ts imports no run-log (test-asserted) |

## HITL contract (documented, Phase-29 seam)
Proposal id = `(sessionId, command, contentSha)`; a human approval writes an approval marker (proposed `orchestrator_approvals` row — schema deferred to Phase 29); the off-hours merge command reads UNCONSUMED markers, runs ship/merge, marks consumed. Telegram numeric-reply HITL not wired for orchestrator units (resolves against `pending_proposal` on `scheduled_tasks`; a task-less WaveUnit needs the new approvals table — Phase 29).

## Safety / invariants
Seams run only from the `REMO_ORCHESTRATOR_ENABLED`-gated cycle-runner; STUB defaults inert (test confirms STUB sends nothing). All sends + DB mocked in tests — zero real telegram/email/Postgres. Reuses P3 (no fork); no schema change; no drive-by.

## Deviations (documented, sound)
Reused P3 *building blocks* not `surfaceProposal` itself (it's task/roadmap-coupled, inapplicable to WaveUnits); run-log `proposed` row satisfied by `runUnit` not propose.ts (avoids double-row).

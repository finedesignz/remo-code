# Phase 29 — off-hours-merge-to-main · SUMMARY

**Status:** Complete (PASS) · build commit + `003d0d9` (decision-8 fix) on `feat/auto-dev-orchestrator`

The only command permitted to merge to main — window-gated, reviewer-PASS-driven, agent-executed.

## Delivered
- `schema.sql` — idempotent `orchestrator_approvals` table (unique `(session_id,command,content_sha)` + unconsumed index). DAL `insertApproval`/`listUnconsumedApprovals`/`markApprovalConsumed`.
- `hub/src/orchestrator/merge-command.ts` — `runMergeToMain`: window gate (`isWithinActiveWindow`, injectable clock); selection (decision 8): dev-command PR + reviewer PASS → auto-merge (no marker); ship/complete-milestone/tag PR → PASS + unconsumed approval (consumed before inject) else held; FAIL/uncertain → held; held → `notifyChatSurface`; agent does `gh pr merge` via cost-cap-gated inject (hub text-only).
- `controller.ts` — `dispatchMergeIfDue` special-path router (merge-to-main excluded from wave planner), flag-gated.

## Safety
Flag-OFF; only-this-command-merges; hub never shells git/gh; all network/clock/DB mocked in tests.

## Verification
13 pass / 0 fail; baseline 1437 / 0 fail. Decision-8 confirmed by user; corrected in `003d0d9`.

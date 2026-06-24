---
phase: 29-off-hours-merge-to-main
status: passed
verified_by: main-thread orchestrator (pacing under transient rate-limit)
---

# Phase 29 — off-hours-merge-to-main · VERIFICATION

**Verdict: PASS** · commits `<build>`, `003d0d9` (decision-8 correction)
**Tests:** `orchestrator-merge-command.test.ts` 13 pass / 0 fail (61 expects) · `check-baseline` 1437 pass / 0 fail

## Per-requirement
| Req | Item | Status | Evidence |
|---|---|---|---|
| Window gate | off-hours only | PASS | reuses `isWithinActiveWindow` over the merge row's `active_window`; outside → `skipped_out_of_window` run-log row, nothing injected; injectable clock |
| Selection (decision 8 — CORRECTED) | dev PR + reviewer PASS auto-merges; ship/milestone/tag need approval | PASS | `verdict!=='PASS'`→held; PASS & command∉`PROPOSE_ONLY_COMMANDS`→auto-merge (no marker); PASS & command∈`PROPOSE_ONLY_COMMANDS`→merge iff unconsumed approval (consumed before inject) else held |
| Hold/notify | FAIL/uncertain/unapproved-powerful held + surfaced | PASS | held list → `notifyChatSurface` (best-effort) + run-log rationale |
| Approvals table | idempotent DDL | PASS | `orchestrator_approvals` (unique `(session_id,command,content_sha)` + unconsumed index); DAL insert/list-unconsumed/mark-consumed; no inline backfill |
| Idempotency | no re-merge | PASS | powerful-cmd approval consumed before inject; dev PR closes on merge so re-fire finds no open PASS row |

## Safety / invariants
ONLY command permitted to merge to main; `EXCLUDED_COMMANDS` in wave planner, routed solely via `dispatchMergeIfDue`→`runMergeToMain`. **Hub text-only** — composes a prompt; the agent does `gh pr merge --squash` in-turn (cost-cap-gated inject). Flag-OFF default (`registerCycleRunnerIfEnabled()===false` test). All network/clock/DB mocked — zero real merges.

## Decision note
Builder initially required an approval marker for EVERY PR (conservative, contradicted decision 8). **User confirmed decision 8 as chosen** (2026-06-06): PASS dev PRs auto-merge in-window without a human tap; only ship/complete-milestone/tag require the approval marker. Corrected in `003d0d9`.

## Deferred
Postgres unreachable — schema-idempotency + approvals-DAL e2e deferred to the pre-enablement integration gate.

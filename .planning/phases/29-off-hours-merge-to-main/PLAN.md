# Phase 29 — off-hours-merge-to-main · PLAN

**Branch:** `feat/auto-dev-orchestrator` · **Reqs:** R-ADO-24, R-ADO-25 · **SPEC §1 decision 8 / §7 phase 9**

## Goal
The dedicated `merge-to-main` command — the ONLY auto-merge-to-main path. Runs only inside
the row's configured off-hours `active_window`. Auto-merges PRs whose dispatched reviewer
marked **PASS** (verdict read from `routine_run_log`) **AND** that carry an unconsumed
approval marker for ship/merge (HITL contract, P28). FAIL / uncertain / unapproved PRs are
HELD and surfaced to chat (P28 `notifyChatSurface`). Idempotent (consumed marker prevents
re-merge). Hub stays **text-only** — the agent runs `gh pr merge` in-turn. Behind
`REMO_ORCHESTRATOR_ENABLED` (default OFF).

## Assumptions (state up front)
- The off-hours window lives on the merge row's `schedule_rule.active_window` (reuse
  `isWithinActiveWindow` from `scheduler/schedule-rules.ts` — NO new window logic).
- PASS PRs are discovered from `routine_run_log` rows with `reviewer_verdict='PASS'` and a
  non-empty `pr_url`, newest-first, deduped per `pr_url`.
- "Approved" = an unconsumed `orchestrator_approvals` row for `(session_id, command,
  content_sha)` where `content_sha = sha256(pr_url)` and `command` is the originating
  command (ship/merge family). This is the P28 HITL tuple. SPEC decision 5/8: merge of a
  ship/milestone/tag PR requires approval; ordinary PASS dev PRs that are NOT in the
  approval-required set still need PASS only — but to stay conservative and honour the P28
  contract, we require an approval marker keyed by pr_url for EVERY PR the merge command
  acts on. (Deviation note: simplest safe rule — approval-or-hold for all.)
- The hub injects a templated prompt instructing the agent to `gh pr merge --squash` the
  selected PRs and to mark each approval consumed (the agent reports back; hub also marks
  consumed at selection time to make the window idempotent — re-fire sees them consumed).
  We mark consumed at SELECTION (before inject) so a re-fired window cannot double-select;
  the merge itself is the agent's job. This is the idempotency guard (R-ADO-25).

## Deliverables
1. **schema.sql** — `orchestrator_approvals` table (idempotent DDL, no backfill):
   `id, session_id FK→sessions ON DELETE CASCADE, command, content_sha, approved_at,
   consumed_at NULL, created_at` + UNIQUE `(session_id, command, content_sha)` + an index
   on `(session_id) WHERE consumed_at IS NULL` for the unconsumed lookup.
2. **DAL** in `hub/src/db/orchestrator-rows-dal.ts` (same file/style as the rest of the
   orchestrator model): `insertApproval`, `listUnconsumedApprovals(sessionId)`,
   `markApprovalConsumed(id)`.
3. **`hub/src/orchestrator/merge-command.ts`** — `runMergeToMain(ctx, deps)`:
   - WINDOW GATE: `isWithinActiveWindow(rule, now, tz)` → outside ⇒ skipped run-log row,
     no inject. Injectable `now` clock.
   - SELECTION: PASS PRs from run log ∩ unconsumed approvals (match `content_sha` =
     `sha256(pr_url)`). Mark each selected approval consumed (idempotency). Compose +
     inject (cost-cap gated via `injectOrchestratorPrompt`) instructing the agent to
     `gh pr merge --squash` ONLY those PRs.
   - HOLD: PASS-without-approval and FAIL/UNCERTAIN PRs → `notifyChatSurface`.
   - One `appendRunLog` row: `command='merge-to-main'`, `outcome`, merged + held PR lists in
     `decision_rationale`.
4. **Recognition** — export `MERGE_COMMAND='merge-to-main'` + `isMergeCommand()`; the
   controller routes this command to `runMergeToMain` (special path, NOT the wave planner —
   already EXCLUDED there). Gated by `isOrchestratorEnabled()`.
5. **Tests** — `hub/test/orchestrator-merge-command.test.ts`, mock inject + DB + clock:
   in-window proceeds / out-of-window skips; only PASS+approved selected, FAIL/unapproved
   held+notified; consumed marker prevents re-merge; flag-OFF dormancy; run-log row written.

## Invariants honoured
- Hub text-only — never shells `gh`/`git`/`merge`; agent does it (IR: command-prompts/inject).
- Cost cap non-bypassable — merge inject rides `injectOrchestratorPrompt` (gate list).
- Only this command merges to main; only in-window + PASS + approved.
- Idempotent DDL only; approvals backfill N/A (new table).

## Out of scope
Web UI for approvals (Phase 31/UI); the actual `gh pr merge` shell (agent in-turn);
Phase 30 presets. No flag flip, no push/PR/prod.

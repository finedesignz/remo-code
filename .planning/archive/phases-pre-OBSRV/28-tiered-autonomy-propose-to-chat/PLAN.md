# Phase 28: tiered-autonomy-propose-to-chat — PLAN

Reqs: R-ADO-22, R-ADO-23. SPEC §1 decision 5 + §7 phase 28. Depends: P24 (wave-runner
`proposeToChat` seam), P25 (PROPOSE_ONLY routing), P27 (verify-tail `NotifySeam`).

## Goal

Wire the REAL propose-to-chat for high-tier commands (ship / complete-milestone / tag) and
the verify-tail exhausted-fix surface — by REUSING the shipped auto-dev P3 building blocks
(`notify_email` + `notify_telegram` post-run senders + `notifications_sent` throttle), so a
high-tier command notifies the human ONCE per TTL and NEVER auto-executes. Behind
`REMO_ORCHESTRATOR_ENABLED` (default OFF) — prod stays dormant.

## Assumptions (stated up front, Karpathy)

- `WaveUnit` carries `{command, propose, priority, microPrompt}` — NO PR list. The PR(s) a
  ship would touch are reconciled on a later tick (P25 contract), so the proposal message
  states the COMMAND + repo + (optional) micro-prompt + "approve to run", not a PR diff.
- `runUnit` (wave-runner) ALREADY writes the single `routine_run_log` row with
  `outcome='proposed'` when `proposeToChat` returns (line 238). Therefore `proposeToChat`
  in propose.ts is NOTIFY-ONLY — it MUST NOT write a second run-log row (would double-log).
  The task's "write a routine_run_log row outcome=proposed" is SATISFIED by the existing
  runUnit path; propose.ts owns the notify+throttle only. (Deviation documented in REPORT.)
- The verify-tail surface is a STANDALONE notify (not a wave unit); verify-tail writes its
  own `verify_failed` run-log row. So the shared notify there is also notify-only.
- `surfaceProposal` itself is bound to a `ScheduledTask` + `ControllerDecision` (roadmap
  items + `pending_proposal` HITL on `scheduled_tasks`). Orchestrator propose UNITS are not
  tasks and have no roadmap, so we REUSE surfaceProposal's BUILDING BLOCKS (the exact same
  `executeEmail`/`executeTelegram` senders + `notifications_sent` throttle pattern, same
  `kind='propose_roadmap'`), NOT the function. This is the task's explicit "OR the same
  notify_email/notify_telegram + notifications_sent throttle pattern" branch.

## Deliverables

1. `hub/src/orchestrator/propose.ts`
   - `proposeToChat(unit, ctx): Promise<ProposeResult>` — compose an approval message
     (command label + repo + micro-prompt + one-tap instruction), throttle via
     `notifications_sent` (kind `propose_roadmap`, dedupe key `orch-propose:<session>:<sha>`,
     TTL `ORCH_PROPOSE_TTL_SECONDS`=6h), then send via `executeEmail`+`executeTelegram`.
     Best-effort, never throws. Returns `{ surfaced, throttled, message }`.
   - `notifyChatSurface({sessionId,userId,summary})` — the verify-tail `NotifySeam`-shaped
     surface; throttled+sent the same way (dedupe `orch-verify:<session>:<sha>`). Lets P27
     reuse one notify path.
   - `composeProposalMessage(unit, repoKey)` — pure, testable formatter.
   - Throttle helper mirrors P3 `throttleAllow` (record-before-send; log-only on failure).

2. Wire live seams
   - `wave-runner.ts` `makeLiveSeams()` → `proposeToChat` calls `propose.ts` proposeToChat
     (replacing the console-log stub).
   - `verify-tail.ts` `buildRealDeps()` + the no-target deps → `notify: notifyChatSurface`
     (replacing `defaultNotify`). `defaultNotify` kept as the test/fallback default.
   - Flag gating UNCHANGED: both seams only run from the `REMO_ORCHESTRATOR_ENABLED`-gated
     cycle-runner; STUB_SEAMS / `runWavePlan` default stay inert.

3. HITL approval contract (Phase 29 seam) — documented in propose.ts header + REPORT.
   - We do NOT wire Telegram numeric-reply for orchestrator units (that path is bound to
     `pending_proposal` on `scheduled_tasks`; orchestrator units aren't tasks → would need
     new schema/DAL, out of P28 scope, no auto-execute allowed here anyway).
   - Contract: a future approval marker (e.g. an `orchestrator_approvals` row keyed by
     `(session_id, command, sha)`) is written when a human approves; the off-hours Phase-29
     command reads unconsumed approvals to actually run ship/merge. P28 only PROPOSES.

4. Tests: `hub/test/orchestrator-propose.test.ts` — mock `executeEmail`/`executeTelegram` +
   fake `sql` (no real telegram/email/DB), mirroring `propose-notify.test.ts`:
   - proposeToChat formats + calls BOTH senders for ship / complete-milestone / tag.
   - throttle suppresses a duplicate within TTL (second call → throttled, no send).
   - notify (verify-tail surface) surfaces via the same path.
   - flag-OFF dormancy: STUB_SEAMS proposeToChat does NOT send (no senders called).
   - only powerful commands propose: build/qc/plan/execute are NOT propose units
     (`PROPOSE_COMMANDS` / `unit.propose=false`) → never call proposeToChat.
   - Plus assert wave-runner's existing `proposed` run-log row is the single source (no
     double log) via the wave-runner spy test already in `orchestrator-waves.test.ts`.

## QC

`bun test orchestrator-propose.test.ts` + `bun run check-baseline`
(JWT_SECRET=test_secret_at_least_32_chars_long_xx). Report counts.

## Out of scope (do NOT do)

Phase 29 off-hours auto-merge. No auto-execute of ship/merge. No push/PR/prod/flag-flip.
No schema change (reuse `propose_roadmap` kind).

---
phase: 20-telegram-transcript-tail
plan: 03
type: execute
wave: 2
depends_on:
  - 20-01
files_modified:
  - hub/src/telegram/transcript/permission-detector.ts
  - hub/src/telegram/transcript/keystroke-map.ts
  - hub/src/telegram/bridge.ts
  - hub/src/telegram/approvals.ts
  - hub/src/ws/client.ts
  - hub/test/telegram-permission-failclosed.test.ts
  - hub/test/telegram-permission-disambiguation.test.ts
  - hub/test/telegram-keystroke-inject.test.ts
autonomous: false
requirements:
  - R-TG-05
  - R-TG-06
  - R-TG-07
  - R-TG-08
  - R-TG-09
must_haves:
  truths:
    - "Pending permission/user_question is detected from the transcript per backend, keyed by (sessionId, requestId) — never requestId alone"
    - "Detection is FAIL-CLOSED: ambiguous/partial/unparseable ⇒ no Telegram prompt, no keystroke, never auto-approve; Codex scrape mode emits no permission prompts"
    - "A detected pending is surfaced via the existing inline tap-to-approve UX with one button per enumerated option and per-user (sessionId,requestId) authorization"
    - "An authorized tap injects the backend-specific PTY keystroke(s) via the raw-terminal input path (NOT permission_response), targeting only that session's PTY"
    - "A tap resolves exactly one (sessionId,requestId), removed on resolve; a superseded/expired pending injects nothing"
  artifacts:
    - path: "hub/src/telegram/transcript/permission-detector.ts"
      provides: "Fail-closed pending-permission/question detector over TranscriptEntry"
    - path: "hub/src/telegram/transcript/keystroke-map.ts"
      provides: "Per-backend pending→keystroke mapping table"
  key_links:
    - from: "permission-detector → rememberPendingPrompt(sessionId, requestId, {userId,...})"
      to: "approvals.ts registry keyed by (sessionId, requestId)"
      via: "existing inline-approval registry (reused verbatim)"
      pattern: "entryKey(sessionId, requestId)"
    - from: "callback_query tap → takePendingPrompt → keystrokeFor(cliKind, pending) → term.input"
      to: "session PTY stdin via raw-terminal input frame"
      via: "Phase-16 raw-terminal input path on /ws/agent"
      pattern: "term.input { sessionId, bytes }"
---

<objective>
The hard, security-sensitive part. With stream-json gone, permission prompts exist only as transcript
entries (or TUI bytes). Detect them fail-closed, surface via the existing inline UX, inject the human's
tap as the correct PTY keystroke — and NEVER auto-approve on ambiguity. Reuse the `(sessionId,
requestId)` keying that already fixed the multi-user clobber.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/20-telegram-transcript-tail/20-CONTEXT.md
@.planning/phases/20-telegram-transcript-tail/20-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@hub/src/telegram/approvals.ts
@hub/src/telegram/client.ts
@hub/src/events/permission-events.ts
@hub/src/telegram/transcript/types.ts
@CLAUDE.md
</context>

<threat_model>
- **T-20-06 — Mis-parse → auto-approval (CRITICAL).** The top risk: a transcript permission entry is
  mis-parsed and a dangerous action (file write, shell command) is silently approved, or a default
  "yes" is injected. This is a security boundary — a wrong approval executes attacker- or
  mistake-driven side effects on the user's machine. Mitigation (defense in depth):
    1. FAIL-CLOSED parse — only a discrete, fully-enumerated, known-mapping option set surfaces; any
       ambiguity ⇒ emit nothing (no prompt, no keystroke).
    2. No default/implicit choice — there is no "approve on timeout" and no "approve on parse-uncertain".
    3. Explicit confirmation — the human must tap a specific option button; nothing is injected without
       a tap bound to that exact (sessionId, requestId, userId).
    4. Codex scrape mode emits NO permission prompts at all (cannot fail-closed-parse raw bytes).
    5. Single-decision: takePendingPrompt removes the entry so a decision applies exactly once.
  Tests: a malformed/ambiguous permission fixture ⇒ zero keystrokes + zero approval messages.
  Block on: CRITICAL.
- **T-20-07 — Wrong-request answered / cross-session approval (HIGH).** A tap could resolve a
  different pending than intended (requestId collision across sessions) or inject into the wrong PTY.
  Mitigation: key by `(sessionId, requestId)`; injection targets the bound sessionId's PTY only; a test
  asserts two sessions with the same synthetic requestId don't collide and injection hits the right PTY.
- **T-20-08 — Stale/replayed tap (HIGH).** A tap on an already-resolved or TUI-advanced pending could
  inject a keystroke into an unrelated TUI state (e.g. approving a prompt that no longer exists, the
  keystroke landing on the next prompt). Mitigation: reject the tap if the bound pending is gone
  (resolved/TTL/expired) or the transcript shows the request resolved / a new turn started; inject
  nothing; test asserts this.
- **T-20-09 — Unauthorized approver (HIGH).** A foreign chat taps a guessed/leaked requestId.
  Mitigation: per-user authorization binding in approvals.ts — no entry for that user ⇒ rejected.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Fail-closed pending-permission/question detector</name>
  <files>hub/src/telegram/transcript/permission-detector.ts, hub/test/telegram-permission-failclosed.test.ts</files>
  <read_first>
    - hub/src/telegram/transcript/types.ts (permission_request/user_question members)
    - hub/src/events/permission-events.ts (PermissionPendingEvent shape to emit)
  </read_first>
  <acceptance_criteria>
    - The detector consumes TranscriptEntry and emits a normalized pending ONLY when the entry parses into {sessionId, requestId, toolName/questionText, options: enumerated[], keystroke-mappable}
    - Ambiguous/partial/unmapped ⇒ emit NOTHING (no throw); a counter logs the skip reason
    - A malformed-permission fixture ⇒ the detector emits zero pendings; a test asserts zero downstream prompts + zero keystrokes
    - Codex scrape-mode entries (no permission_request kind) never produce a pending
  </acceptance_criteria>
  <action>
    Implement the detector as a pure function over TranscriptEntry → (PermissionPendingEvent | null).
    Enumerate the accepted shapes explicitly; everything else returns null. Add fixtures: a valid
    boolean permission, a valid option-select, a malformed/ambiguous one, and a Codex-scrape assistant
    entry. NO timeout-approve, NO default option anywhere.
  </action>
  <verify>
    <automated>cd hub; bun test test/telegram-permission-failclosed.test.ts 2>$null</automated>
  </verify>
  <done>Permission detection is fail-closed at the source.</done>
</task>

<task type="auto">
  <name>Task 2: Surface via existing inline UX, keyed by (sessionId, requestId)</name>
  <files>hub/src/telegram/bridge.ts, hub/src/telegram/approvals.ts, hub/test/telegram-permission-disambiguation.test.ts</files>
  <read_first>
    - hub/src/telegram/approvals.ts (rememberPendingPrompt/takePendingPrompt; (sessionId,requestId) keying; per-user auth)
    - hub/src/telegram/client.ts (sendMessageWithKeyboard, inline keyboard shape)
  </read_first>
  <acceptance_criteria>
    - On a detected pending, the bridge sends an inline keyboard (one button per enumerated option; Approve/Deny for booleans) and records it via `rememberPendingPrompt(sessionId, requestId, {userId, chatId, messageId, toolName})` for every authorized user
    - callback_data stays within 64 bytes (`pa:`/`pd:`/`po:<idx>:`+requestId); context lives in the registry
    - `takePendingPrompt` is scoped by (sessionId, requestId, userId); two sessions with the same synthetic requestId do not collide; an unauthorized user's tap is rejected
  </acceptance_criteria>
  <action>
    Wire the detector output into the bridge using the EXISTING approvals registry verbatim (extend
    take to also scope by sessionId if needed — smallest diff). Add option-index callback_data for
    option-selects. Do not change the registry's keying model.
  </action>
  <verify>
    <automated>cd hub; bun test test/telegram-permission-disambiguation.test.ts 2>$null</automated>
  </verify>
  <done>Pendings surface via the existing UX; disambiguation + authorization hold.</done>
</task>

<task type="auto">
  <name>Task 3: Inject the tap as backend-specific PTY keystrokes (not permission_response)</name>
  <files>hub/src/telegram/transcript/keystroke-map.ts, hub/src/ws/client.ts, hub/test/telegram-keystroke-inject.test.ts</files>
  <read_first>
    - hub/src/ws/client.ts (the raw-terminal input frame relay path — Phase 16 term.input)
    - hub/src/telegram/transcript/types.ts (cliKind on the pending)
  </read_first>
  <acceptance_criteria>
    - keystroke-map.ts maps (cliKind, pendingShape, chosenOption) → literal byte sequence the TUI expects (approve/deny key or option-index/arrow+enter)
    - On an authorized tap, the resolved pending → keystrokeFor(...) → a raw-terminal `term.input` frame to the bound sessionId's PTY; the deleted `permission_response` is NOT used
    - A test asserts injected bytes match the mapping for a known pending and that injection targets only the bound session's PTY
    - A superseded/expired pending (gone from the registry, or transcript shows resolved/new-turn) ⇒ the tap injects nothing and the user gets a "no longer pending" notice
  </acceptance_criteria>
  <action>
    Implement the per-backend keystroke table (Claude + Codex). Wire the callback_query handler to
    takePendingPrompt → keystrokeFor → existing raw-terminal input relay. The actual TUI byte sequences
    are an OPEN ITEM (RESEARCH §4) — capture them from a live TUI; until captured, gate this task's
    sign-off on the manual byte-capture (autonomous:false). Reject the tap if the pending is absent.
  </action>
  <verify>
    <automated>cd hub; bun test test/telegram-keystroke-inject.test.ts 2>$null</automated>
    Manual: against a live Claude + Codex TUI, a Telegram Approve/Deny/option tap drives the prompt correctly; an ambiguous prompt surfaces nothing.
  </verify>
  <done>Human taps inject the correct keystrokes into the right PTY; fail-closed + disambiguation enforced.</done>
</task>

</tasks>

<verification>
- `grep -rn permission_response hub/src/telegram` returns nothing (injection is keystrokes, not the deleted message)
- Malformed permission ⇒ zero prompts + zero keystrokes (fail-closed)
- (sessionId, requestId) keying everywhere; no requestId-only lookups (grep)
- Superseded/expired tap injects nothing; unauthorized tap rejected
- `bun run check-baseline` green
</verification>

<success_criteria>
Permission/user_question prompts flow Telegram→PTY safely: detected fail-closed, surfaced via the
existing inline UX, answered by injecting the correct backend keystrokes into exactly the right
session's PTY, with no path to auto-approval on ambiguity.
</success_criteria>

<output>
Create `.planning/phases/20-telegram-transcript-tail/20-03-SUMMARY.md` when done (record the captured
per-backend keystroke byte sequences + the exact pending transcript shapes observed).
</output>

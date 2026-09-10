---
phase: 20-telegram-transcript-tail
plan: 02
type: execute
wave: 2
depends_on:
  - 20-01
files_modified:
  - hub/src/telegram/bridge.ts
  - hub/test/telegram-output-from-transcript.test.ts
autonomous: true
requirements:
  - R-TG-04
must_haves:
  truths:
    - "The Telegram outbound bridge forwards final assistant_text + collapsed tool_use one-liners sourced from the session's TranscriptSource (selected by backend)"
    - "The bridge no longer imports onAssistantMessageFinal; streaming deltas are never forwarded"
    - "Per-chat serialization + the editable working-message UX are preserved"
  artifacts:
    - path: "hub/src/telegram/bridge.ts"
      provides: "Telegram outbound re-sourced from TranscriptSource"
  key_links:
    - from: "bridge subscribeToSession(sessionId, cliKind)"
      to: "selectAdapter(cliKind).open({...}) → TranscriptEntry stream"
      via: "transcript/index.ts"
      pattern: "for await (const entry of source) { if (entry.kind==='assistant_text') send... }"
---

<objective>
Re-source the Telegram outbound bridge from the Phase-20 `TranscriptSource`, replacing the deleted
`assistant_message:final` hub-event-bus source. Same human-facing behavior (final text + collapsed
tool lines, per-chat serialization), new source.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/20-telegram-transcript-tail/20-CONTEXT.md
@.planning/phases/20-telegram-transcript-tail/20-RESEARCH.md
@hub/src/telegram/bridge.ts
@hub/src/telegram/transcript/index.ts
@CLAUDE.md
</context>

<threat_model>
- **T-20-04 — Streaming-delta leak (LOW).** Forwarding non-final entries would spam Telegram + risk
  partial/contradictory text. Mitigation: forward only `assistant_text` (final) + `tool_use` summaries,
  never partials; a test asserts no streaming forward. Block on: none (quality).
- **T-20-05 — Cross-session/chat misroute (HIGH, inherited).** The adapter is opened per (sessionId,
  cliKind); the bridge must forward only to users whose telegram_default_session_id matches THAT
  session. Mitigation: reuse the existing `getUsersWithTelegramDefaultSession(sessionId)` lookup.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Subscribe the bridge to TranscriptSource instead of the event bus</name>
  <files>hub/src/telegram/bridge.ts</files>
  <read_first>
    - hub/src/telegram/bridge.ts (current onAssistantMessageFinal/onSessionActivity wiring + working-message state)
    - hub/src/telegram/transcript/index.ts (selectAdapter)
  </read_first>
  <acceptance_criteria>
    - bridge.ts no longer imports `onAssistantMessageFinal` from events/assistant-events
    - For each session with a Telegram default, the bridge opens `selectAdapter(cliKind)` and forwards `assistant_text` (final) to matching users via the existing per-chat serial queue
    - `tool_use` entries append collapsed one-liners to the editable working message (existing UX preserved)
    - Feature-gate on `config.telegram.botToken` preserved (no token ⇒ no-op); idempotent boot preserved
  </acceptance_criteria>
  <action>
    Replace the `onAssistantMessageFinal` subscription with a per-session TranscriptSource loop. Keep
    `getUsersWithTelegramDefaultSession`, the per-chat `Map<chatId, Promise>` serialization, and the
    working-message state. The cliKind for a session comes from the runner session metadata the hub
    already tracks (supervisor-registry / session row). Leave the permission/question handling to plan
    03 (do not delete the `onPermissionPending` import yet — plan 03 replaces it).
  </action>
  <verify>
    <automated>cd hub; bun test test/telegram-output-from-transcript.test.ts 2>$null</automated>
    Test feeds a fixture TranscriptSource emitting tool_use + assistant_text and asserts a final send to the matching user, no send for streaming, and the working-message edit path runs.
  </verify>
  <done>Telegram output is sourced from the transcript; the event-bus source is gone.</done>
</task>

</tasks>

<verification>
- `grep -n onAssistantMessageFinal hub/src/telegram/bridge.ts` returns nothing
- Bridge consumes only TranscriptEntry; per-chat serialization + working message intact
- `bun run check-baseline` green
</verification>

<success_criteria>
Telegram shows assistant output again after the rip — sourced from the per-backend transcript, with the
prior final-only + per-chat-serial behavior preserved.
</success_criteria>

<output>
Create `.planning/phases/20-telegram-transcript-tail/20-02-SUMMARY.md` when done.
</output>

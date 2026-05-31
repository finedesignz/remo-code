---
phase: 20-telegram-transcript-tail
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - hub/src/telegram/transcript/types.ts
  - hub/src/telegram/transcript/claude-adapter.ts
  - hub/src/telegram/transcript/codex-adapter.ts
  - hub/src/telegram/transcript/index.ts
  - hub/test/transcript-adapter-claude.test.ts
  - hub/test/transcript-adapter-codex.test.ts
  - hub/test/transcript-backend-agnostic.test.ts
autonomous: false
requirements:
  - R-TG-01
  - R-TG-02
  - R-TG-03
must_haves:
  truths:
    - "A TranscriptSource interface + TranscriptEntry union exist; the active adapter is selected by session cliKind ('claude'|'codex'), not a hardcoded path"
    - "The Claude adapter resolves ~/.claude/projects/<slug>/<session-uuid>.jsonl deterministically from a known (project dir, session id); never newest-file"
    - "The Codex adapter resolves the rollout JSONL by session_meta id and falls back to a terminal-byte scrape (assistant_text + turn_complete only) when the file is absent/unrecognized"
    - "An unknown transcript record type degrades to skip+log, never a crash and never a misclassification"
  artifacts:
    - path: "hub/src/telegram/transcript/types.ts"
      provides: "TranscriptSource interface + TranscriptEntry union (assistant_text/tool_use/permission_request/user_question/turn_complete)"
    - path: "hub/src/telegram/transcript/claude-adapter.ts"
      provides: "Claude projects-JSONL adapter"
    - path: "hub/src/telegram/transcript/codex-adapter.ts"
      provides: "Codex rollout-JSONL adapter + byte-scrape fallback"
  key_links:
    - from: "transcript/index.ts selectAdapter(cliKind)"
      to: "claude-adapter | codex-adapter"
      via: "session cliKind from runner session metadata"
      pattern: "cliKind === 'codex' ? codexAdapter : claudeAdapter"
---

<objective>
Define the backend-agnostic transcript source. One interface, one normalized entry union, two adapters
(Claude projects JSONL; Codex rollout JSONL + scrape fallback), selected by `cliKind`. This is the
seam every later Phase-20 plan consumes — the bridge must never see a backend-specific shape.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/ROADMAP.md
@.planning/phases/20-telegram-transcript-tail/20-CONTEXT.md
@.planning/phases/20-telegram-transcript-tail/20-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@hub/src/events/permission-events.ts
@supervisor/src/runners/types.ts
@CLAUDE.md
</context>

<threat_model>
- **T-20-01 — Wrong-session transcript cross-wire (HIGH).** If an adapter picks the newest file rather
  than resolving by the known session id, a concurrent session in the same project leaks another
  session's output (and permissions) to the wrong Telegram chat. Mitigation: deterministic
  (project-dir + session-id / session_meta-id) resolution; a test asserts two sessions in one project
  resolve to distinct files. Block on: HIGH.
- **T-20-02 — Transcript-format drift misclassification (MED).** An unknown record `type` parsed
  optimistically could be mistaken for an assistant turn or (worse) a permission. Mitigation: parse
  strictly by known `type`; unknown ⇒ skip + log; never infer a permission from an unrecognized shape.
- **T-20-03 — Codex scrape mode surfacing a forged permission (HIGH).** Bytes scraped from a terminal
  cannot be reliably parsed into a discrete approve/deny without ambiguity. Mitigation: scrape mode
  emits ONLY assistant_text + turn_complete, NEVER permission_request (fail-closed at the source);
  test asserts the unknown-schema path selects fallback and emits no permission_request.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: TranscriptSource interface + TranscriptEntry union</name>
  <files>hub/src/telegram/transcript/types.ts, hub/src/telegram/transcript/index.ts</files>
  <read_first>
    - hub/src/events/permission-events.ts (PermissionPendingEvent shape to mirror for permission_request)
    - supervisor/src/runners/types.ts (cliKind union)
  </read_first>
  <acceptance_criteria>
    - types.ts exports a `TranscriptEntry` discriminated union with members: assistant_text, tool_use, permission_request, user_question, turn_complete — each carrying sessionId; permission_request/user_question carry requestId + an enumerated options array
    - types.ts exports a `TranscriptSource` interface: `open(ctx: {sessionId; projectDir; cliKind})`, an async iterator / callback of TranscriptEntry, and `close()`
    - index.ts exports `selectAdapter(cliKind)` returning the matching adapter
    - tsc passes (`bun run check-baseline` typecheck portion green)
  </acceptance_criteria>
  <action>
    Create the `hub/src/telegram/transcript/` dir. Define `TranscriptEntry` mirroring the existing
    PermissionPendingEvent fields for the permission_request member (so the bridge keeps the same
    keying). Define `TranscriptSource` with explicit open(ctx)/iterate/close. `index.ts` maps
    `cliKind` → adapter. No file I/O here.
  </action>
  <verify>
    <automated>cd hub; bun test test/transcript-backend-agnostic.test.ts 2>$null</automated>
    Test asserts selectAdapter('claude') and selectAdapter('codex') return distinct adapters and the union has the 5 members.
  </verify>
  <done>The seam exists; adapters can be written against it.</done>
</task>

<task type="auto">
  <name>Task 2: Claude projects-JSONL adapter</name>
  <files>hub/src/telegram/transcript/claude-adapter.ts, hub/test/transcript-adapter-claude.test.ts</files>
  <read_first>
    - hub/src/telegram/transcript/types.ts
    - .planning/phases/20-telegram-transcript-tail/20-RESEARCH.md (Claude source section)
  </read_first>
  <acceptance_criteria>
    - claude-adapter resolves `~/.claude/projects/<slug>/<session-uuid>.jsonl` from (projectDir, sessionId) deterministically (slug derivation documented inline); never reads a directory listing to pick newest
    - Tails appended lines; maps known record types to TranscriptEntry; unknown `type` ⇒ skip + log (counter incremented), never throws
    - Fixture test (committed sample Claude JSONL) asserts assistant_text + tool_use + a permission/user_question fixture normalize correctly, and an unknown-type line is skipped
    - A two-sessions-in-one-project test asserts distinct file resolution (T-20-01)
  </acceptance_criteria>
  <action>
    Implement the adapter. Add a `hub/test/fixtures/claude-transcript.jsonl` sample covering the
    mapped types + one unknown-type line. Tail via fs.watch with a poll fallback (Claude's discretion).
  </action>
  <verify>
    <automated>cd hub; bun test test/transcript-adapter-claude.test.ts 2>$null</automated>
  </verify>
  <done>Claude output + permission entries are sourced deterministically with safe drift handling.</done>
</task>

<task type="auto">
  <name>Task 3: Codex rollout-JSONL adapter + byte-scrape fallback</name>
  <files>hub/src/telegram/transcript/codex-adapter.ts, hub/test/transcript-adapter-codex.test.ts</files>
  <read_first>
    - hub/src/telegram/transcript/types.ts
    - .planning/phases/20-telegram-transcript-tail/20-RESEARCH.md (Codex source + fallback section)
  </read_first>
  <acceptance_criteria>
    - codex-adapter resolves `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` by matching the `session_meta` id captured at spawn (not newest-file); maps `response_item` message/function_call payloads to TranscriptEntry
    - When the rollout file is absent OR a line's schema is unrecognized, the adapter selects the terminal-byte-scrape fallback, emitting ONLY assistant_text + turn_complete
    - A test asserts the unknown-schema/absent path selects fallback and NEVER emits a permission_request (T-20-03)
    - Windows sessions-dir path resolution is handled (or a clear TODO with the verified path noted in SUMMARY)
  </acceptance_criteria>
  <action>
    Implement the adapter with the documented-unstable rollout schema (parse by `type`/`payload.type`),
    a `session_meta`-id resolver, and the scrape fallback. Add `hub/test/fixtures/codex-rollout.jsonl`
    + an `unrecognized-rollout.jsonl`. Document the version the fixture came from inline (drift warning).
  </action>
  <verify>
    <automated>cd hub; bun test test/transcript-adapter-codex.test.ts 2>$null</automated>
  </verify>
  <done>Codex output sourced from rollout JSONL with a fail-closed scrape fallback; no forged permissions.</done>
</task>

</tasks>

<verification>
- `selectAdapter` returns the right adapter per cliKind; bridge-facing type is only TranscriptEntry
- Both adapters resolve files deterministically by session id (no newest-file heuristic anywhere — grep)
- Unknown record ⇒ skip+log; Codex fallback emits no permission_request
- `bun run check-baseline` green; new test files registered in tools/regression-baseline.json if required
</verification>

<success_criteria>
A backend-agnostic transcript source: Claude + Codex both covered, deterministic mapping, fail-closed
drift handling, scrape fallback that never fabricates permissions. Consumed by plans 02–03.
</success_criteria>

<output>
Create `.planning/phases/20-telegram-transcript-tail/20-01-SUMMARY.md` when done (note the captured
Codex version + Windows path verification + the Claude record-type discriminators observed).
</output>

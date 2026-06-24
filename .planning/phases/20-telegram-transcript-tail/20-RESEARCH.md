# Phase 20: telegram-transcript-tail - Research

## Summary

After the Phase-17 rip, Telegram has no structured event source. This phase re-sources it from each
backend's on-disk transcript and injects human responses as PTY keystrokes. The load-bearing unknowns
are (1) the Codex rollout transcript path/format (undocumented), (2) how a pending permission/question
appears in each backend's transcript so detection can be fail-closed, and (3) the safe arbitration of
two PTY writers. Findings below; open questions are flagged for the implementing agent to resolve
against a live install.

## Key findings

### 1. Claude transcript source (R-TG-02) — CONFIDENCE: HIGH (path), MEDIUM (record schema)
- Path: `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`. The project slug is the cwd path
  with separators replaced (Claude Code's projects dir). Session uuid is the CC session id.
- Format: JSONL, one record per line; records include user/assistant turns and tool_use/tool_result
  entries with a `type` discriminator. The exact field names vary across CC releases — treat the
  schema as UNSTABLE: parse by `type`, and on an unknown `type` SKIP + log (never crash, never
  misclassify). The codebase does NOT currently read this file — it is a new dependency for Phase 20.
- Session→file mapping: capture (project dir, session id) at PTY spawn (Phase 16 already knows both),
  derive the slug + filename deterministically. NEVER pick "newest file" — concurrent sessions in the
  same project would cross-wire.

### 2. Codex transcript source (R-TG-03) — CONFIDENCE: MEDIUM (community-reverse-engineered)
- Path: `~/.codex/sessions/YYYY/MM/DD/rollout-<TIMESTAMP>-<UUID>.jsonl` (date-hierarchy under the
  sessions dir). macOS/Linux confirmed; Windows path is `%USERPROFILE%\.codex\sessions\...` by parity
  (verify on the Windows dev host — Codex CLI is primarily a Rust binary, `codex-rs`).
- Format: JSONL; each line `{ "timestamp": "...", "type": "session_meta" | "response_item" |
  "turn_context", "payload": {...} }`. `session_meta` carries the session id (use it to resolve THIS
  session's file — not newest-file). `response_item` payloads carry the OpenAI Responses-style items:
  `message` (assistant/user text), `function_call` (tool use), `reasoning`. Confirmed against Codex
  v0.130.0 community traces; SCHEMA DRIFTS PER VERSION (GitHub issue #21196 reports rollout files
  going missing / state drift).
- FALLBACK (mandated): when the rollout file is absent or its schema is unrecognized, the Codex adapter
  degrades to a **terminal-byte scrape** of the PTY output — surfacing only `assistant_text` and a
  `turn_complete` heuristic (prompt-ready). The scrape path emits NO `permission_request` (you cannot
  fail-closed-parse a permission out of raw bytes reliably), so Codex permissions in fallback mode are
  simply not surfaced to Telegram (the human handles them on the xterm surface). This is the safe
  degradation.
- Re-verify before relying: path + schema are fast-moving. Sources are secondary (community
  reverse-engineering + the codex repo discussions), not official docs.

### 3. Pending permission / user_question detection (R-TG-05, R-TG-06)
- The pre-rip path raised a structured `permission_request` runner event → `onPermissionPending`
  (`hub/src/events/permission-events.ts`) → Telegram inline keyboard → `permission_response` back on
  the agent socket. Post-rip that event source is gone; Phase 20 REGENERATES the same
  `PermissionPendingEvent` shape from the transcript.
- Claude: a tool-permission prompt and an interactive `user_question` (option-select) appear as
  transcript entries with an enumerable option set. Map a boolean permission → Approve/Deny; an
  option-select → one button per option.
- Codex (rollout mode): `response_item` with a function_call awaiting approval, or an interactive
  prompt item. Map analogously. (Scrape mode: not surfaced — see fallback.)
- FAIL-CLOSED is the hard rule: if the entry does not parse into a discrete enumerated choice with a
  known keystroke mapping, emit nothing.

### 4. Keystroke injection (R-TG-08) — per-backend mapping
- Inject via the Phase-16 raw-terminal input path (`term.input` frame → PTY stdin), NOT the deleted
  `permission_response`. Each backend's TUI has its own accept/deny/option keystrokes (e.g. arrow+enter
  to select an option, a single key to approve). Maintain a small per-backend keystroke-mapping table
  inside the adapter; a test asserts the bytes for a known pending shape.
- OPEN QUESTION for the implementer: capture the exact key sequences from a live Claude TUI and Codex
  TUI permission prompt (record the bytes). Until captured, the mapping table is the gating manual
  verification — same posture as Phase 15's compile-shipping spike.

### 5. Existing approvals registry reuse (R-TG-05, R-TG-07, R-TG-09)
- `hub/src/telegram/approvals.ts` already keys by `(sessionId, requestId)` and holds per-user
  authorization (the multi-user-clobber fix). REUSE verbatim: `rememberPendingPrompt(sessionId,
  requestId, {userId, chatId, messageId, toolName})`, `takePendingPrompt(requestId, userId)` (extend
  the take signature to also scope by sessionId for the new flow), TTL prune. callback_data stays tiny
  (`pa:<requestId>` / `pd:<requestId>`); add option-index variants for option-selects.

### 6. PTY write-arbitration (R-TG-10)
- Two writers feed one tmux PTY stdin: the xterm panel (via `/ws/client` term.input) and the Telegram
  bridge. Without arbitration their keystrokes interleave mid-turn → corrupt input.
- Mechanism (chosen): single-writer turn lock per session in the hub, beside or near the relay that
  owns the term.input frames. Acquire on a new human turn; queue other writers (bounded FIFO); release
  on observed `turn_complete` from the `TranscriptSource`. A permission/question RESPONSE bypasses the
  "new turn" gate (it completes the holder's in-flight turn rather than starting a new one).
- Completion detection is FREE: the same transcript `turn_complete`/assistant-entry observation drives
  both lock-release and "permission no-longer-pending".

### 7. QC gate
- `bun run check-baseline` (per-file isolation; add new hub/test + supervisor/test files to
  `tools/regression-baseline.json` if the gate requires registration). `web/test/no-indigo.test.ts`
  unaffected (no UI change).

## Open technical questions for the implementer to resolve (feed SUMMARYs)
1. Exact Claude transcript record `type` discriminators for assistant-final, tool_use, and a
   permission/`user_question` prompt (capture from a live `~/.claude/projects/.../<id>.jsonl`).
2. Exact Codex rollout `response_item` payload shapes for assistant message vs function_call vs an
   approval-pending item, on the dev host's Codex version; confirm the Windows sessions dir path.
3. The literal keystroke byte sequences each backend TUI expects to accept/deny/select-option.
4. Turn-complete signal in scrape mode (Codex fallback): which prompt-ready marker is reliable.

## Validation Architecture
- Adapters: unit tests with FIXTURE transcript files (Claude JSONL + Codex rollout JSONL) asserting
  normalization to `TranscriptEntry`, deterministic session→file mapping, and unknown-record skip.
- Fail-closed: a malformed/ambiguous permission fixture asserts zero keystrokes + zero Telegram prompts.
- Disambiguation: two sessions, same synthetic requestId → no collision; tap on superseded pending →
  nothing injected.
- Arbitration: simulated concurrent writers → queued not interleaved; lock releases on a fixture
  `turn_complete`; non-holder response allowed.
- Human-only guard: automation-sourced Telegram-origin dispatch rejected.
- Backend-agnosticism: a test asserts the bridge imports only the `TranscriptEntry` union, never a
  backend-specific shape, and never `onAssistantMessageFinal`.

## Sources
- Codex rollout path/format (community, version-specific): OpenAI Codex GitHub Discussion #3827
  (Session/Rollout Files); DeepWiki "Rollout Persistence and Replay"; dev.to "Reverse engineering Codex
  CLI rollout traces"; GitHub issue #21196 (rollout file loss). Secondary, fast-moving — re-verify.
- Claude Code projects transcript: observed convention (`~/.claude/projects/<slug>/<id>.jsonl`); schema
  treated as unstable.
- Existing infra: `hub/src/telegram/{bridge,approvals,client}.ts`, `hub/src/events/permission-events.ts`,
  `supervisor/src/runners/types.ts`.

## RESEARCH COMPLETE

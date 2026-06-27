# Phase 20: telegram-transcript-tail - Context

Rebuild the Telegram bridge — broken by the Phase-17 rip — on a backend-agnostic transcript-tail
source, with fail-closed permission/question keystroke-injection and per-session PTY write-arbitration.

## Phase Boundary

**In scope.** A `TranscriptSource` adapter (per-backend, selected by `cliKind`); the Claude
projects-JSONL adapter and the Codex rollout-JSONL adapter (+ terminal-byte-scrape fallback);
re-sourcing the Telegram outbound bridge from the adapter; detecting pending permission/`user_question`
from the transcript keyed by `(sessionId, requestId)`; surfacing via the EXISTING inline tap-to-approve
UX; injecting the human tap as backend-specific PTY keystrokes via the Phase-16 raw-terminal input path;
a single-writer per-session turn lock arbitrating the two PTY writers (xterm + Telegram); routing
Telegram injection through the Phase-16 human-only guard; docs.

**Out of scope.** The PTY runner itself (Phases 15–16), the rip (Phase 17), the billing dual-bucket
(Phase 18), the cutover gate (Phase 19). Slash-command MENUS in Telegram beyond what surfaces as a
`user_question`/option-select in the transcript (a slash typed by the human is just injected text).
Multi-instance hub (the approvals registry + turn lock are module-level Maps today; Redis is a future
seam, same shape — noted, not built).

## Sequencing (HARD)

- **Depends on Phase 17.** Phase 17 deletes the stream-json human runner + the Telegram event source.
  Phase 20 MUST run after, because it re-sources Telegram from the transcript of the PTY session that
  Phase 16/17 produce. Building Phase 20 before the rip would wire against an event source that is
  about to be deleted.
- Phase 17 leaves an explicit break note at each removed Telegram source point (R-TG-12); it MUST NOT
  delete the Telegram bridge module wholesale (Phase 20 re-sources it).

## Implementation Decisions (LOCKED — from spec + user decisions 2/3/5)

### Backend-agnostic transcript source (decision 2)
- NO hardcoded `~/.claude/projects/...`. A `TranscriptSource` interface; one impl per backend; the
  active impl chosen by the session's `cliKind` (`'claude' | 'codex'`, from
  `supervisor/src/runners/types.ts:50`).
- Claude adapter → Claude Code projects JSONL `~/.claude/projects/<project-slug>/<session-uuid>.jsonl`.
- Codex adapter → Codex rollout JSONL `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`
  (UNDOCUMENTED, version-unstable — see RESEARCH); resolve by `session_meta` id; byte-scrape fallback
  when absent/unrecognized (scrape surfaces ONLY assistant text + turn-complete).
- Session→file mapping is EXPLICIT (project dir + session id captured at PTY spawn), never newest-file.
- All adapters normalize to a shared `TranscriptEntry` union: `assistant_text`, `tool_use`,
  `permission_request`, `user_question`, `turn_complete`. Bridge consumes only the union.

### Fail-CLOSED permission injection (decision 3, security-critical)
- Detect pending permission/`user_question` from the normalized stream per backend.
- Key by `(sessionId, requestId)` — NEVER `requestId` alone (reuse `hub/src/telegram/approvals.ts`,
  which already keys by `(sessionId, requestId)` after the multi-user clobber fix).
- Surface via existing inline UX (`approvals.ts` + `sendMessageWithKeyboard`), one button per
  enumerated option, existing per-user authorization binding.
- Inject the tap as backend-specific PTY keystroke(s) via the Phase-16 raw-terminal input path — NOT
  the deleted `permission_response` agent message.
- FAIL-CLOSED: ambiguous/partial/unparseable ⇒ do NOTHING (no prompt, no keystroke, never
  auto-approve, no default "yes"). Codex scrape fallback emits no permission prompts at all.
- A tap resolves exactly one `(sessionId, requestId)`, removed on resolve; rejected if
  superseded/expired.

### PTY write-arbitration (decision 5)
- Single-writer turn lock per session, held in the hub. Acquire → inject one human turn → release only
  on observed `turn_complete` (transcript assistant entry; or TUI prompt-ready in scrape fallback).
- Other writers' input QUEUED (bounded FIFO). Per-session "who holds the turn" state exposed.
- A permission/question RESPONSE from the non-holder is allowed (answering a prompt is not a new turn).
- Rationale: turn-completion is already observable from the transcript; locking on observed completion
  is the only safe arbiter when two writers feed one TUI stdin.

### Constraints carried (spec §Hard constraints)
- No `ANTHROPIC_API_KEY` ever; no API-key fallback. Transcript reader is read-only — adds no
  programmatic call; Telegram does NOT move to the programmatic pool (supersedes R-PTY-24).
- Official client only; never reuse/extract the OAuth token. (Transcript files are read; credentials
  are not.)
- Only genuine human turns touch the PTY (constraint 3). Telegram injection rides the Phase-16
  human-only guard; never combined with auto-nudge/scheduled prompts to drive the PTY unattended.
- Interactive CLI only (no `-p`, no stream-json) — inherited from Phases 15–17.

### Theme
- No UI surface changes in this phase (Telegram is the surface). Blue accent / no-indigo unaffected;
  `web/test/no-indigo.test.ts` stays green.

### Claude's Discretion
- Exact `TranscriptEntry` field names; the file-tail mechanism (poll vs fs.watch — prefer watch with a
  poll fallback); the keystroke-mapping table shape per backend; the queue bound; whether the turn lock
  lives beside the existing approvals registry or in a new `hub/src/telegram/turn-lock.ts`.

## Canonical References

### Source spec (authoritative)
- `.planning/architecture/interactive-pty-runner-SPEC.md` §"Telegram — transcript-tail (Plan B) is the
  chosen, load-bearing path (Phase 20)".

### Existing Telegram infra (re-source, reuse the keying — DO NOT rebuild)
- `hub/src/telegram/bridge.ts` — outbound bridge; today subscribes to `onAssistantMessageFinal` +
  `onPermissionPending`. Re-source from the adapter; keep per-chat serialization + working-message UX.
- `hub/src/telegram/approvals.ts` — pending-prompt registry keyed by `(sessionId, requestId)`,
  per-user authorization, TTL prune, `rememberPendingPrompt` / `takePendingPrompt`. REUSE.
- `hub/src/telegram/client.ts` — `sendMessageWithKeyboard`, `editMessageTextMd`, inline keyboards.
- `hub/src/events/permission-events.ts` — `onPermissionPending` / `PermissionPendingEvent` shape to
  REGENERATE from the transcript (same event shape, new source).

### PTY runner / input path (Phase 16 output — the injection target)
- `supervisor/src/runners/claude-pty-runner.ts`, `supervisor/src/runners/codex-pty-runner.ts` — PTY
  spawn + raw-terminal input write path. Telegram keystrokes inject here.
- `supervisor/src/runners/types.ts` — `cliKind: 'claude' | 'codex'`.

### Cross-cutting invariants
- CLAUDE.md §"Cross-cutting invariants": cost cap non-bypassable; webhooks raw-body-before-parse;
  `schema.sql` idempotent-only (backfills → `hub/scripts/`). Phase 20 adds no schema; if it persists a
  session→transcript mapping it does so idempotently or in memory.

## Specific Ideas
- The `(sessionId, requestId)` keying that fixed the Telegram multi-user clobber is the SAME
  disambiguation mechanism the user flagged as the fast-follow — reuse it verbatim for transcript-tail.
- Turn-complete detection doubles as both the arbitration release signal AND the
  "permission no-longer-pending" detector — one transcript observation, two consumers.

## Deferred Ideas
- Redis-backed approvals registry + turn lock for a multi-instance hub (same shape).
- A structured side-channel from the backend (if a future Claude/Codex flag emits permission prompts
  out-of-band) would replace transcript-parsing for permissions — re-evaluate then.
- Gemini transcript adapter (when/if Gemini becomes a viable backend per the spec's "If PTY fails").

---
Status: ready for planning.

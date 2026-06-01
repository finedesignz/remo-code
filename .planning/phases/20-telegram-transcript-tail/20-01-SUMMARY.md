---
phase: 20-telegram-transcript-tail
plan: 01
subsystem: telegram-transcript
tags: [transcript-tail, backend-agnostic, claude, codex, fail-closed]
provides: [TranscriptSource, TranscriptEntry, selectAdapter, ClaudeTranscriptAdapter, CodexTranscriptAdapter]
requires: [sessions.cli_kind, sessions.transcript_path, sessions.pty_backend_id]
key-files:
  created:
    - hub/src/telegram/transcript/types.ts
    - hub/src/telegram/transcript/index.ts
    - hub/src/telegram/transcript/tail.ts
    - hub/src/telegram/transcript/claude-adapter.ts
    - hub/src/telegram/transcript/codex-adapter.ts
    - hub/test/transcript-backend-agnostic.test.ts
    - hub/test/transcript-adapter-claude.test.ts
    - hub/test/transcript-adapter-codex.test.ts
    - hub/test/fixtures/claude-transcript.jsonl
    - hub/test/fixtures/codex-rollout.jsonl
    - hub/test/fixtures/unrecognized-rollout.jsonl
    - hub/test/fixtures/codex-tree/rollout-2026-abc.jsonl
metrics: { tests: 20, commit: 2d07cb6 }
requirements: [R-TG-01, R-TG-02, R-TG-03, R-TG-13]
---

# Phase 20 Plan 01: Backend-agnostic transcript source adapters Summary

One-liner: A `TranscriptSource` interface + 5-member `TranscriptEntry` union with Claude
(projects JSONL) and Codex (rollout JSONL + byte-scrape fallback) adapters selected by
`cliKind`, resolving files deterministically from the persisted spawn-time transcript identity
and degrading to scrape-mode (never newest-file) on absence.

## What shipped
- `types.ts` — `TranscriptEntry` union (`assistant_text`/`tool_use`/`permission_request`/`user_question`/`turn_complete`), `TranscriptSource` (`open(ctx)`/`close`), `TranscriptOpenCtx` (sessionId + projectDir + cliKind + persisted `transcriptPath`/`codexRolloutId`), `TranscriptOpenResult` (`mode: file|scrape`). Absent-field ⇒ scrape-mode rule documented inline.
- `index.ts` — `selectAdapter(cliKind)` returns a fresh per-call adapter.
- `tail.ts` — read-only JSONL tail: `fs.watch` + 500ms poll fallback, partial-line carry, truncation reset.
- `claude-adapter.ts` — `~/.claude/projects/<slug>/<uuid>.jsonl`, persisted path wins; `mapClaudeRecord` parses by `type` (assistant/tool_use/permission_request/user_question/result→turn_complete); unknown ⇒ skip+count. Boolean permission (no options) → Approve/Deny.
- `codex-adapter.ts` — `resolveCodexRolloutByMetaId` matches `session_meta.id` across the date-tree (name+id strict, bounded head-read); `mapCodexRecord` handles `response_item` message/function_call, skips reasoning/meta. **Rollout mode NEVER emits permission_request** (approval-item shape not yet captured); scrape fallback emits only assistant_text + turn_complete.

## VALIDATION bindings
- 20-01-01 (R-TG-01/T-20-02) → transcript-backend-agnostic.test.ts ✅
- 20-01-02 (R-TG-02/T-20-01) → transcript-adapter-claude.test.ts ✅ (two-sessions-distinct-file asserted)
- 20-01-03 (R-TG-03/T-20-03) → transcript-adapter-codex.test.ts ✅ (id-present→file, id-absent→scrape, fallback emits no permission)

## Open / version-unstable (re-verify on live install)
- Claude record `type` discriminators (assistant/tool_use/permission_request/user_question/result) — treated as unstable; unknown ⇒ skip+log.
- Codex rollout schema captured against community v0.130.0 traces; Windows path is `%USERPROFILE%\.codex\sessions\...` via `homedir()` (parity — verify on the dev host).
- `getTranscriptOpenContext` (plan 02) maps codex `session_meta` id from `sessions.pty_backend_id` — update there if a dedicated column lands.

## Self-Check: PASSED
Files present; 20 tests green; commit 2d07cb6 in log.

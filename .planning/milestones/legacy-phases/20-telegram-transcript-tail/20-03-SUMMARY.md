---
phase: 20-telegram-transcript-tail
plan: 03
subsystem: telegram
tags: [fail-closed, permission, keystroke-injection, security]
provides: [detectPending, keystrokeFor, injectPtyKeystroke, startPermissionSurfacing, optionCallbackData]
requires: [TranscriptSource, approvals registry, term.input relay]
key-files:
  created:
    - hub/src/telegram/transcript/permission-detector.ts
    - hub/src/telegram/transcript/keystroke-map.ts
    - hub/src/telegram/transcript/pty-inject.ts
    - hub/test/telegram-permission-failclosed.test.ts
    - hub/test/telegram-permission-disambiguation.test.ts
    - hub/test/telegram-keystroke-inject.test.ts
  modified:
    - hub/src/telegram/permission-surfacing.ts
    - hub/src/telegram/approvals.ts
    - hub/src/api/telegram-webhook.ts
metrics: { tests: 20, commit: 32ef88f }
requirements: [R-TG-05, R-TG-06, R-TG-07, R-TG-08, R-TG-09]
---

# Phase 20 Plan 03: Fail-closed permission injection Summary

One-liner: Permission/`user_question` prompts in the transcript are detected fail-closed, surfaced
via the existing inline `(sessionId,requestId)`-keyed approvals UX, and answered by injecting the
backend-specific PTY keystroke into only the bound session's PTY via `term.input` — never the
deleted `permission_response`, never an auto-approval on ambiguity.

## What shipped
- `permission-detector.ts` — pure `detectPending(entry)`: surfaces ONLY a clean enumerated permission/question (sessionId + requestId + non-empty options each with id+label); ambiguous/partial ⇒ null + skip-count; non-prompt kinds ⇒ null. NO timeout-approve, NO default option.
- `permission-surfacing.ts` — detector consumer on the shared transcript source; builds the inline keyboard (Approve/Deny for booleans, one button per enumerated option), records via `rememberPendingPrompt` with the keystroke-injection context (cliKind + shape + options) for every authorized user. Scrape-mode sessions never emit a permission ⇒ nothing surfaced.
- `keystroke-map.ts` — `keystrokeFor(cliKind, pending, optionId)` → literal bytes; fail-closed null on unmappable (out-of-range index, >9 options). PROVISIONAL bytes (y/n + numbered-list) pending live capture.
- `pty-inject.ts` — `injectPtyKeystroke(sessionId, bytes)` writes a base64 `term.input` frame to ONLY that session's agent channel.
- `approvals.ts` — `PendingInjection` context threaded through remember/take; `optionCallbackData`/`parsePermissionCallback` extended with `po:<idx>:<requestId>` (≤64 bytes).
- `telegram-webhook.ts` — callback handler: transcript-tail pendings inject keystrokes (option or approve/deny), `takePendingPrompt` removal makes stale/replayed taps inject nothing; legacy stream-json `permission_response` path retained.

## VALIDATION bindings
- 20-03-01 (R-TG-06/T-20-06, CRITICAL NEGATIVE) → telegram-permission-failclosed.test.ts ✅ (malformed ⇒ zero pendings)
- 20-03-02 (R-TG-05/07/09, T-20-07/08/09) → telegram-permission-disambiguation.test.ts ✅ (same-requestId no-collision, unauthorized rejected, take-removes-once)
- 20-03-03 (R-TG-08/T-20-07) → telegram-keystroke-inject.test.ts ✅ (mapping per backend, correct-PTY-only, fail-closed unmappable, term.input not permission_response)

## MANUAL GATE (autonomous:false — NOT yet done)
1. **Per-backend keystroke byte capture** — `keystroke-map.ts` constants are provisional (`y\r`/`n\r`, `<n>\r`). Capture the literal accept/deny/option stdin bytes from a LIVE Claude TUI and a LIVE Codex TUI permission prompt; replace the constants.
2. **Live permission round-trip** — Telegram tap drives a real prompt on each backend; an ambiguous prompt surfaces nothing.
Until (1)/(2): wiring + fail-closed gating + disambiguation are complete + tested; only the byte values await live verification. `deferred:manual-gate`.

## Self-Check: PASSED
20 tests green; commit 32ef88f in log.

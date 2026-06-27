---
phase: 20-telegram-transcript-tail
plan: 05
subsystem: telegram
tags: [human-only-guard, tos, docs]
provides: [TelegramDispatchSource, automation_blocked outcome]
requires: [humanOnlyPtyGate, getSessionRunnerType]
key-files:
  modified:
    - hub/src/telegram/dispatch.ts
    - hub/src/api/telegram-webhook.ts
    - hub/test/telegram-human-only-guard.test.ts (created)
    - hub/test/telegram-dispatch.test.ts
    - docs/telegram-bridge.md
    - docs/claude-architecture-notes.md
    - CLAUDE.md
metrics: { tests: 4, commit: 8c26046 }
requirements: [R-TG-11, R-TG-12]
---

# Phase 20 Plan 05: Human-only guard + transcript-tail docs Summary

One-liner: Telegram inbound dispatch carries a `source` tag and passes the Phase-16 human-only PTY
guard so only a genuine human turn can drive a pty-interactive session (automation is rejected
before any PTY injection), and the whole transcript-tail architecture is documented to supersede
the old stream-json bridge.

## What shipped
- `dispatch.ts` — `TelegramDispatchSource` (`human` default | `scheduler`/`orchestrator-background`/`auto-dev`/`error-capture`); composes `humanOnlyPtyGate(resolve actor+runner_type)` into the gate list AFTER threshold+cost-cap (composes WITH the non-bypassable cap, never replaces it); the guard's `automation_blocked_on_pty:<actor>` skip maps to a distinct `automation_blocked` outcome (logged).
- `telegram-webhook.ts` — maps `automation_blocked` to a ToS-safe reply.
- Docs: `docs/telegram-bridge.md` rewritten for the transcript-tail era (backend-agnostic adapters, fail-closed keystroke injection keyed by (sessionId,requestId), write-arbitration turn lock, human-only guard, no-API-key invariant, Phase-17 break + Phase-20 rebuild). `docs/claude-architecture-notes.md` Phase-12 section marked SUPERSEDED. `CLAUDE.md` Docs map row updated.
- `docs:sync` NOT run — no endpoint changes (the webhook callback path is internal; no new/changed `/api/*` route).

## VALIDATION bindings
- 20-05-01 (R-TG-11/T-20-13, NEGATIVE) → telegram-human-only-guard.test.ts ✅ (human allowed on pty-interactive; scheduler-sourced rejected ⇒ automation_blocked, nothing injected; stream-json unaffected; default source=human)

## Self-Check: PASSED
4 tests green; commit 8c26046 in log. docs-drift: no `assistant_message:final`-only outbound description remains as current (Phase-12 notes explicitly marked superseded).

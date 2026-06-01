---
phase: 20-telegram-transcript-tail
plan: 02
subsystem: telegram
tags: [transcript-tail, bridge, re-source]
provides: [ensureSessionSubscribed, releaseSessionSubscription, transcript-manager, getTranscriptOpenContext]
requires: [TranscriptSource, selectAdapter]
key-files:
  created:
    - hub/src/telegram/transcript/manager.ts
    - hub/src/telegram/permission-surfacing.ts (placeholder; plan 03 fills)
    - hub/test/telegram-output-from-transcript.test.ts
  modified:
    - hub/src/telegram/bridge.ts
    - hub/src/telegram/dispatch.ts
    - hub/src/db/dal.ts
  deleted:
    - hub/test/telegram-bridge.test.ts (obsolete event-bus tests)
metrics: { tests: 7, commit: 12407c1 }
requirements: [R-TG-04]
---

# Phase 20 Plan 02: Telegram outbound re-sourced from transcript-tail Summary

One-liner: The Telegram bridge consumes the normalized `TranscriptEntry` stream via a
per-session transcript manager (one tail, many consumers) instead of the deleted
`assistant_message:final` event bus, preserving final-only forwarding + the working-message UX
+ per-chat serialization.

## What shipped
- `manager.ts` — per-session `TranscriptSource` registry; resolves the open ctx via `getTranscriptOpenContext`, opens the cliKind-selected adapter once, fans entries to N consumers; last-unsubscribe closes the source. Test resolver injectable.
- `getTranscriptOpenContext(sessionId)` DAL helper — cli_kind + project_dir + persisted transcript_path + codex rollout id (from pty_backend_id) by sessionId alone.
- `bridge.ts` rewritten — `bridgeConsumer` routes `assistant_text`→send/finalize, `tool_use`→working-message; no event-bus imports; `ensureSessionSubscribed`/`releaseSessionSubscription` manage per-session tails; idempotent boot; feature-gated on botToken.
- `dispatch.ts` — opens the transcript subscription lazily (dynamic `import('./bridge.ts')`) on inbound dispatch; lazy import keeps the bridge's command→launch→supervisor-registry chain out of dispatch's module-load graph (so the dispatch unit test's partial registry mock stays valid).

## Deviations
- [Rule 3 - blocking] Importing bridge statically into dispatch pulled a transitive `broadcastToUser` dependency that broke the dispatch unit test's partial `ws/registry` mock. Fixed by lazy dynamic import (smallest diff, no test rewrite). Added `getTranscriptOpenContext`/`getUsersWithTelegramDefaultSession`/`getSessionRunnerType` to that test's dal mock for resolvability.
- Deleted `telegram-bridge.test.ts` (entirely event-bus-driven; superseded by the transcript source) per plan ("the event-bus source is gone").

## VALIDATION bindings
- 20-02-01 (R-TG-04/T-20-04/05) → telegram-output-from-transcript.test.ts ✅ (final-only send, no streaming kind in the union, working-message UX, manager fan, bridge no longer imports the event bus)

## Self-Check: PASSED
7 tests green; commit 12407c1 in log.

---
phase: 20-telegram-transcript-tail
plan: 04
subsystem: telegram
tags: [pty, write-arbitration, turn-lock]
provides: [acquire, release, onTurnComplete, holder, queueDepth, allowResponseBypass]
requires: [TranscriptSource turn_complete, term.input relay]
key-files:
  created:
    - hub/src/telegram/turn-lock.ts
    - hub/test/pty-turn-lock.test.ts
  modified:
    - hub/src/telegram/bridge.ts
    - hub/src/ws/client.ts
metrics: { tests: 7, commit: 73b4e08 }
requirements: [R-TG-10]
---

# Phase 20 Plan 04: PTY write-arbitration turn lock Summary

One-liner: A per-session single-writer turn lock serializes the xterm and Telegram PTY writers —
a new human turn acquires before its bytes reach stdin, the other writer is queued (bounded FIFO),
the lock releases only on the observed `turn_complete` (or a safety TTL), and a permission response
is exempt so it never deadlocks.

## The write-arbitration rule (implemented)
- A new HUMAN TURN must `acquire(sessionId, writerId)` before its bytes reach PTY stdin.
- First acquirer = HOLDER; same-holder re-acquire is idempotent (streaming keystrokes within one turn).
- Another writer wanting a turn while held is QUEUED (FIFO, bound 16; overflow drops the OLDEST with a logged notice).
- The lock RELEASES only on an observed `turn_complete` for that session (transcript assistant/result entry; or a TUI prompt-ready marker in scrape fallback) — completion is the only safe arbiter when two writers feed one TUI stdin. A generous safety TTL (10 min) backstops a missed completion.
- On release the next queued writer is promoted (granted).
- A permission/question RESPONSE is EXEMPT from acquire (`allowResponseBypass`) — it completes the holder's in-flight turn rather than starting a new one; treating it as a new turn would deadlock.

## What shipped
- `turn-lock.ts` — module-level `Map<sessionId, {holder, queue[], acquiredAtMs, ttlTimer}>` (Redis = future seam); `acquire`/`release`/`onTurnComplete`/`holder`/`queueDepth`/`allowResponseBypass`; configurable bound + TTL for tests.
- `bridge.ts` — `turn_complete` transcript entry → `onTurnComplete(sessionId)` (one signal, two consumers: output finalize + lock release).
- `ws/client.ts` — `term.input` from the xterm panel gated through `acquire(sessionId, perConnectionWriterId)`; resize/attach/reattach bypass; stable `writerId` on `ClientWsData`.

## VALIDATION bindings
- 20-04-01 (R-TG-10/T-20-10/11/12) → pty-turn-lock.test.ts ✅ (queued-not-interleaved, FIFO promotion on turn_complete, overflow-drop-oldest, TTL release, response bypass)

## Self-Check: PASSED
7 tests green; commit 73b4e08 in log.

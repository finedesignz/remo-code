---
phase: 20-telegram-transcript-tail
plan: 04
type: execute
wave: 3
depends_on:
  - 20-01
  - 20-03
files_modified:
  - hub/src/telegram/turn-lock.ts
  - hub/src/ws/client.ts
  - hub/test/pty-turn-lock.test.ts
autonomous: true
requirements:
  - R-TG-10
must_haves:
  truths:
    - "Concurrent writers to one tmux-backed PTY (xterm + Telegram) are serialized by a single-writer turn lock per session held in the hub"
    - "A writer acquires the turn, injects one human turn, and the lock releases only on observed turn_complete (transcript assistant entry; or TUI prompt-ready in scrape fallback)"
    - "While held, other writers' input is QUEUED (bounded FIFO); per-session 'who holds the turn' state is exposed"
    - "A permission/question RESPONSE from the non-holder is allowed (answering a prompt is not a new turn)"
  artifacts:
    - path: "hub/src/telegram/turn-lock.ts"
      provides: "Per-session single-writer turn lock + bounded FIFO queue + holder state"
  key_links:
    - from: "term.input frame (xterm or telegram) → turnLock.acquire(sessionId, writerId)"
      to: "PTY stdin only when the writer holds the turn"
      via: "release on TranscriptSource turn_complete for that session"
      pattern: "acquire → inject → await turn_complete → release → dequeue next"
---

<objective>
Two writers, one PTY stdin. Arbitrate with a single-writer per-session turn lock so the xterm panel
and the Telegram bridge never interleave keystrokes mid-turn. Completion is detected from the same
transcript signal Phase 20 already tails.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/20-telegram-transcript-tail/20-CONTEXT.md
@.planning/phases/20-telegram-transcript-tail/20-RESEARCH.md
@.planning/architecture/interactive-pty-runner-SPEC.md
@hub/src/ws/client.ts
@hub/src/telegram/transcript/index.ts
@CLAUDE.md
</context>

<threat_model>
- **T-20-10 — Interleaved keystrokes corrupt input (HIGH).** Without arbitration, xterm bytes and
  Telegram bytes interleave on PTY stdin mid-turn → garbled/unintended commands. Mitigation:
  single-writer lock; only the holder's bytes reach stdin; others queued. Test asserts no interleave.
- **T-20-11 — Lock never releases / deadlock (MED).** If turn_complete is missed, the lock wedges and
  the session is stuck. Mitigation: release on observed turn_complete OR a generous safety TTL
  (logged), whichever first; queue is bounded (oldest-dropped-with-notice past the bound) so it can't
  grow unbounded. Test asserts release on a fixture turn_complete and TTL fallback.
- **T-20-12 — Permission response blocked by the lock (MED).** If a permission response (which
  completes the holder's in-flight turn) were treated as a new turn needing the lock, the prompt would
  deadlock. Mitigation: a permission/question RESPONSE is exempt from acquire — it is injected to the
  holder's in-flight turn directly. Test asserts a non-holder response is allowed.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Per-session turn lock + bounded FIFO + holder state</name>
  <files>hub/src/telegram/turn-lock.ts, hub/test/pty-turn-lock.test.ts</files>
  <read_first>
    - hub/src/ws/client.ts (where term.input frames are relayed to /ws/agent)
    - hub/src/telegram/transcript/index.ts (turn_complete entry)
  </read_first>
  <acceptance_criteria>
    - turn-lock.ts exposes acquire(sessionId, writerId) (queues if held), release(sessionId), onTurnComplete(sessionId) (releases + dequeues next), holder(sessionId)
    - acquire returns immediately to the first writer; a second writer is QUEUED (FIFO, bounded N); queue overflow drops oldest with a logged notice
    - release fires only on observed turn_complete (or a logged safety TTL)
    - a permission/question RESPONSE path bypasses acquire (injected to the holder's in-flight turn)
    - Tests: (a) second writer queued not interleaved, (b) release on fixture turn_complete, (c) non-holder response allowed
  </acceptance_criteria>
  <action>
    Implement a module-level `Map<sessionId, {holder, queue[], acquiredAtMs}>` (Redis is a future seam,
    same shape — note it). Subscribe its release to the session's TranscriptSource turn_complete (wired
    by the bridge that already opened the source). Keep it independent of the structured agent-protocol.
  </action>
  <verify>
    <automated>cd hub; bun test test/pty-turn-lock.test.ts 2>$null</automated>
  </verify>
  <done>Two PTY writers are arbitrated; no mid-turn interleave; permission responses unblocked.</done>
</task>

<task type="auto">
  <name>Task 2: Gate term.input injection through the lock</name>
  <files>hub/src/ws/client.ts</files>
  <read_first>
    - hub/src/ws/client.ts (term.input relay)
    - hub/src/telegram/turn-lock.ts
  </read_first>
  <acceptance_criteria>
    - A new human turn from either writer (xterm or Telegram) only reaches PTY stdin when that writer holds the turn; otherwise it is enqueued
    - A permission/question response is exempt (injected immediately to the holder's turn)
    - "who holds the turn" is queryable for UI/Telegram status
  </acceptance_criteria>
  <action>
    Wrap the existing term.input relay with `turnLock.acquire`. Tag each input frame with writerId
    (client connection id or 'telegram') + a kind ('turn' | 'response'). Responses skip the lock.
  </action>
  <verify>
    <automated>cd hub; bun run check-baseline 2>$null</automated>
  </verify>
  <done>The relay honors the turn lock; arbitration is enforced on the real injection path.</done>
</task>

</tasks>

<verification>
- Concurrent xterm + Telegram turns are serialized (queued), never interleaved
- Lock releases on observed turn_complete; TTL fallback logged
- Permission responses bypass the lock; no deadlock
- `bun run check-baseline` green
</verification>

<success_criteria>
One PTY, two writers, zero mid-turn corruption: a single-writer turn lock keyed on observed completion
arbitrates xterm and Telegram input, queues the loser, and lets permission responses through.
</success_criteria>

<output>
Create `.planning/phases/20-telegram-transcript-tail/20-04-SUMMARY.md` when done.
</output>

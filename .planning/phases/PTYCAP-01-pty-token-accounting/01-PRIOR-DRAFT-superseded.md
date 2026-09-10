# PTYCAP Phase 1 — PTY Token Accounting — PLAN

## Problem

A `stream-json` turn reports usage via `session-bridge.ts`'s `'result'` runner event
(`e.usage`) — one `usage_event` WS message on turn completion. A `pty-interactive`
turn never does this: `ClaudePtyBridge` (`claude-pty-bridge.ts`) is a deliberately
thin raw-byte relay (`interactive-pty-runner-SPEC.md` forbids it from importing
`RunnerEvent`/`agent-protocol`/`session-bridge`), so **no PTY turn has ever recorded
token usage, mid-turn or after**. A long TUI session can run for hours accruing real
subscription spend the hub has zero visibility into.

## Approach

The interactive `claude` CLI keeps its own on-disk JSONL transcript under
`~/.claude/projects/<slug>/*.jsonl` (same file the milestone-ASK
`session_transcript_tail` command already reads read-only). Each assistant-turn
record in that file carries the same `message.usage` block the SDK's stream-json
`result` event carries (`input_tokens` / `output_tokens` /
`cache_creation_input_tokens` / `cache_read_input_tokens` + `model`). That gives us
an out-of-band, PTY-bridge-untouched signal: **poll the transcript file, not the
PTY byte stream.**

New module `supervisor/src/usage/pty-usage-tail.ts` (`PtyUsageTailer`):
- One instance per live PTY session, started in `session-bridge.ts`'s
  `ensurePtyRunner()` (the existing PTY-session-lifecycle seam) alongside
  `pty.start(...)`, stopped on `onExit` / `session-bridge.stop()`.
- On an interval (`REMO_PTY_USAGE_POLL_MS`, default 20s — fast enough to catch a
  long TUI turn mid-flight, cheap enough not to matter), re-derives the transcript
  path via the **same safety-checked helpers session-read.ts already exports**
  (`resolveSessionDir`, `newestJsonl`, `realPathContained` — no new path logic, no
  new escape surface), reads the file, and parses NEW JSONL lines since the last
  tick (tracked by byte offset, not by full re-parse).
- For each new assistant record carrying a non-empty `usage` block, calls
  `onUsage({ model, usage })`. `session-bridge.ts` wires that straight into the
  existing `sendToHub({ type: 'usage_event', ... })` path, adding one new field:
  `runner: 'pty-interactive'`.
- Read-only, no spawn, no PTY write — same invariant class as
  `session_transcript_tail`. Never touches argv, env-sanitize, or the Rust host.

Hub side (additive only):
- `agent-protocol.ts` / `AgentUsageEvent` zod schema: optional
  `runner: z.enum(['stream-json','pty-interactive']).optional()` — omitted ⇒
  `'stream-json'` (back-compat with every existing sender).
- `token-usage-dal.ts`: `TokenUsageInput` gains `runnerType: 'stream-json' |
  'pty-interactive'`; `recordTokenUsage` writes it to a new `token_usage.runner_type`
  column. `token_usage_daily`'s rollup key/columns are **untouched** — it stays a
  combined-bucket cache (its job is cheap today/7d/total totals for the cost cap,
  which intentionally counts both buckets together); the per-runner split lives
  in the precise ledger table, matching how `sumUserTokenWindows` already treats
  `token_usage` as the source of truth over the daily cache.
- New `getTodayTokenTotalByRunner(userId, timezone)` — same tz-day boundary as
  `getTodayTokenTotal`, grouped by `runner_type`. This is the criterion-2 query.
- `ws/agent.ts` usage_event handler: thread `msg.runner ?? 'stream-json'` into
  `recordTokenUsage`.

## Files touched

- `hub/src/db/schema.sql` — additive `ALTER TABLE token_usage ADD COLUMN IF NOT
  EXISTS runner_type TEXT NOT NULL DEFAULT 'stream-json'` (+ CHECK constraint,
  idempotent `DO $$` guard matching the `sessions.runner_type` pattern already in
  this file). No backfill needed — DEFAULT covers existing rows.
- `hub/src/db/token-usage-dal.ts` — `runnerType` field, `runner_type` column in
  both INSERT statements' bound values, `getTodayTokenTotalByRunner`.
- `hub/src/ws/agent-protocol.ts` — optional `runner` on `AgentUsageEvent` (zod) +
  the plain-TS union type.
- `hub/src/ws/agent.ts` — pass `runnerType: msg.runner ?? 'stream-json'`.
- `supervisor/src/usage/pty-usage-tail.ts` — new: `PtyUsageTailer` class.
- `supervisor/src/runners/session-bridge.ts` — start/stop the tailer around
  `ensurePtyRunner()`; wire `onUsage` → `sendToHub` with `runner: 'pty-interactive'`.
- Tests: `hub/test/token-usage-dal.runner-bucket.test.ts` (or extend
  `usage-event-handler.test.ts`), `supervisor/test/pty-usage-tail.test.ts`.

## Explicit non-goals (per brief)

- No change to gate ENFORCEMENT (`dailyTokenCapGate` already sums ALL of
  `token_usage` regardless of `runner_type`, so a PTY turn recorded by this phase
  automatically counts toward the existing cap the moment it's written — that is
  accounting, not a new enforcement path; Phase 2 is where the PTY *pre-flight*
  gate chain gets built).
- No Rust / `pty_host.rs` / argv / env-sanitize changes.
- No change to `token_usage_daily`'s primary key or the cost-cap query.

## Assumptions

1. The interactive `claude` CLI's on-disk transcript record shape for an
   assistant turn is structurally compatible with the SDK stream-json `result.usage`
   shape (`message.usage.{input_tokens,output_tokens,cache_creation_input_tokens,
   cache_read_input_tokens}` + `message.model`) — this is the same assumption
   `session_transcript_tail` already relies on for its (text-only) reads; if a
   future CLI version renames the field, both break together and the existing
   `session_transcript_tail` canary/tests would already have caught the drift.
2. "Mid-turn observable" is proven by polling cadence < turn duration, not by an
   in-process hook into the CLI itself (no such hook is exposed to a raw PTY
   relay) — the tailer's own test proves it fires on a transcript write that has
   NOT yet been followed by a session/turn-exit event.
3. Cost for PTY-sourced usage is always `cost_source: 'estimated'` (the on-disk
   transcript does not reliably carry authoritative `total_cost_usd` the way an
   SDK `result` event does) — hub's existing `estimateCostUsd` fallback handles it
   unchanged.

## Definition of Done

1. **Criterion 1 (mid-turn observable)**: `supervisor/test/pty-usage-tail.test.ts`
   writes a transcript file, ticks the tailer once with only a partial (one
   assistant-with-usage) line present — no exit/completion signal anywhere in the
   test — and asserts `onUsage` fired with the right totals. Proves the signal
   does not depend on turn completion.
2. **Criterion 2 (separate buckets)**: `hub/test/token-usage-dal.runner-bucket.test.ts`
   records one `stream-json` and one `pty-interactive` usage event for the same
   user/day and asserts `getTodayTokenTotalByRunner` returns them split, and that
   `getTodayTokenTotal` (the existing cap query) still returns the SUM of both —
   i.e. Phase 2 enforcement will see PTY usage without any gate-chain change.
3. **Criterion 3 (mid-flight ceiling crossing detectable)**: extend the tailer
   test with two ticks against a growing transcript (simulating a long TUI turn
   still in progress) whose combined `cache_read_input_tokens` alone crosses an
   injected test cap value; assert `getTodayTokenTotal` (fed by the two
   `recordTokenUsage` calls the ticks produced) exceeds the cap BEFORE any
   third/exit tick — i.e. before the turn ends.
4. `cd C:/Users/artic/GitHub/remo-code-ptycap && bun install && bun run check-baseline`
   green (no new failures vs. baseline), plus `bun run typecheck` (or the repo's
   equivalent) clean.
5. `supervisor/test/no-api-key-no-streamjson-pty.test.ts`,
   `no-apikey-fallback-guard.test.ts`, `default-backend-selector.test.ts` all still
   pass, unmodified.

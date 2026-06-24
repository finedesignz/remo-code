# 15-02 SUMMARY — raw-terminal WS channel (Plan 02)

**Status:** COMPLETE. Commit `feat(hub+supervisor): Phase 15 Plan 02`.

## Built
- `hub/src/ws/term-protocol.ts` — standalone Zod schema (`term.data`/`term.input`/`term.resize`/
  `term.attach`), base64 byte payloads. NO agent-protocol/protocol import, NO RunnerEvent reference.
- `hub/src/ws/agent.ts` + `client.ts` — `term.*` relay branch short-circuits (early `return`) BEFORE the
  structured `*Inbound.safeParse`. Byte-faithful, keyed by session_id, reuses existing auth (client
  ownership via `getSession`; `term.input` license-gated like `send_message`). Never creates a `messages` row.
- `supervisor/src/runners/session-bridge.ts` — additive, flag-gated (`REMO_PTY_INTERACTIVE=1`) PTY path:
  `ensurePtyRunner` bridges `ClaudePtyRunner.onData → term.data`, routes inbound `term.input`/`term.resize`/
  `term.attach`; kill wired into `stop()` + terminal-close + `isAlive()`. stream-json path untouched when off.

## Tests (all green)
- `hub/test/term-channel-isolation.test.ts` (R-PTY-03) — static: term-protocol has no agent-protocol/
  RunnerEvent; relay short-circuits before safeParse; no insertMessage in the term branch.
- `supervisor/test/pty-byte-relay.test.ts` (R-PTY-02) — REAL ConPTY echo round-trip (Bun-parent + Node-host).

## QC
- `bun run check-baseline` GREEN (fail=0 with `JWT_SECRET` set; the worktree's bare fail=1 is the
  JWT_SECRET-env requirement of an unrelated test file — base commit was fail=3, so no regression).
- `hub/test/mount-order.test.ts` green (14/14).

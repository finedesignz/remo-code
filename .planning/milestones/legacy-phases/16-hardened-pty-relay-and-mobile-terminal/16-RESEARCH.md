# Phase 16: hardened-pty-relay-and-mobile-terminal - Research

**Researched:** 2026-05-31
**Phase requirement IDs:** R-PTY-06, R-PTY-07, R-PTY-08, R-PTY-09, R-PTY-10, R-PTY-11

> Answers: "What do I need to know to PLAN the hardened relay + mobile terminal + human-only guard well?"

## Summary

Phase 15 already de-risked the two hard unknowns (node-pty under Bun, and node-pty shipping from
`bun build --compile`). Phase 16's genuinely new risks are:

1. **tmux-backed persistence across disconnects (R-PTY-07)** — the cleanest reattach mechanism on POSIX
   is tmux (`new-session -d` + `attach-session`), but the remo dev host is Windows (ConPTY) where tmux is
   not native. The persistence mechanism must be portable or the Windows path explicitly documented.
2. **Human-only dispatch guard (R-PTY-10)** — a security boundary. It must compose into the EXISTING
   shared dispatch pipeline/gates (never a parallel path), keyed on dispatch source + runner type, and
   never weaken the non-bypassable cost cap.

Everything else (promoting the spike runner, authenticating the relay over opaque-cookie infra, mobile
xterm resize/reconnect/scrollback) hardens patterns already proven in Phase 15 and existing remo-code WS
auth.

## Key findings

### 1. claude-pty-runner.ts — promote the spike seed (R-PTY-06)
- The Phase-15 seed spawns `claude` with empty argv inside node-pty, `delete env.ANTHROPIC_API_KEY`, raw
  bytes only. Phase 16 hardens it: lifecycle (spawn/attach/kill), error/exit handling, resize plumbing,
  scrollback hooks — but keeps it RAW-BYTES-ONLY. It MUST NOT import `RunnerEvent`/`agent-protocol`/
  `session-bridge` (the Phase-15 isolation test stays green and is extended).
- It uses the Phase-15 SPIKE-FINDINGS shipping approach (native-beside-exe / helper-exe / out-of-band) —
  do NOT re-derive; consume the documented contract.

### 2. tmux-backed persistence + reattach (R-PTY-07)
- POSIX: run interactive `claude` inside a detached tmux session (`tmux new-session -d -s remo-<sessionId>
  claude`); the PTY host attaches via `tmux attach-session -t remo-<sessionId>`. A dropped relay leaves
  the tmux alive; reattach restores live state. Scrollback via tmux's own history (`capture-pane -p -S
  -<N>` for replay on attach).
- Windows: tmux is NOT native (no ConPTY-tmux). Options to evaluate in the plan: (a) WSL-hosted tmux,
  (b) a supervisor-side persistent PTY buffer (keep the node-pty process alive across client
  disconnects + replay a ring-buffer of recent output on reattach) as the portable equivalent of tmux
  reattach. The REQUIREMENT is "dropped connection reattaches with no lost state, scrollback intact" —
  tmux is the named mechanism but the persistence property is what's tested; document the Windows
  mechanism explicitly. Keeping the node-pty process owned by the supervisor (not the WS connection)
  already gives most of the persistence; tmux adds out-of-process survival across supervisor restarts.
- DECISION for the planner: prefer the supervisor-owned-persistent-PTY + output ring-buffer as the
  cross-platform baseline (works on Windows), and use tmux on POSIX where available for survival across
  supervisor restarts. The reattach test asserts: drop client → reconnect → last-N lines of scrollback
  present + the live prompt is interactive.

### 3. Authenticated raw-terminal relay end-to-end (R-PTY-08)
- Reuse the EXISTING opaque-cookie session/WS auth (`hub/src/ws/client.ts` token auth; `api_keys`-keyed
  `/ws/agent`). The raw-terminal frames ride the SAME authenticated WS connections as today — no new
  unauthenticated socket. The hub relays `term.*` frames between the matched `/ws/client` and
  `/ws/agent`, keyed by session_id, WITHOUT parsing payload bytes.
- Frame set (new Zod schema, SEPARATE from `agent-protocol.ts`): `term.data` (PTY→client bytes,
  base64/binary), `term.input` (client→PTY bytes), `term.resize {cols,rows}`, `term.attach`/
  `term.reattach` (+ optional scrollback replay request). Isolation test asserts these are defined
  outside `agent-protocol.ts` and carry no `RunnerEvent` coupling.

### 4. Mobile xterm.js: reconnect / resize / scrollback (R-PTY-09)
- `@xterm/xterm` + `@xterm/addon-fit` (installed in Phase 15). FitAddon computes cols/rows from the
  container; on resize send `term.resize` and `pty.resize(cols,rows)`. On reconnect, re-open the WS,
  send `term.reattach`, replay scrollback into the xterm buffer. Mobile: ensure the FitAddon handles the
  on-screen keyboard viewport change and orientation; touch-scroll maps to xterm scrollback.
- Theme via xterm `theme` option mapped from CSS custom properties (`--bg-primary`/`--text-primary`,
  blue accent). No indigo (`web/test/no-indigo.test.ts`).

### 5. Human-only dispatch guard (R-PTY-10) — security boundary
- The existing dispatch pipeline (`hub/src/dispatch/pipeline.ts`) already funnels every inbound
  user→session dispatch through shared gates (`hub/src/dispatch/gates.ts`, incl. the non-bypassable
  `dailyCostCapGate`). Add a NEW gate: for a session whose runner type is `pty-interactive`, REJECT any
  dispatch whose source is automation (scheduler / orchestrator-background / auto-dev / error-capture).
  Only genuine interactive human turns (and, post-Phase-20, human Telegram messages) may write the PTY.
- The guard is keyed on (dispatch source, session runner type). It composes with — never bypasses — the
  cost cap. A test asserts: automation source + PTY session ⇒ rejected; human interactive source + PTY
  session ⇒ allowed; automation source + stream-json session ⇒ unchanged (still cost-capped).

### 6. Per-session runner type (R-PTY-11)
- `cli_kind` (`'claude'|'codex'`) already exists on `sessions` (`schema.sql:355`, idempotent
  `ADD COLUMN IF NOT EXISTS`). Add an analogous per-session runner-type property
  (`runner_type` `'stream-json'|'pty-interactive'`, default `stream-json`), opt-in per session, via the
  same idempotent DDL pattern (NO backfill in schema.sql — backfills are one-shots in `hub/scripts/`).
- A Telegram-default session MUST NOT be switched to `pty-interactive` this phase — a guard prevents it.
  This is the seam Phase 20 reuses to move Telegram onto the PTY surface (transcript-tail) and SUPERSEDES
  the "Telegram stays stream-json" clause.

### 7. Canary + QC
- Extend `supervisor/test/no-api-key-no-streamjson-pty.test.ts` to cover `claude-pty-runner.ts` after
  hardening (still no `-p`/`--print`/stream-json, env still strips ANTHROPIC_API_KEY).
- `bun run check-baseline` (per-file isolation) stays green; new tests registered in
  `tools/regression-baseline.json`.

## Open technical questions for the plan to resolve
- Windows persistence mechanism: supervisor-owned persistent PTY + ring-buffer (baseline) vs WSL tmux —
  pick and document; the reattach test must pass on the dev host (Windows).
- Scrollback replay size/format (tmux `capture-pane` vs a supervisor ring-buffer cap) for a full-screen
  TUI on mobile bandwidth.
- Where runner-type is resolved at spawn time (process-manager vs index.ts) and how the human-only guard
  reads it from the dispatch context.

## Validation Architecture

Nyquist sampling must cover:
- **Runner-correctness sampling:** extended canary (no API key, no programmatic flags on the hardened
  runner) + env unit test.
- **Persistence sampling:** a reattach test that drops + reconnects and asserts scrollback + live prompt
  (the load-bearing R-PTY-07 proof; manual on a live TUI + scripted ring-buffer assertion).
- **Isolation sampling:** static assertion the relay path carries no `RunnerEvent` coupling (extends the
  Phase-15 isolation test).
- **Guard sampling:** automated test that automation sources are rejected for PTY sessions and human
  turns are allowed; cost cap unaffected.
- **Auth sampling:** the raw-terminal frames are rejected without a valid opaque-cookie session.

## Sources
- Phase 15 outputs: `15-RESEARCH.md`, SPIKE-FINDINGS (node-pty compile-shipping), `15-PLAN-001..003`.
- tmux man pages (`new-session`, `attach-session`, `capture-pane`); known Windows non-availability.
- Microsoft `node-pty` README (resize/onData/kill API; ConPTY/forkpty).
- `@xterm/xterm` + `@xterm/addon-fit` docs (FitAddon, theme option, scrollback).
- remo-code in-repo: `supervisor/src/runners/{claude-runner,session-bridge,types}.ts`,
  `hub/src/ws/{agent,client,protocol,agent-protocol}.ts`, `hub/src/dispatch/{pipeline,gates}.ts`,
  `hub/src/api/sessions.ts`, `hub/src/db/{dal,schema.sql}`, `supervisor/test/no-legacy-agent-spawn.test.ts`.

## RESEARCH COMPLETE

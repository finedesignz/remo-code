# Phase 17: codex-pty-runner-and-chatsurface-rip-and-replace - Research

**Researched:** 2026-05-31
**Phase requirement IDs:** R-PTY-12, R-PTY-13, R-PTY-14, R-PTY-15, R-PTY-16, R-TG-12

> Answers: "What do I need to know to PLAN the Codex PTY runner + the one-way-door rip safely?"

## Summary

The Codex runner is low-risk: a near-verbatim mirror of the Phase-16 `claude-pty-runner.ts` with the
spawned binary swapped to the interactive Codex CLI. The genuine risk is the DESTRUCTIVE part: deleting
ChatSurface/bubble rendering and hub translation WITHOUT (a) deleting translation that automation still
needs (Phase 18), or (b) silently breaking Telegram. Both are managed by import-graph discipline +
explicit break markers + the sequencing safeguard (deletions only after 15–16 verification passes).

## Key findings

### 1. Codex PTY runner (R-PTY-12) — mirror the Phase-16 Claude runner
- Phase 05 already established Codex CLI invocation + `cli_kind='codex'` (see `docs/codex-and-rootless.md`).
  The PTY runner spawns the INTERACTIVE Codex CLI (no programmatic/headless flags) inside node-pty, raw
  bytes only, reusing the Phase-16 PTY host + persistence + raw-terminal WS + tmux. It does NOT import
  RunnerEvent/agent-protocol/session-bridge.
- Backend-agnostic seam: the per-session `runner_type='pty-interactive'` (Phase 16) combined with
  `cli_kind` selects which `*-pty-runner.ts` the supervisor instantiates. The relay + surface are
  identical across backends.
- Extend the canary (`supervisor/test/no-api-key-no-streamjson-pty.test.ts`) to cover the Codex runner:
  no programmatic flags, env hygiene (no ANTHROPIC_API_KEY on the spawn path).

### 2. DELETE the stream-json human chat UI (R-PTY-13)
- Targets in `web/src`: `ChatSurface.tsx` (+ `full`/`cell`/`mobile-expanded` variants),
  `ChatSurfaceShowcase.tsx`, `ChatPanel.tsx`, the structured activity-bubble rendering
  (thinking/text_delta/tool_use/tool_result) wherever it's rendered (ChatLayout, GridPage), and the hooks
  feeding it (`useChatSurface.ts`, parts of `useChat.ts`). The Phase-16 `TerminalSurface` replaces it.
- A new test asserts no `ChatSurface`/structured-bubble render path remains for HUMAN sessions (static
  grep + render-path assertion). Automation has no web UI, so this is human-session-scoped.
- DANGER: ChatLayout/GridPage also host nav/sidebar chrome and the terminal surface — delete the
  conversation rendering, NOT the shell. Smallest diff: replace the conversation region with
  `TerminalSurface`, remove the bubble components.

### 3. Remove DEAD hub translation; PRESERVE automation translation (R-PTY-14)
- The hub translates supervisor RunnerEvents (via `session-bridge.ts` → `agent-protocol.ts`) into
  `/ws/client` broadcast messages that fed the deleted bubbles. Some of that broadcast exists ONLY for
  the human UI; some is consumed by automation (scheduler/error-capture finalize, usage_event capture,
  Telegram — until Phase 17 removes its source).
- METHOD: import-graph / usage analysis. For each translation/broadcast path, determine whether any
  NON-human-UI consumer remains after R-PTY-13. If yes → PRESERVE. If the ONLY consumer was the deleted
  UI → remove. WHEN AMBIGUOUS → PRESERVE (deleting automation-needed translation breaks Phase 18 silently
  — the costlier error). `usage_event`/`token_usage` capture (cost cap) MUST be preserved (it's the
  non-bypassable cost source).
- The runner-side stream-json path (`claude-runner.ts` spawn + `session-bridge.ts`) is PRESERVED whole
  (R-PTY-16) — only its human-UI-feeding broadcast translation is candidate for removal.

### 4. Route ALL human sessions to the terminal surface (R-PTY-15)
- After R-PTY-13, every human session (Claude + Codex) renders on `TerminalSurface`. Grid/list views
  either host terminal cells (xterm per cell) or drop conversation rendering. Decision left to the
  planner (smallest diff); the Phase-16 grid context (`GridPage.tsx`, `user_grid_state`) informs it.

### 5. Explicit, not silent, Telegram break (R-TG-12)
- Removing the stream-json human runner's broadcast removes the Telegram bridge's structured-event source
  (`assistant_message:final`/`tool_use`) AND the `permission_request`→`onPermissionPending` path
  (`hub/src/telegram/bridge.ts`, `approvals.ts`). After Phase 17, Telegram is NON-FUNCTIONAL.
- REQUIRED: at each removed source point, a comment
  `// Phase 17 rip: Telegram event source removed here; rebuilt in Phase 20 (transcript-tail).` The
  Telegram bridge module is NOT deleted (Phase 20 re-sources it). A grep test asserts the comment markers
  exist and `hub/src/telegram/bridge.ts` still exists.

### 6. QC / regression (R-PTY-16)
- `bun run check-baseline` + `cd web; bun run build` + `web/test/no-indigo.test.ts` stay green. The
  baseline shrinks where human-UI tests are deleted; update `tools/regression-baseline.json` accordingly
  and ensure no PRESERVED automation path regresses.

## Open technical questions for the plan to resolve
- Exact interactive Codex CLI entrypoint/argv (no headless/programmatic flags) — confirm against the
  installed Codex CLI version (undocumented/version-unstable; re-verify, per Phase-20 note on Codex).
- The precise import-graph boundary between "human-UI-only" and "automation-shared" hub translation —
  enumerate in the plan before deleting; when ambiguous, preserve.
- Grid: terminal-cells vs drop-conversation-rendering — pick during planning.

## Validation Architecture

Nyquist sampling must cover:
- **Codex-runner-correctness sampling:** extended canary (no programmatic flags; env hygiene) + tsc.
- **Deletion-completeness sampling:** static test that no `ChatSurface`/structured-bubble path remains
  for human sessions (R-PTY-13).
- **Preservation sampling:** automation paths (usage_event/cost-cap capture, scheduler/error-capture
  finalize) still function after the rip — a regression test asserts the cost-cap + a scheduled-style
  dispatch still work end-to-end (R-PTY-14/16). THIS is the load-bearing safety check.
- **Explicit-break sampling:** grep test for the Phase-17 Telegram-break comment markers + bridge module
  still on disk (R-TG-12).
- **Theme sampling:** `web/test/no-indigo.test.ts` green; `bun run build` succeeds.

## Sources
- Phase 15/16 outputs (PTY host, persistence, raw-terminal WS, human-only guard, runner_type, no-indigo).
- `docs/codex-and-rootless.md` (Phase 05 Codex CLI runner + rootless + `cli_kind`).
- remo-code in-repo: `supervisor/src/runners/{claude-pty-runner,claude-runner,session-bridge,types}.ts`,
  `web/src/components/{ChatSurface,ChatLayout,ChatPanel,GridPage}.tsx`, `web/src/hooks/{useChatSurface,useChat}.ts`,
  `hub/src/ws/{agent,agent-protocol,client,protocol}.ts`, `hub/src/telegram/{bridge,approvals,dispatch}.ts`,
  `hub/src/dispatch/{pipeline,gates}.ts`, `web/test/no-indigo.test.ts`.

## RESEARCH COMPLETE

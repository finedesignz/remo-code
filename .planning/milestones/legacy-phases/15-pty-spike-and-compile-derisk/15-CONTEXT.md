# Phase 15: pty-spike-and-compile-derisk - Context

**Gathered:** 2026-05-31
**Status:** Ready for planning
**Source:** Approved design spec `.planning/architecture/interactive-pty-runner-SPEC.md` (committed 6ef6953) + user RIP-AND-REPLACE override

<domain>
## Phase Boundary

Phase 15 is the **PTY spike + compile-derisk**. It proves, end-to-end and minimally, that the genuine
*interactive* `claude` TUI can run inside a PTY on the supervisor host, stream raw terminal bytes over a
NEW dedicated WS channel to a themed xterm.js panel embedded in the existing React shell, accept a typed
human turn, and render the TUI — all WITHOUT an API key and WITHOUT touching the structured
`/ws/agent` RunnerEvent pipeline.

The spike is **not throwaway**: it is the seed of `claude-pty-runner.ts` (Phase 16). Its single most
important job is to **derisk the known blocker**: `node-pty` is a native addon and does NOT bundle into
`bun build --compile` (the Tauri sidecar). Phase 15 must determine and demonstrate the shipping approach
and write it into a spike-findings artifact Phase 16 consumes.

**In scope:** minimal PTY spawn of interactive `claude`; raw byte relay in/out; one new WS channel
(client to hub to supervisor); minimal xterm.js panel themed with existing tokens; a working
demonstration of how `node-pty` ships from the compiled sidecar (or a documented out-of-band PTY-host
launch); canary tests for the no-API-key / no-stream-json-flags invariants; spike-findings doc.

**Out of scope (later phases):** tmux persistence + reattach (Phase 16); production hardening / resize /
scrollback / mobile (Phase 16); Codex PTY runner + ChatSurface deletion (Phase 17); dual-bucket billing
poll (Phase 18); June-15 cutover gate + Gemini fallback (Phase 19). One supervisor SSH-ing to a different
machine is permanently OUT (run a supervisor per host).
</domain>

<decisions>
## Implementation Decisions (LOCKED — from spec hard constraints + override)

### No API key — ever (constraint 1, NON-NEGOTIABLE)
- No code path may pass `ANTHROPIC_API_KEY` (or any API-platform key) to a spawned `claude`.
- The existing `delete env.ANTHROPIC_API_KEY` at `supervisor/src/runners/claude-runner.ts:94` STAYS.
- The new PTY spawn MUST do the same `delete env.ANTHROPIC_API_KEY`.
- There is NO API-key fallback anywhere. If PTY fails, fallback is Codex/Gemini (Phase 19), not an API key.

### Official client only; never reuse the OAuth token (constraint 2)
- Spawn the official `claude` binary only. Never extract, store, present, or reuse the OAuth token.
- Auth is delegated entirely to the official client. No remo-code auth changes for Claude credentials.

### Only genuine human turns touch the PTY runner (constraint 3)
- Phase 15 spike is human-driven by definition. The formal automation-rejection guard is Phase 16
  (R-PTY-10), but the spike MUST NOT wire any automation/scheduler dispatch into the PTY path.

### Auth via `claude login` (constraint 4)
- Default to the `login` (interactive OAuth, localhost redirect, run locally per host) credential.
- Treat `setup-token` as suspect — do NOT build the spike around setup-token.

### Interactive `claude` only — no programmatic flags (constraint 5)
- Spawn interactive `claude` with NO `-p`, NO `--print`, NO `--input-format stream-json`, NO
  `--output-format stream-json`, NO `--verbose` programmatic combo. Raw TUI in a PTY.
- The raw-terminal WS channel MUST stay isolated from the structured `/ws/agent`
  RunnerEvent to agent-protocol pipeline in `session-bridge.ts`. The PTY runner does NOT translate to
  the `RunnerEvent` union — it ships raw bytes.

### node-pty / ConPTY + bun-compile (constraint 6 — the derisk)
- Use `node-pty` (ConPTY on Windows). KNOWN BLOCKER: native addon does not bundle into
  `bun build --compile`. Phase 15 MUST demonstrate one of: (a) bundle/ship the native `.node` module
  alongside the sidecar, (b) ship a small helper exe that hosts the PTY, or (c) run the PTY host
  out-of-band and connect to it. Document the chosen approach + a working proof for Phase 16.

### RIP-AND-REPLACE override (user decision — supersedes the spec's Embed-A "keep stream-json chat" text)
- The end state is ONE raw-terminal surface for ALL human sessions (Claude AND Codex). The stream-json
  ChatSurface human chat UI is deleted (Phase 17), not kept. For Phase 15, this means: build the
  terminal panel as the seed of the single human surface — do NOT invest in the old ChatSurface path.
- stream-json survives ONLY as an unattended-automation transport (Phase 18), never as a human chat UI.

### Theme (design preferences)
- xterm.js panel themed with existing tokens `--bg-primary`/`--text-primary`, BLUE accent (never indigo;
  orange is CTA-only). App chrome (sidebar/nav/fonts) unchanged. `web/test/no-indigo.test.ts` stays green.

### Claude's Discretion
- Exact spike file locations (suggest `supervisor/src/runners/pty-spike.ts` or a `claude-pty-runner.ts`
  seed), the WS frame schema (data/resize/reattach), and whether to prove the compile-shipping in this
  worktree's Tauri build or in an isolated reproduction — the planner picks the smallest credible diff.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source spec (authoritative)
- `.planning/architecture/interactive-pty-runner-SPEC.md` — the full approved design + hard constraints + phased plan + "verify after June 15" gates.

### Existing runner / usage code (patterns to mirror, env-delete to replicate)
- `supervisor/src/runners/claude-runner.ts` — current stream-json spawn (argv ~lines 79-84) and the `delete env.ANTHROPIC_API_KEY` at line 94 that MUST be replicated.
- `supervisor/src/usage/oauth-poll.ts` — reads `~/.claude/.credentials.json`; shows OAuth handling that must NOT change (token never serialized to hub).
- `supervisor/src/index.ts` — supervisor entry; how runners are instantiated/hosted per session.

### Hub WS + structured pipeline (the boundary the raw-terminal channel must NOT cross)
- `hub/src/ws/agent.ts` and `hub/src/ws/protocol.ts` + `agent-protocol.ts` — structured `/ws/agent` pipeline; the new raw-terminal channel is separate.
- `hub/src/ws/client.ts` (or equivalent `/ws/client` handler) — browser WS; relay target for raw frames.

### Web shell + theming
- `web/src` ChatSurface + shell components — what the terminal panel embeds beside (and what Phase 17 deletes).
- `web/test/no-indigo.test.ts` — accent guard that must stay green.
- `~/.claude/design-preferences.md` — accent=blue, orange CTA-only, never indigo (read before any UI work).

### Build / sidecar
- `supervisor/tauri/` + `bun build --compile` sidecar build — the compile target where `node-pty` must ship.

### Cross-cutting invariants
- `.planning/STATE.md` "do not violate" section + repo `CLAUDE.md` cross-cutting invariants (cost-cap non-bypassable, schema.sql idempotent, mount-order, dispatch pipeline).
</canonical_refs>

<specifics>
## Specific Ideas

- Verification (build-time, from spec): re-confirm spawn argv + env (NO `ANTHROPIC_API_KEY`; interactive
  `claude`, no `-p`/stream-json); prove input injection renders as a normal typed turn in the TUI;
  confirm the raw-terminal channel is isolated from the structured agent-protocol (no RunnerEvent coupling).
- Canary test pattern exists already: `supervisor/test/no-legacy-agent-spawn.test.ts` greps argv — mirror
  it for a `no-api-key-no-streamjson-in-pty` canary.
- QC gate: `bun run check-baseline` (per-file isolation, `tools/regression-baseline.json`) must stay green.
</specifics>

<deferred>
## Deferred Ideas

- tmux persistence + reattach, resize, scrollback, mobile hardening → Phase 16.
- Codex PTY runner + ChatSurface/bubble deletion + dead hub translation removal → Phase 17.
- Dual-bucket usage poll + programmatic-leak alert/hard-halt → Phase 18.
- June-15 cutover-gate runbook + Gemini fallback seam + final docs sweep → Phase 19.
- The actual June-15 billing-classification MEASUREMENT (gates the default-on cutover, not the build).
</deferred>

---

*Phase: 15-pty-spike-and-compile-derisk*
*Context gathered: 2026-05-31 from approved spec + RIP-AND-REPLACE override*

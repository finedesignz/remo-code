# Phase 16: hardened-pty-relay-and-mobile-terminal - Context

**Gathered:** 2026-05-31
**Status:** Ready for planning
**Source:** Approved design spec `.planning/architecture/interactive-pty-runner-SPEC.md` (committed 6ef6953) + user RIP-AND-REPLACE override. Consumes Phase 15 SPIKE-FINDINGS (node-pty compile-shipping approach).

> **OPERATOR DECISION (2026-05-31) — supersedes the "tmux for persistence" / node-pty-shipping assumptions below where they imply a bundled-Node host.** Option C (Rust ConPTY — PTY hosting in the Tauri Rust process, Bun relays bytes over a local channel) is the TARGET end-state, **GATED** on a Task-0 derisk spike in 16-PLAN-001 (spawn the genuine interactive `claude` TUI from Rust via wezterm `portable-pty`/`conpty`, capture the real trust prompt, confirm byte round-trip, `ANTHROPIC_API_KEY` removed, no programmatic flags). PASS → Option C (Node `pty-host.mjs` detour dropped on Windows; the Phase-15 node-pty compile-shipping approach + tmux/ring-buffer notes apply to the FALLBACK only). FAIL → Option A (bundled portable node.exe + node-pty + pty-host.mjs — Phase-15-proven). The locked constraints 1-5 (no API key, official client only, human-only, `claude login`, interactive-only no programmatic flags) hold UNCHANGED on either branch.

<domain>
## Phase Boundary

Phase 16 **productionizes the Phase-15 spike into a hardened, mobile-ready PTY relay.** It promotes the
spike seed into a real `supervisor/src/runners/claude-pty-runner.ts`, makes the interactive session
**survive phone/browser disconnects** via tmux, authenticates the raw-terminal WS channel through the
existing opaque-cookie infra, gives the xterm.js surface mobile reconnect/resize/scrollback, and adds the
**human-only dispatch guard (constraint 3)** that rejects automation sources from ever touching the PTY.

This phase does NOT delete anything (the rip is Phase 17). It runs the PTY surface as a NEW, opt-in,
per-session runner type ALONGSIDE the existing stream-json ChatSurface, so the surface is mechanically
proven before the one-way-door deletion. Building + proving here is the sequencing safeguard.

**In scope:**
- `claude-pty-runner.ts` — interactive `claude` in a node-pty PTY, `delete env.ANTHROPIC_API_KEY`, raw
  bytes only, NO RunnerEvent translation, using the Phase-15 sidecar-shipping approach (R-PTY-06).
- tmux-backed persistence + reattach: a dropped connection reattaches with no lost state, scrollback
  intact (R-PTY-07).
- Authenticated raw-terminal WS relay end-to-end: `/ws/client` ↔ `/ws/agent`, opaque-cookie auth,
  data/resize/reattach/scrollback frames, isolated from the structured agent-protocol (R-PTY-08).
- Mobile xterm.js surface: reconnect, resize (cols/rows propagate to PTY), scrollback (R-PTY-09).
- Human-only dispatch guard rejecting scheduler / orchestrator-background / auto-dev / error-capture
  from PTY sessions (R-PTY-10).
- Per-session runner type (PTY-interactive vs stream-json), opt-in; Telegram-default sessions MUST NOT
  be switched to PTY (R-PTY-11 — holds until Phase 17/20 re-source Telegram).

**Out of scope (later phases):** Codex PTY runner + ChatSurface/bubble deletion + dead hub translation
removal (Phase 17); dual-bucket billing poll + programmatic-leak halt (Phase 18); June-15 cutover gate +
Gemini fallback (Phase 19); Telegram transcript-tail + permission injection + write-arbitration turn lock
(Phase 20). One supervisor SSH-ing to another machine is permanently OUT (supervisor per host).
</domain>

<decisions>
## Implementation Decisions (LOCKED — from spec hard constraints + override)

### No API key — ever (constraint 1, NON-NEGOTIABLE)
- `claude-pty-runner.ts` MUST build env as `{ ...process.env }` then `delete env.ANTHROPIC_API_KEY`
  (parity with `claude-runner.ts:94`). No API-key fallback anywhere. If PTY fails, fallback is
  Codex/Gemini (Phase 19), never an API key.

### Official client only; never reuse the OAuth token (constraint 2)
- Spawn the official `claude` binary only. The runner never reads, stores, presents, or forwards
  `~/.claude/.credentials.json`; it never imports oauth-poll internals. Auth delegated to the client.

### Only genuine human turns touch the PTY runner (constraint 3, ENFORCED THIS PHASE)
- A dispatch guard rejects non-interactive/automation sources (scheduler, orchestrator-background,
  auto-dev, error-capture). Automation must NOT be injected into the interactive PTY — that is the
  flagged "robot pressing enter via the interactive entrypoint" move. A test asserts an
  automation-sourced dispatch to a PTY session is rejected.

### Auth via `claude login` (constraint 4)
- Rely on the host's existing `claude login` credential. Treat `setup-token` as suspect; do not build
  the relay around it.

### Interactive `claude` only — no programmatic flags (constraint 5)
- Spawn interactive `claude` with NO `-p`, `--print`, `--input-format stream-json`,
  `--output-format stream-json`. The Phase-15 canary (`no-api-key-no-streamjson-pty.test.ts`) is
  extended to cover the productionized runner.
- The raw-terminal WS channel MUST stay isolated from the structured `/ws/agent` RunnerEvent →
  agent-protocol pipeline (`session-bridge.ts`). The PTY runner ships raw bytes; it does NOT translate
  to the `RunnerEvent` union and does NOT import `agent-protocol`/`session-bridge`.

### PTY hosting strategy — Option C (Rust ConPTY) target, spike-gated, Option A fallback (OPERATOR, 2026-05-31)
- See the operator-decision callout at the top of this file. 16-PLAN-001 OPENS with a Task-0 Rust-ConPTY
  derisk spike that decides the branch. The "tmux for persistence" and node-pty-shipping items below describe
  the FALLBACK (Option A) host; on Option C the PTY lives in the Tauri Rust process and the ring-buffer/tmux
  persistence is owned by that Rust host.

### tmux for persistence (R-PTY-07)
- The interactive `claude` runs INSIDE a tmux session keyed per remo session, so the PTY host can
  `new-session`/`attach-session` and a dropped client reattaches the same tmux with scrollback intact.
  The supervisor owns the tmux lifecycle; the relay attaches to it. On Windows the tmux dependency is
  the open portability question — see RESEARCH (tmux-availability + fallback).

### Per-session runner type (R-PTY-11)
- Runner type is a per-session property (`pty-interactive` vs `stream-json`), opt-in per session,
  resolved alongside the existing `cli_kind` (`'claude' | 'codex'`). A Telegram-default session MUST
  NOT be switched to the PTY runner this phase — a guard prevents it (superseded by Phase 20, which
  moves Telegram onto the PTY surface via transcript-tail; the seam built here is what Phase 20 reuses).

### Theme (design preferences)
- xterm.js surface themed with existing tokens `--bg-primary`/`--text-primary`, BLUE accent (never
  indigo; orange is CTA-only). App chrome (sidebar/nav/fonts) unchanged. `web/test/no-indigo.test.ts`
  stays green.

### Claude's Discretion
- The exact raw-terminal frame schema (`term.data`/`term.input`/`term.resize`/`term.attach`), whether
  the per-session runner-type lives as a new `sessions` column or is derived from an existing field,
  the tmux session-naming convention, and whether scrollback replay is tmux-`capture-pane` or
  PTY-buffer-backed — the planner picks the smallest credible diff consistent with the Phase-15 channel
  and SPIKE-FINDINGS shipping approach.
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source spec + Phase-15 outputs (authoritative)
- `.planning/architecture/interactive-pty-runner-SPEC.md` — full design, hard constraints, phased plan, June-15 gates.
- `.planning/phases/15-pty-spike-and-compile-derisk/15-RESEARCH.md` + the Phase-15 SPIKE-FINDINGS artifact — the chosen node-pty compile-shipping approach (a/b/c) this phase consumes on the Option-A FALLBACK branch (not re-derived).
- `.planning/phases/15-*/15-PLAN-001..003` — the spike seed (`claude-pty-runner.ts` start, raw-terminal channel, xterm panel) this phase hardens.

### Existing runner / usage code (patterns to mirror, env-delete to replicate)
- `supervisor/src/runners/claude-runner.ts` — current stream-json spawn (argv ~79-84) and `delete env.ANTHROPIC_API_KEY` (line ~94) to replicate.
- `supervisor/src/runners/session-bridge.ts` — RunnerEvent→agent-protocol translation; the boundary the PTY path must NOT cross. The PTY relay is a SEPARATE channel.
- `supervisor/src/runners/types.ts` — `CliRunner`/`RunnerEvent`/`AgentToHub`/`HubToAgent`; align naming, do NOT reuse RunnerEvent on the PTY path.
- `supervisor/src/usage/oauth-poll.ts` — read-only `~/.claude/.credentials.json` pattern that must NOT change (token never serialized).
- `supervisor/src/process-manager.ts` + `supervisor/src/index.ts` — how runs/runners are hosted per session; where the per-session runner type is resolved and the human-only guard hooks in.

### Hub WS + dispatch (the boundary + the guard seam)
- `hub/src/ws/agent.ts`, `hub/src/ws/agent-protocol.ts` (kinds: thinking/text_delta/tool_use/tool_result/status/assistant_message/permission_request/user_question/usage_event), `hub/src/ws/protocol.ts`, `hub/src/ws/client.ts` — structured pipeline; the new raw-terminal channel rides the same WS connections on a DISTINCT envelope.
- `hub/src/dispatch/pipeline.ts` + `hub/src/dispatch/gates.ts` — the shared dispatch pipeline + non-bypassable cost-cap gate; the human-only guard is a NEW gate here (reject automation sources for PTY sessions), composed with the existing gates, never bypassing the cost cap.
- `hub/src/api/sessions.ts` (`cli_kind: z.enum(['claude','codex'])`), `hub/src/db/dal.ts`, `hub/src/db/schema.sql` (cli_kind column + idempotent DDL) — where per-session runner type is stored/resolved.

### Web shell + theming
- `web/src/components/ChatSurface.tsx` + `ChatLayout.tsx` + `ChatPanel.tsx` + `GridPage.tsx` + `web/src/hooks/useChatSurface.ts` — what the terminal surface runs ALONGSIDE this phase (and what Phase 17 deletes).
- `web/test/no-indigo.test.ts` — accent guard that must stay green.
- `~/.claude/design-preferences.md` — accent=blue, orange CTA-only, never indigo (read before any UI work).

### Build / sidecar
- `supervisor/tauri/` + `bun build --compile` sidecar build + `supervisor/tauri/scripts/build-and-update.ps1` — the compile target. On the Option-A FALLBACK branch node-pty must ship here per the Phase-15 approach; on the Option C primary branch the PTY is hosted in the Tauri Rust crate (`src-tauri/`) and NO JS runtime is bundled for the PTY path.

### Cross-cutting invariants
- `.planning/STATE.md` "do not violate" + repo `CLAUDE.md` cross-cutting invariants (cost-cap non-bypassable via `dailyCostCapGate`, schema.sql idempotent DDL only, mount-order, dispatch pipeline single source).
</canonical_refs>

<specifics>
## Specific Ideas

- Extend the Phase-15 canary `supervisor/test/no-api-key-no-streamjson-pty.test.ts` to cover the
  productionized `claude-pty-runner.ts` (still no API key, no programmatic flags).
- tmux reattach proof: a test/demo that drops the relay connection mid-session and re-attaches, asserting
  scrollback + session state intact (R-PTY-07). On Windows, probe tmux availability and document the
  chosen persistence mechanism if tmux is unavailable.
- Human-only guard: model it as a new gate in `hub/src/dispatch/gates.ts` composed into
  `hub/src/dispatch/pipeline.ts`, keyed on the dispatch source + the session's runner type. A test
  asserts a scheduler/auto-dev/error-capture/orchestrator-background dispatch to a PTY session is
  rejected, and a genuine interactive turn is allowed.
- QC gate: `bun run check-baseline` (per-file isolation, `tools/regression-baseline.json`) stays green.
</specifics>

<deferred>
## Deferred Ideas

- Codex PTY runner + ChatSurface/bubble deletion + dead hub translation removal → Phase 17.
- Dual-bucket usage poll + programmatic-leak alert/hard-halt → Phase 18.
- June-15 cutover-gate runbook + Gemini fallback seam → Phase 19.
- Telegram on the PTY surface (transcript-tail, permission injection, write-arbitration turn lock) →
  Phase 20 (supersedes R-PTY-11's "Telegram stays stream-json").
</deferred>

---

*Phase: 16-hardened-pty-relay-and-mobile-terminal*
*Context gathered: 2026-05-31 from approved spec + RIP-AND-REPLACE override + Phase-15 outputs*
*Realigned 2026-05-31: operator decision — Option C (Rust ConPTY) target, spike-gated, Option A fallback.*
</content>

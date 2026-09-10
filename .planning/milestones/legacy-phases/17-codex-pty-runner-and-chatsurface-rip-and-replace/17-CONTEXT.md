# Phase 17: codex-pty-runner-and-chatsurface-rip-and-replace - Context

**Gathered:** 2026-05-31
**Status:** Ready for planning
**Source:** Approved design spec `.planning/architecture/interactive-pty-runner-SPEC.md` (committed 6ef6953) + user RIP-AND-REPLACE override. **Sequenced strictly AFTER Phases 15–16 prove the terminal surface works (one-way-door safeguard).**

<domain>
## Phase Boundary

Phase 17 **executes the rip-and-replace override.** It (a) adds a Codex interactive/PTY runner so Codex
human sessions also run on the raw-terminal surface, (b) DELETES the stream-json human chat UI entirely
from `web/src`, (c) removes now-dead hub agent-protocol→bubble translation that exists ONLY to feed that
UI, while PRESERVING the stream-json runner path for unattended automation (Phase 18 owns its routing).

**This is the one-way door.** Per the sequencing safeguard it runs ONLY after Phases 15–16 mechanically
prove the universal terminal surface (node-pty shipping, render fidelity, input injection, tmux/persistence
reattach, mobile resize/scrollback, authenticated relay, human-only guard). Deleting ChatSurface/stream-json
human UI is permanent within this branch (revert = git history only); the user has accepted this trade.

**EXPLICIT BREAK (not silent):** deleting the stream-json human runner removes the Telegram bridge's
structured event source (`assistant_message:final` / `tool_use` on the hub event bus + the
`permission_request`→`onPermissionPending` path). Phase 17 leaves Telegram **non-functional**. Phase 17
SHALL leave a code comment / SUMMARY note at EACH removed Telegram source point pointing to Phase 20, and
MUST NOT delete the Telegram bridge module wholesale (Phase 20 re-sources it on transcript-tail).

**In scope:**
- `supervisor/src/runners/codex-pty-runner.ts` — Codex human sessions on the raw-terminal surface,
  reusing the Phase-16 PTY host + raw-terminal WS + tmux/persistence; backend-agnostic seam (R-PTY-12).
- DELETE `web/src` stream-json human chat UI: `ChatSurface` (`full`/`cell`/`mobile-expanded` variants),
  structured activity-bubble rendering (thinking/text_delta/tool_use/tool_result), grid/list conversation
  rendering of structured activity (R-PTY-13).
- Remove hub agent-protocol→bubble translation that exists ONLY to feed the deleted human UI; PRESERVE
  translation needed by unattended automation (Phase 18) (R-PTY-14).
- Route ALL human sessions (Claude AND Codex) to the single themed xterm.js terminal surface; grid/list
  views host terminal cells or drop conversation rendering (R-PTY-15).
- PRESERVE the runner-side stream-json path end-to-end for automation transports; only its human chat UI
  is removed; baseline + `no-indigo` tests stay green (R-PTY-16).
- Make the Phase-17 Telegram break EXPLICIT (code comment / SUMMARY pointing to Phase 20); do NOT delete
  the Telegram bridge module wholesale (R-TG-12).

**Out of scope (later phases):** dual-bucket billing poll + programmatic-leak halt (Phase 18); June-15
cutover gate + default-backend decision + Gemini fallback (Phase 19); Telegram rebuild on transcript-tail
+ permission injection + write-arbitration turn lock (Phase 20).
</domain>

<decisions>
## Implementation Decisions (LOCKED — from spec hard constraints + override)

### Sequencing safeguard (NON-NEGOTIABLE)
- Phase 17 MUST NOT begin the deletions until Phases 15–16 verification has passed (terminal surface
  functional + proven). The Codex runner (R-PTY-12) may be built first; the DELETIONS (R-PTY-13/14)
  come after the surface is proven. This is the blast-radius limiter for the one-way door.

### No API key — ever (constraint 1); official client only (constraint 2); human-only (constraint 3); claude login (constraint 4); interactive only (constraint 5)
- `codex-pty-runner.ts` mirrors `claude-pty-runner.ts`: interactive Codex CLI in a PTY, raw bytes only,
  NO programmatic flags, env hygiene (no ANTHROPIC_API_KEY on the spawn path; Codex auth delegated to its
  own client). It rides the Phase-16 human-only dispatch guard — automation never touches the PTY.
- The PRESERVED stream-json runner path keeps its existing env behavior for automation (Phase 18 routes
  it behind the non-bypassable cost cap).

### Preserve stream-json for automation (R-PTY-16)
- Delete only the HUMAN chat UI + the translation that exists ONLY to feed it. Do NOT delete the
  runner-side stream-json path (`claude-runner.ts` stream-json spawn, `session-bridge.ts` RunnerEvent
  translation) — Phase 18 needs it for unattended automation transports.

### Explicit, not silent, Telegram break (R-TG-12)
- At each point where the structured-event source / permission path is removed, leave a comment:
  `// Phase 17 rip: Telegram event source removed here; rebuilt in Phase 20 (transcript-tail).` Record
  every such point in the SUMMARY. The Telegram bridge module stays on disk (Phase 20 re-sources it).

### Theme (design preferences)
- The single surviving human surface is the themed xterm.js terminal (Phase 16): `--bg-primary`/
  `--text-primary`, BLUE accent, never indigo; app chrome unchanged. `web/test/no-indigo.test.ts` green.

### Claude's Discretion
- Whether grid/list views host terminal cells vs drop conversation rendering entirely (R-PTY-15) — pick
  the smallest credible diff consistent with one terminal surface. Exact Codex interactive argv (no
  programmatic/headless flags) per the Codex CLI's interactive entrypoint. Which hub translation modules
  are "ONLY for the deleted UI" vs "shared with automation" — determined by import-graph analysis in
  RESEARCH; when ambiguous, PRESERVE (deleting automation-needed translation is the dangerous error).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Source spec + upstream phases (authoritative)
- `.planning/architecture/interactive-pty-runner-SPEC.md` — design, hard constraints, sequencing safeguard, "If PTY fails."
- `.planning/phases/16-*/` (CONTEXT/RESEARCH/PLANs + SUMMARYs) — the PTY host, raw-terminal WS, tmux/persistence, human-only guard, per-session runner_type the Codex runner reuses and the surface the rip routes everything to.
- `.planning/phases/15-*/` SPIKE-FINDINGS — node-pty compile-shipping contract (Codex runner ships the same way).

### Runners (reuse / preserve)
- `supervisor/src/runners/claude-pty-runner.ts` (+ `pty-persistence.ts`) — the template the Codex runner mirrors.
- `supervisor/src/runners/claude-runner.ts` + `session-bridge.ts` — the stream-json path PRESERVED for automation (do NOT delete).
- `supervisor/src/runners/types.ts` — `CliRunner`/`RunnerEvent`; Codex PTY runner is raw-bytes-only (no RunnerEvent).
- Phase-05 Codex runner work (`docs/codex-and-rootless.md`) — Codex CLI invocation patterns + `cli_kind='codex'`.

### Web (DELETE the human chat UI)
- `web/src/components/ChatSurface.tsx`, `ChatSurfaceShowcase.tsx`, `ChatPanel.tsx`, `ChatLayout.tsx`, `GridPage.tsx`; `web/src/hooks/useChatSurface.ts`, `useChat.ts`; `web/src/lib/chat-tabs-api.ts` — the structured human chat UI + bubble rendering to remove for human sessions, replaced by the Phase-16 `TerminalSurface`.
- `web/test/no-indigo.test.ts` — stays green.

### Hub (remove DEAD translation; PRESERVE automation translation; mark Telegram break)
- `hub/src/ws/agent-protocol.ts` (kinds: thinking/text_delta/tool_use/tool_result/assistant_message/permission_request/user_question) + `hub/src/ws/client.ts` / `protocol.ts` — translation/broadcast that fed the deleted bubbles; remove ONLY what's dead for human UI.
- `hub/src/telegram/bridge.ts`, `approvals.ts`, `dispatch.ts` — the structured-event source + `permission_request`→`onPermissionPending` path removed here (EXPLICIT comment → Phase 20); module NOT deleted.
- `hub/src/dispatch/pipeline.ts` + `gates.ts` — unchanged routing; cost cap + human-only guard intact.

### Cross-cutting invariants
- `.planning/STATE.md` "do not violate" + repo `CLAUDE.md` — cost-cap non-bypassable, schema.sql idempotent, mount-order, dispatch pipeline single source. The rip must not touch these.
</canonical_refs>

<specifics>
## Specific Ideas

- Codex PTY runner: mirror `claude-pty-runner.ts` (Phase 16) verbatim in structure; swap the spawned
  binary to the interactive Codex CLI entrypoint (no programmatic/headless flags). Extend the canary to
  cover the Codex runner (no programmatic flags; env hygiene).
- New test asserting NO `ChatSurface`/structured-bubble render path remains for human sessions
  (R-PTY-13) — e.g. a grep/static test that `ChatSurface` is not imported on any human-session route.
- Import-graph analysis to classify hub translation as "human-UI-only" (delete) vs "automation-shared"
  (preserve) — when ambiguous, PRESERVE (R-PTY-14).
- Grep test asserting the Phase-17 Telegram-break comment exists at each removed source point and the
  Telegram bridge module still exists on disk (R-TG-12).
- QC gate: `bun run check-baseline` + `web` build + `web/test/no-indigo.test.ts` stay green (R-PTY-16).
</specifics>

<deferred>
## Deferred Ideas

- Dual-bucket usage poll + programmatic-leak alert/hard-halt → Phase 18.
- June-15 cutover-gate runbook + default-backend (Claude-if-interactive-else-Codex) + Gemini fallback → Phase 19.
- Telegram rebuild on transcript-tail + fail-closed permission injection + write-arbitration turn lock → Phase 20.
</deferred>

---

*Phase: 17-codex-pty-runner-and-chatsurface-rip-and-replace*
*Context gathered: 2026-05-31 from approved spec + RIP-AND-REPLACE override; sequenced after Phases 15–16*

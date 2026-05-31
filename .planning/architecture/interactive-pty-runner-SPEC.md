# remo-code — Universal PTY Terminal Surface (rip-and-replace) Design Spec

Single committed design. Decisions are settled. Executors follow this. This is the design/decision
doc (the "why" + constraints + risks); GSD phase artifacts in `.planning/phases/` + `.planning/ROADMAP`
handle execution detail and MUST stay reconciled with this file.

**Design intent (user-confirmed):** rip-and-replace. ONE terminal surface for all human coding
sessions; the rich chat UI (ChatSurface) and the stream-json rendering path are removed. The terminal
is backend-agnostic (claude / codex / future).

## Context — why this exists

Anthropic's **June 15, 2026** change moves *programmatic* Claude usage on subscription plans (Agent
SDK, `claude -p`, headless `stream-json`) OFF interactive subscription limits and ONTO a separate
per-user monthly credit pool. **Interactive** Claude Code in a terminal stays on subscription limits.

remo-code today spawns `claude --input-format stream-json --output-format stream-json` on the
subscription OAuth login ([`supervisor/src/runners/claude-runner.ts:79-94`](supervisor/src/runners/claude-runner.ts:79);
[`supervisor/src/usage/oauth-poll.ts`](supervisor/src/usage/oauth-poll.ts)). That `stream-json` path
is the programmatic entrypoint → metered against the credit pool from June 15 (~95% confidence).

**Goal:** keep human-driven remote coding on the **interactive subscription pool** by running the
genuine interactive `claude` TUI in a PTY (same entrypoint as SSH+tmux), relayed to phone/browser —
without an API key and without reusing credentials.

## Hard constraints (non-negotiable)

1. **API-key billing is NOT APPROVED.** No code path passes `ANTHROPIC_API_KEY` to a spawned `claude`
   (keep the `delete env.ANTHROPIC_API_KEY`). No API-key fallback anywhere. If the PTY/interactive
   approach fails, fallback is a different backend CLI (see "If PTY fails"), never the API.
2. **Spawn the official `claude` client only.** Never extract / store / present / reuse the OAuth
   token. All auth delegated to the official client (this keeps remo-code out of the banned
   third-party-app-as-subscription class).
3. **Only genuine human turns touch the PTY surface.** Unattended/scheduled/automation (scheduler,
   orchestrator background, auto-dev, error-capture) must NOT be injected into the interactive PTY —
   that's "robot pressing enter via the interactive entrypoint," the flagged/ban-risk move. A guard
   rejects non-interactive dispatch sources.
4. **Auth via `claude login` (interactive OAuth), not `setup-token`.** `login` runs locally per host
   (localhost redirect). `setup-token` (copy/paste) is the only remote-auth path through the relay
   and is suspect (may carry a programmatic classification) — used only when a host can't be touched
   locally, and only after its billing classification is verified post-June-15.

## The design — universal PTY terminal surface (rip-and-replace)

ONE terminal surface for every human session. The supervisor runs the interactive CLI (`claude`,
or `codex`) inside a PTY; raw terminal I/O is relayed to a themed xterm.js panel that **replaces**
ChatSurface as the conversation surface. The structured stream-json runner, the `RunnerEvent`
pipeline rendering, and ChatSurface/bubble UI are **removed** once the terminal surface is proven.

- **Backend-agnostic terminal.** The PTY runs whichever CLI the session selects (claude / codex /
  future Grok). Billing/availability differs per backend, but the surface and relay are identical.
- **`supervisor/src/runners/*-pty-runner.ts`.** Spawn the *interactive* CLI (no `-p`, no
  `--input-format stream-json`) in a PTY (Bun/`node-pty`, ConPTY on Windows). Stream raw bytes out,
  write raw input in. `delete env.ANTHROPIC_API_KEY` (constraint 1).
- **Raw-terminal transport.** A WS channel for terminal bytes (data in/out, resize, reattach),
  relayed by the hub `/ws/client` ↔ `/ws/agent`. The structured agent-protocol rendering path is
  retired with ChatSurface.
- **Web.** Themed xterm.js panel inside the existing React shell — app chrome (sidebar, nav, theme
  tokens, blue accent, fonts) preserved; the conversation surface IS the terminal. tmux-backed for
  reattach across phone disconnects.
- **Auth.** Delegated entirely to the official client (constraint 2).

### Topology — supervisor-per-host (remote access preserved)

Run a supervisor on each host you code on; the CLI runs there; you reach any host from phone/browser
via the hub relay (hub already supports multiple supervisors/hosts). OUT OF SCOPE: one supervisor
SSH-ing to spawn the CLI on a *different* machine — to use a remote computer, run a supervisor on it.

## Sequencing safeguard (protects the rip-and-replace)

The destructive deletion is a one-way door. Order matters:

1. **Build + mechanically prove** the universal terminal surface FIRST (Phases 15–16): node-pty on
   Windows, compile-shipping, render fidelity, input injection, tmux reattach. Do NOT delete
   ChatSurface / stream-json until the terminal surface is functional and proven.
2. **Then rip** (delete ChatSurface, stream-json runner, bubble translation) — Phase 17.
3. **June-15 billing verification gates the DEFAULT BACKEND, not the rip.** The terminal surface works
   regardless of backend; verification only decides whether the default backend is Claude (if it bills
   interactive) or Codex (if Claude-via-PTY bills programmatic). See "If PTY fails."

## Telegram — transcript-tail (Plan B) is the chosen, load-bearing path (Phase 20)

> **Prior-stance supersession (explicit).** Earlier framing rejected transcript-JSONL parsing as
> "fragile, cosmetic, NOT done," and the milestone's R-PTY-11 / R-PTY-24 assumed Telegram would
> "stay stream-json / on the programmatic pool." That stance is **explicitly superseded.** With the
> rip (Phase 17) deleting the stream-json human runner, the structured-event source no longer exists,
> so "stay stream-json" is not an option. **Transcript-tail is now load-bearing and approved.** It is
> a read-only observer of the human's own interactive subscription session — it adds no programmatic
> Claude call, so Telegram does NOT move onto the programmatic credit pool.

Rip-and-replace removes the stream-json runner, so the Telegram bridge's structured-event source
(`assistant_message:final` + `tool_use`, [`hub/src/telegram/bridge.ts`](hub/src/telegram/bridge.ts)) and
the `permission_request`→`onPermissionPending` path no longer exist after Phase 17. Phase 17 leaves
Telegram **non-functional**; **Phase 20 rebuilds it on transcript-tail** (sequenced strictly after 17).

**Backend-agnostic transcript source (decision 2).** Do NOT hardcode the Claude path. A per-backend
`TranscriptSource` adapter is selected by the session's `cliKind`:
- **Claude →** `~/.claude/projects/<project-slug>/<session-uuid>.jsonl` (structured
  `assistant`/`tool_use`/result entries). Session→file mapping resolved explicitly from the project
  dir + session id captured at PTY spawn — never newest-file guessing.
- **Codex →** `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl` (each line
  `{timestamp, type: session_meta|response_item|turn_context, payload}`; `response_item` carries
  message/function_call/reasoning). This path/format is **undocumented and version-unstable**
  (community-reverse-engineered — re-verify per Codex release). Adapter resolves the file by
  `session_meta` id and **falls back to a terminal-byte scrape** for Codex when the rollout file is
  absent/unrecognized (scrape surfaces only assistant text + turn-complete; it NEVER parses
  permissions — see fail-closed). Both backends are covered in this milestone.
Each adapter normalizes to a shared `TranscriptEntry` union (`assistant_text`, `tool_use`,
`permission_request`, `user_question`, `turn_complete`); the bridge consumes only the union.

**Permission / user_question / slash injection (decision 3 — security-sensitive).** With stream-json
gone, prompts exist only as transcript entries (or TUI bytes). Phase 20:
- **Detects** a pending permission/approval or `user_question`/option-select from the normalized
  transcript stream per backend, keyed by **`(sessionId, requestId)`** (reusing the
  `hub/src/telegram/approvals.ts` registry that already keys by `(sessionId, requestId)` to avoid the
  multi-user clobber — never `requestId` alone).
- **Surfaces** it via the existing inline tap-to-approve UX (`approvals.ts` +
  `sendMessageWithKeyboard`), one button per enumerated option, with the existing per-user
  authorization binding.
- **Injects** the human's tap back into the PTY as the backend-specific literal keystroke(s)
  (approve/deny key, or option-index/arrow+enter) via the Phase-16 raw-terminal input path — NOT the
  deleted `permission_response` agent message.
- **Fail-CLOSED (non-negotiable):** if the prompt is ambiguous, partial, or its options are not
  parseable into a discrete enumerated choice, do NOTHING — no Telegram prompt, no keystroke, NEVER
  auto-approve. No default "yes." A tap is rejected (injects nothing) if its bound `(sessionId,
  requestId)` is already resolved/expired/superseded.
- **Threat model:** mis-parse → auto-approval is the top risk (a forged file-write or shell command
  silently approved). Mitigations: fail-closed parse, explicit-confirmation per option, per-user
  `(sessionId, requestId)` authorization, single-decision removal-on-resolve, and the Codex scrape
  path emitting no permission prompts at all. Full threat model lives in the Phase 20 plans.

**PTY write-arbitration (decision 5).** A phone/browser xterm and the Telegram bridge can both write
to the same tmux-backed PTY. Mechanism: a **single-writer turn lock per session** in the hub. A writer
acquires the turn, injects exactly one human turn, and the lock releases only when the turn is observed
COMPLETE (a `turn_complete`/assistant entry in the `TranscriptSource`; or the TUI prompt-ready signal
in the scrape fallback). Other writers' input is QUEUED (bounded FIFO) and a per-session "who holds the
turn" state is exposed. A permission/question RESPONSE from the non-holder is permitted (answering a
pending prompt is not a new turn). Rationale: turn-completion is already observable from the transcript
(no new signal needed), and a lock keyed on observed completion prevents two writers' keystrokes
interleaving mid-turn — the only safe arbiter when both writers feed one TUI stdin.

**ToS line unchanged:** a genuine human Telegram message is fine; Telegram injection rides the Phase-16
human-only dispatch guard (constraint 3) — do NOT combine with auto-nudge/scheduled prompts to drive
the PTY unattended.

## If PTY fails (or Claude-via-PTY bills programmatic)

No API-key fallback (constraint 1). In an all-PTY world the fallback is **swap the terminal's backend
CLI**, since the surface is backend-agnostic:

- **Codex — primary fallback.** OpenAI's subscription INCLUDES programmatic/Codex usage within plan
  limits (there's a "Codex Subscription API" via the ChatGPT plan; pricing aligned to API tokens, no
  separate penalized credit pool). More permissive than Claude post-June-15. Already wired as a runner.
- **Gemini — NOT a reliable fallback.** Gemini CLI + Code Assist reportedly stop serving individual/
  Pro/Ultra tiers **June 18, 2026**, migrating to Antigravity CLI with tighter weekly quotas. Don't
  bet on it without re-verifying.
- **Grok — too immature.** Grok Build CLI is early beta (May 14, 2026), no free tier, unsettled
  pricing. Revisit later.

(All provider facts secondary-sourced and fast-moving — re-verify before relying.)

## Phased plan (aligns to GSD milestone m-interactive-pty-runner, Phases 15–20)

- **15 · pty-spike-and-compile-derisk.** Prove interactive `claude` in a PTY renders + takes input;
  derisk **`node-pty` native addon + `bun build --compile`** (native-beside-exe vs helper-exe vs
  out-of-band — `autonomous:false` checkpoint, may change MSI packaging). Raw-terminal WS + xterm panel.
- **16 · hardened-pty-relay-and-mobile-terminal.** `claude-pty-runner.ts`, tmux reattach, auth'd
  raw-terminal relay, mobile xterm, human-only guard (constraint 3).
- **17 · codex-pty-runner-and-chatsurface-rip-and-replace.** Codex PTY runner; DELETE ChatSurface +
  stream-json rendering + dead bubble translation. **Only after 15–16 prove the surface works.**
- **18 · billing-guardrail-dual-bucket-usage.** Dual-bucket poll (extend
  `supervisor/src/usage/oauth-poll.ts`), programmatic-leak alert/halt.
- **19 · cutover-gate-and-automation-fallback.** June-15 runbook; verify Claude-via-PTY bucket; set
  default backend (Claude if interactive, else Codex); automation stays programmatic or moves to Codex.
  No API key.
- **20 · telegram-transcript-tail.** Rebuild Telegram (broken by the Phase-17 rip) on a
  backend-agnostic `TranscriptSource` adapter (Claude projects JSONL / Codex rollout JSONL + scrape
  fallback). Detect pending permission/`user_question` from the transcript keyed by `(sessionId,
  requestId)`, surface via the existing inline approval UX, inject the human tap as backend-specific
  PTY keystrokes — **fail-CLOSED on any parse ambiguity (never auto-approve)**. Single-writer turn
  lock arbitrates the two PTY writers (xterm + Telegram). Rides the human-only guard. **Sequenced
  strictly after Phase 17.** Supersedes the Telegram clauses of R-PTY-11 / R-PTY-24.

## Verify after June 15 (gates the default backend, not the rip)

1. **PTY interactive `claude` → which bucket?** Run a turn, watch `/api/oauth/usage`. Interactive →
   Claude stays default. Programmatic → default backend becomes Codex.
2. **`setup-token` classification** (interactive vs programmatic) — test login vs setup-token side by
   side. (Hypothesis: setup-token may become SDK/programmatic auth.)
3. **Subagents / hooks / MCP inside an interactive session** — which bucket? (Plausibly interactive;
   main `claude` spawns Task subagents in-process under the same session/OAuth.) Measure residual.
4. **login-credential headless reclassification risk** — watch for Anthropic moving to credential-
   based classification or rejecting headless use of `login` credentials.

## Functional verification (build-time)

- New runner: no `ANTHROPIC_API_KEY`; launches *interactive* CLI (no `-p`, no `--input-format
  stream-json`).
- Terminal surface renders fidelity + accepts injected input as a normal typed turn; tmux reattach
  survives a dropped phone connection with no lost state.
- Human-only guard rejects non-interactive dispatch sources from the PTY surface (incl. Telegram-origin
  automation — a real human Telegram message is allowed; auto-nudge/scheduled-via-Telegram is not).
- Do NOT delete ChatSurface/stream-json until the terminal surface passes the above (sequencing
  safeguard).
- Phase 20 (Telegram transcript-tail) runs AFTER the Phase-17 rip: the `TranscriptSource` adapter
  resolves the right file deterministically per backend; a malformed/ambiguous permission entry yields
  zero injected keystrokes and zero approval prompts (fail-closed); concurrent xterm+Telegram writes
  are serialized by the per-session turn lock and never interleave mid-turn.
- All work in the `feat/interactive-pty-runner` worktree off `origin/main`.

## Residual one-way-door note (acknowledged, user-accepted)

Deleting ChatSurface/stream-json is permanent within this branch — if the terminal UX proves worse for
real mobile coding than the rich UI, there's no in-product revert (only git history). User has accepted
this trade for a single unified terminal surface. The sequencing safeguard limits the blast radius to
"terminal works but UX disappoints," not "nothing works."

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

## Telegram — Plan A is dead; transcript-tail (Plan B) is the only path

Rip-and-replace removes the stream-json runner, so the Telegram bridge's structured-event source
(`assistant_message:final` + `tool_use`, [`hub/src/telegram/bridge.ts:4-11`](hub/src/telegram/bridge.ts:4))
no longer exists. Therefore:

- **Telegram MUST move to transcript-tail (Plan B) or be dropped.** Drive the interactive PTY session;
  source Telegram's output from the session's on-disk transcript JSONL
  (`~/.claude/projects/<proj>/<session>.jsonl`, structured `assistant`/`tool_use` entries) — not the
  terminal bytes. Inject Telegram messages into the PTY as input.
- **Costs:** transcript format is undocumented (tracks an unstable contract, can break on CC
  releases); extra plumbing for session→transcript mapping and surfacing permission/`user_question`/
  slash flows as Telegram messages with responses injected back into the PTY.
- **ToS line unchanged:** a genuine human Telegram message is fine; do NOT combine with
  auto-nudge/scheduled prompts to drive the PTY unattended.
- If transcript-tail is judged not worth it, Telegram is dropped (or pointed at a backend that still
  emits structured events outside this surface — out of scope here).

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

## Phased plan (aligns to GSD milestone m-interactive-pty-runner, Phases 15–19)

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
- Human-only guard rejects non-interactive dispatch sources from the PTY surface.
- Do NOT delete ChatSurface/stream-json until the terminal surface passes the above (sequencing
  safeguard).
- All work in the `feat/interactive-pty-runner` worktree off `origin/main`.

## Residual one-way-door note (acknowledged, user-accepted)

Deleting ChatSurface/stream-json is permanent within this branch — if the terminal UX proves worse for
real mobile coding than the rich UI, there's no in-product revert (only git history). User has accepted
this trade for a single unified terminal surface. The sequencing safeguard limits the blast radius to
"terminal works but UX disappoints," not "nothing works."

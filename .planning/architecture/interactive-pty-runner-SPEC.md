# remo-code — Interactive-PTY Runner Design Spec

Single approved design. No options to choose from — decisions below are settled. An executor
implements exactly this.

## Context — why this exists

Anthropic's **June 15, 2026** change moves *programmatic* Claude usage on subscription plans
(Agent SDK, `claude -p`/`--print`, headless `stream-json`, third-party apps authenticating via
the Agent SDK) OFF subscription interactive limits and ONTO a separate per-user monthly credit
pool ($20 Pro / $100 Max-5x / $200 Max-20x; non-rollover; overage at full API rates or hard-stop).
**Interactive** Claude Code in a terminal/IDE stays on subscription limits, unaffected.

remo-code today spawns `claude --input-format stream-json --output-format stream-json --verbose`
([`supervisor/src/runners/claude-runner.ts:79-84`](supervisor/src/runners/claude-runner.ts:79)) on
the user's **subscription OAuth** login (it does `delete env.ANTHROPIC_API_KEY` at
[`claude-runner.ts:94`](supervisor/src/runners/claude-runner.ts:94); confirmed by
[`supervisor/src/usage/oauth-poll.ts`](supervisor/src/usage/oauth-poll.ts) reading
`~/.claude/.credentials.json` `claudeAiOauth.accessToken`). That `stream-json` path is the
**programmatic** entrypoint → metered against the credit pool from June 15 (~95% confidence;
corroborated by the Multica daemon case + Anthropic's "Run Claude Code programmatically" docs).

**Goal:** keep human-driven remote coding on the **interactive subscription pool** by running the
genuine interactive `claude` TUI in a PTY (the same entrypoint as SSH+tmux, which is uncontested),
relayed to phone/browser — without an API key and without reusing credentials.

## Hard constraints (non-negotiable)

1. **API-key billing is NOT APPROVED for this project.** No code path may pass `ANTHROPIC_API_KEY`
   (or any API-platform key) to a spawned `claude`. The existing `delete env.ANTHROPIC_API_KEY` at
   `claude-runner.ts:94` STAYS, and the new PTY runner must do the same. There is **no API-key
   fallback** anywhere. If the PTY/interactive approach fails (see "If PTY fails"), it fails — we do
   not fall back to API-key billing.
2. **Spawn the official `claude` client only.** Never extract, store, present, or reuse the OAuth
   token directly. All auth is delegated to the official client (this is what keeps remo-code out of
   the banned "third-party app authenticating as the subscription" class — that ban already pushed
   SDK/token-reuse apps like OpenClaw onto API keys; remo-code is a wrapper around the official CLI,
   which is why it still works on the subscription).
3. **Only genuine human turns touch the PTY runner.** Unattended/scheduled/automation dispatch
   (scheduler, orchestrator background turns, auto-dev, error-capture) MUST NOT be routed through the
   PTY runner — doing so is "making a programmatic client look interactive," the flagged/ban-risk
   move. A guard rejects non-interactive dispatch sources from the PTY runner.
4. **Auth via `claude login` (interactive OAuth), not `setup-token`.** Default to the `login`
   credential. Treat `setup-token` as suspect (it is the headless/non-interactive auth path and may
   carry a programmatic classification — see post-6/15 checks). `login` uses a localhost redirect, so
   it is run locally on each host; `setup-token` (copy/paste) is the only remote-auth path through the
   relay and is used only when a host can't be touched locally — and only after its billing
   classification is verified.

## The design

**Retrofit remo-code** with an **additive** interactive runner alongside the existing stream-json
runner — not a disguise over it. The stream-json path stays as-is for Codex and for any usage that
accepts the credit pool.

```
Phone / browser  (themed xterm.js panel embedded in the existing remo-code React shell)
   ↕ authenticated WebSocket  (raw terminal frames — NEW channel, not the structured agent-protocol)
Supervisor (per host, where the repos live):  PTY ── real interactive `claude` TUI  → interactive pool
   + tmux-backed persistence (survives phone disconnects)
   + billing guardrail: poll /api/oauth/usage (both buckets), alert/halt on programmatic leak
```

### Components

- **`supervisor/src/runners/claude-pty-runner.ts` (new).** Spawns the *interactive* `claude` (no
  `-p`, no `--input-format stream-json`) inside a PTY (Bun/`node-pty`, ConPTY on Windows). Streams
  raw terminal output out and writes raw input in. Does `delete env.ANTHROPIC_API_KEY` (constraint 1).
  Implements only the human-interactive subset — it does NOT translate to the structured `RunnerEvent`
  union (that union is for stream-json; the terminal path is raw bytes).
- **Raw-terminal transport (new).** A dedicated WS channel for terminal bytes (data in/out, resize,
  reattach) — separate from the structured `/ws/agent` `RunnerEvent`→agent-protocol pipeline in
  `session-bridge.ts`. The hub relays these frames `/ws/client` ↔ `/ws/agent` unchanged in spirit.
- **Web: embedded themed terminal (Embed-A).** xterm.js as a panel INSIDE the existing React shell.
  App chrome (sidebar, nav, theme tokens `--bg-primary`/`--text-primary`, blue accent, fonts)
  unchanged; only the **conversation surface** for an interactive Claude session renders the real TUI,
  themed to match — like VS Code / Warp / Gitpod. Existing rich chat/grid UI stays for stream-json +
  Codex sessions. (Reconstructing chat bubbles from the on-disk transcript JSONL is explicitly NOT
  done — fragile undocumented-format dependency for cosmetics.)
- **tmux persistence.** The interactive `claude` runs inside tmux so a dropped phone connection can
  reattach with no lost state.
- **Auth.** Delegated entirely to the official client (constraint 2). No remo-code auth changes for
  Claude credentials; reuse existing opaque-cookie sessions + WS infra for the remo-code app itself.

### Topology — supervisor-per-host (remote access preserved)

"claude runs local to its supervisor" ≠ "you must be at the machine." Run a supervisor on each host
you want to code on (laptop, VPS, work box); `claude` runs there; you reach any host from
phone/browser because the hub relays. The hub already supports multiple supervisors on multiple hosts.
OUT OF SCOPE: one supervisor SSH-ing to spawn `claude` on a *different* machine — to use a remote
computer, run a supervisor on it.

## Phased plan

- **Phase 0 — Spike (buildable now; cutover GATED on June 15).** Minimal embedded web TUI, not
  throwaway — the seed of the feature: interactive `claude` in a PTY (`node-pty`) on the supervisor
  box, streamed to a themed xterm.js panel, accepts a typed turn, renders the TUI. Derisks the known
  technical blocker: **`node-pty` is a native addon and does NOT bundle into `bun build --compile`**
  (the sidecar). Phase 0 proves the PTY mechanic and informs how the runner ships in the compiled
  sidecar (e.g. bundle the native module, ship a helper, or run the PTY host out-of-band).
- **Phase 1 — Hardened relay.** PTY host + tmux persistence + authenticated raw-terminal WS + mobile
  xterm.js (reconnect / resize / scrollback). Reuse remo-code auth + WS infra.
- **Phase 2 — Billing guardrail.** Extend the existing usage poll
  (`supervisor/src/usage/oauth-poll.ts` → hub store) to surface BOTH buckets; alert + optional
  hard-halt when programmatic credit is consumed unexpectedly. No silent drain, no surprise hard-stop.
- **Phase 3 — Scope-off automation.** Unattended work (scheduler / orchestrator background / auto-dev /
  error-capture) stays on the stream-json/programmatic path behind the cost cap, or moves to a
  non-Claude backend (Codex — already wired — or a future Gemini runner). **NOT an API key.**

## Telegram (and any text-only channel) — impact

**Telegram cannot ride the PTY/interactive path and will remain on the programmatic pool.**
The Telegram bridge ([`hub/src/telegram/bridge.ts:4-11`](hub/src/telegram/bridge.ts:4)) subscribes
to structured `assistant_message:final` events and uses `tool_use` activity for summarized
streaming — all emitted by the **stream-json runner** (`ws/agent.ts`). A PTY runner emits raw
terminal ANSI, none of those events, and a TUI can't render in a chat app. So:

- **Telegram stays on the stream-json runner** → its turns bill the **programmatic credit pool**
  post-June-15, even though a human drives them. This is a structural fact of the entrypoint, not a
  spoofing/ToS issue — Telegram simply can't reach the interactive entrypoint.
- **Runner type is per-session.** A session is either PTY-interactive (web/xterm.js → interactive
  pool) or stream-json (Telegram-compatible → programmatic pool); they don't mix. Telegram's default
  session (often the orchestrator) MUST remain a stream-json session. Switching that session to the
  PTY runner breaks Telegram bridging for it. The new runner must therefore be opt-in per session and
  must not be applied to a session that is a Telegram default.
- **The interactive-pool benefit applies only to the web terminal coding path.** Telegram does not
  benefit. To take Telegram off the credit pool: route its work to a Codex/Gemini backend, accept the
  credit cost (text chat is usually modest and likely fits the $20–$200 credit), or limit it.
  **Not an API key** (constraint 1).

## If PTY fails

If the post-6/15 check shows interactive PTY sessions bill the **programmatic** bucket, or the
approach is flagged: **the approach fails. No API-key fallback.** Fallback paths are:
- **Codex** runner (already in `supervisor/src/runners/`), and/or
- a **new Gemini runner** (Gemini CLI) for the work that would have run on Claude.
The remo-code interactive-coding UX would then target Codex/Gemini instead of subscription Claude.

## Verify after June 15 (the open variables — do NOT build cutover before these)

1. **PTY interactive session → interactive bucket?** Core gate. Run one PTY `claude` turn, watch
   `/api/oauth/usage` to see which balance moves. Green-light the cutover only if interactive.
2. **`setup-token` classification.** Does a `setup-token`-provisioned credential bill interactive or
   programmatic? (Hypothesis to test: `setup-token` may become the SDK/programmatic auth.) Auth one
   host via `login` and one via `setup-token`, run identical turns, compare buckets.
3. **Subagents / hooks / MCP inside an interactive session** — which bucket? (Plausibly interactive,
   since the main `claude` process spawns Task subagents in-process under the same session/OAuth — but
   undocumented.) Run a subagent-heavy turn, measure programmatic-bucket movement; quantify residual.
4. **login-credential headless reclassification risk.** Watch whether Anthropic moves to
   credential-based classification and/or starts rejecting headless use of `login` credentials.

## Verification (functional, build-time)

- Re-confirm spawn argv + env in the new runner: must NOT pass `ANTHROPIC_API_KEY`; must launch
  *interactive* `claude` (no `-p`, no `--input-format stream-json`).
- Prove tmux reattach survives a dropped phone connection with no lost state.
- Prove input injection renders as a normal typed turn in the TUI.
- Confirm the raw-terminal channel is isolated from the structured agent-protocol (no `RunnerEvent`
  coupling).
- Per repo rule: all work in a fresh `feat/` worktree off `origin/main`
  (`feat/interactive-pty-runner` already created, currently empty/parked).

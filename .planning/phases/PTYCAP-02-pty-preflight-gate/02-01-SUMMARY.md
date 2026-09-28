# 02-01-SUMMARY — PTY pre-flight gate

## Status: Done (all 3 success criteria met)

## How the design got here

The first design ran the check once per "fresh turn" (`turn-lock.holder === null`)
and only on sessions with `runner_type = 'pty-interactive'`. Five AgentAutofix
`ai-review` rounds each found a race in it. A three-lens QC panel (concurrency,
security, correctness) then found it was also **dead in prod**
(`sessions.runner_type` defaults to `'stream-json'` and the web client never sets
it, while the supervisor writes every `term.input` to the PTY on its own env
flag), and that once live it would refuse Ctrl-C/Esc mid-turn (the turn lock only
releases on a 60s idle TTL in prod) and let a keepalive keystroke hold one
passing check open all day. It was replaced with a per-SUBMIT gate; a second
panel verified the replacement and found one more bypass (Enter encodings with
no CR/LF byte — see below), now closed. Full design:
`docs/usage-cost.md` §"PTYCAP Phase 2".

**Owner behavior note:** the human web terminal is now subject to the user's
daily cost cap (`users.daily_cost_cap_usd`, `NOT NULL DEFAULT 10`; 0 disables
it), token cap and usage threshold on each submit — as `CLAUDE.md` already
states ("Manual / interactive chat IS now capped"). PTY cost is a list-price
estimate and the pool is shared with scheduled/orchestrator spend, so a $10 cap
can be reached after a handful of Opus turns. Raise it (or set 0) in
Settings → Usage if it bites; the Usage tab copy now says the terminal is capped.

## What was built

**`hub/src/dispatch/pty-preflight.ts`** (new)
- `ptyPreflightDispatchConfig.gates = [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]`
  — SC-1's order, and the SAME array object as `PTY_AUTOMATION_TURN_GATES`, so
  `token-cap-coverage.test.ts`'s literal scan reads the chain that runs (SC-2).
- `PTY_HUMAN_TURN_GATES` — the automation chain minus `sessionInjectRateGate` (SC-3).
- `checkPtyTurnPreflight({ userId, sessionId, actor })` — first-block-wins;
  **fails closed** (`pty_preflight_error` on a throw, `pty_preflight_timeout`
  after 5s). A human actor sets the server-only `DispatchRequest.humanInteractive`
  flag, which exempts it from the programmatic-credit halt inside
  `dailyCostCapGate` — never from the cost or token caps.
- `classifyPtyInput(bytes, pendingTail)` — is this frame a possible submit?
  CR/LF, any escape not on a known-safe allowlist (kitty/CSI-u `ESC[13u`,
  `ESC[57414u`, keypad `ESC O M`, …), C1 CSI/SS3, or undecodable ⇒ yes. A
  trailing lone Esc is returned as `tail` so a sequence split across frames is
  judged joined.

**`hub/src/ws/client.ts`** — the term relay (body now in `relayTermFrame`):
- each write frame claims its per-(session, writer) `ptyWriteChain` slot
  synchronously on receipt, so frames reach the PTY in arrival order;
- every submit (`classifyPtyInput`, joined with the session's `ptyEscTail`) is
  checked with `actor: 'human'`; a refusal drops the frame and sends
  `{ type: 'send_refused', channel: 'term', session_id, reason }`;
- right before the write, writer + lock ownership are re-verified (a lock that
  went free is re-taken; a lock held by another writer drops the frame, and a
  dropped submit is refused with `not_current_writer`); the agent channel is
  resolved at send time.

**`hub/src/dispatch/{pipeline,gates}.ts`** — `humanInteractive` flag + the halt exemption.

**Web** — `web/src/lib/termRefusal.ts` + `TerminalSurface` print refusals in the
terminal (throttled); chat hooks ignore `channel: 'term'`; Settings → Usage
helper text no longer says manual use is unaffected.

## Why the scope reads narrower than "gate the PTY path" sounds

Before writing any code, I audited every existing write route into a PTY
session (`ws/client.ts` term.input, Telegram keystroke injection, Telegram
plain-text dispatch, ask/work dispatch). Finding: `humanOnlyPtyGate` /
`humanOnlyRejectsActor` (built in Phase 1's prerequisite work) already reject
EVERY automation actor before a write reaches a pty-interactive session — as
of this phase starting, no automation write to a PTY was possible at all, by
construction. So "a programmatic write passes the full chain or it does not
happen" was ALREADY true in the strongest sense (it never happens) for every
existing caller.

That reframed the real work into two concrete pieces, both delivered:

1. **Build the reusable chain now, proven correct by test, so Phase 3 has a
   tested seam** rather than inventing gate wiring at the same moment it
   relaxes the human-only invariant — the ROADMAP explicitly forbids
   parallelizing Phase 3 ahead of Phase 2 for exactly this reason.
2. **Close the one REAL, present-day gap**: `docs/usage-cost.md`'s own Phase 1
   section says outright that "gating the interactive PTY path against the
   daily cost/token caps is milestone PTYCAP's Phase 2, not this phase." The
   web xterm `term.input` relay had NEVER been checked against
   `dailyCostCapGate`/`dailyTokenCapGate`/`thresholdGate` — only a license
   check + the human-only guard + the turn lock sat in front of it. That gap
   is now closed for human turns too (SC-3 exempts only the inject-rate
   ceiling, not the spend caps).

## What was deliberately deferred (and why)

- **`hub/src/ws/client.ts`'s `send_message` handler (the stream-json
  `ChatSurface` manual-chat path) is still not gated by `dailyCostCapGate`/
  `dailyTokenCapGate`** — only the Claude usage threshold gate runs there.
  This is a **pre-existing gap that predates PTYCAP** and is outside PTYCAP's
  scope (the milestone exists specifically because the orchestrator is going
  to drive the *interactive PTY*, not `ChatSurface`). Documented in
  `docs/usage-cost.md` rather than silently left unmentioned; not fixed here
  to keep this PR's blast radius to the PTY path the milestone actually names.
- **Telegram's permission/question-response keystroke injection
  (`injectPtyKeystroke`) is not preflight-checked.** It answers an EXISTING
  pending prompt raised by an already in-flight (already-gated) turn;
  `turn-lock.ts`'s own documented invariant treats a response as exempt from
  turn acquisition because it completes the holder's turn rather than
  starting a new one. Gating it would be gating the wrong event — it spends
  nothing new.
- **Phase 3 (`governedAutomationPtyGate`) is not built here.** This phase only
  proves the chain that a future governed-automation admission will be
  required to pass; no admission path was added.

- **The check covers each submit, not the work that follows it** — in-TUI
  self-continuation (loops, background subagents) never crosses the hub.
- **No per-writer rate limit on term submits** yet.
- **Enter is refused everywhere while over a cap**, including on permission
  prompts and menus the hub cannot distinguish from a prompt submit; Esc still
  cancels.

None of these are silent — each is called out here and in `docs/usage-cost.md`.

## Test evidence

- `hub/test/pty-preflight.test.ts` — chain shape/identity, human vs automation
  chains, halt exemption, fail-closed on throw and timeout, and
  `classifyPtyInput` (CR/LF, CSI-u / keypad Enter, C1, incomplete escapes,
  safe navigation keys, split sequences).
- `hub/test/ws-client-pty-preflight.test.ts` — relay wiring: what is checked
  (independent of `runner_type`), refusal, Ctrl-C/Esc over the cap, CSI-u and
  split-frame Enter, per-session escape tail, arrival order under slow DB
  checks, supersede / lock hand-off / lock-freed mid-check, channel resolved at
  send time, queued-then-promoted submit checked fresh. Run against the
  pre-panel code, every new test fails.
- `web/test/term-refusal.test.ts` — refusal copy.
- `bun run check-baseline`, `bunx tsc --noEmit -p hub/tsconfig.json` (427, all
  pre-existing), `bun run schema-lint`, web build — see the PR for the final run.

## Files touched

- `hub/src/dispatch/pty-preflight.ts` (new), `hub/src/dispatch/pipeline.ts`, `hub/src/dispatch/gates.ts`
- `hub/src/ws/client.ts`
- `hub/test/pty-preflight.test.ts` (new), `hub/test/ws-client-pty-preflight.test.ts` (new)
- `hub/test/token-cap-coverage.test.ts`, `hub/test/term-relay-auth.test.ts`, `hub/test/term-relay-human-guard.test.ts`
- `web/src/lib/termRefusal.ts` (new), `web/src/components/TerminalSurface.tsx`,
  `web/src/hooks/useChat.ts`, `web/src/hooks/useChatSurface.ts`,
  `web/src/pages/settings/UsageTab.tsx`, `web/test/term-refusal.test.ts` (new)
- `docs/usage-cost.md`, `.planning/ROADMAP.md`, `tools/regression-baseline.json`
- `.planning/phases/PTYCAP-02-pty-preflight-gate/02-01-PLAN.md` (new), this file

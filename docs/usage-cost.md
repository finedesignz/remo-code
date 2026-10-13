# Usage Cost Ledger (P2)

Per-turn token + dollar-cost ledger captured from the Claude CLI stream and
persisted on the hub. This is the recording half of usage-monitoring; the
non-bypassable spend cap (P3) is separate and unaffected by P2.

> **Cost is an ESTIMATE.** `cost_usd` is the SDK's authoritative
> `total_cost_usd` per turn when present (`cost_source='sdk'`), else a hub
> list-price estimate (`cost_source='estimated'`). Both are a **subscription
> list-price equivalent**, NOT billed dollars — a Claude Code Max/Pro
> subscriber is not charged per token.

## Flow

```
Claude CLI `result` stream event  (total_cost_usd + usage{4 token buckets})
   ↓  supervisor: ClaudeRunner.parseUsageFromResult → SessionBridge
agent→hub WS  `usage_event`  { session_id, model, tokens, cost_usd, cost_source, ts }
   ↓  hub/src/ws/agent.ts  (RECORD only — no cost-cap routing in P2)
recordTokenUsage()  →  INSERT token_usage  +  UPSERT token_usage_daily (accumulate)
   ↓
GET /api/usage/cost  → today / 7d / total + per-session + per-repo aggregates
```

## Capture (supervisor)

- `supervisor/src/runners/claude-runner.ts` — on the CLI `result` event,
  `parseUsageFromResult(r, lastModel)` extracts `input_tokens`,
  `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  the `model` (from the preceding assistant message, since `result` omits it),
  and `total_cost_usd`. `cost_from_sdk=false` when the cost is absent.
- `supervisor/src/runners/session-bridge.ts` — emits the additive
  `usage_event` agent message (only when token counts are present; an error
  result with no `usage` is skipped, not zero-recorded).
- Ships with **supervisor ≥ 0.8.0** (new MSI required for capture).

## Pricing fallback (hub)

`hub/src/usage/pricing.ts` — model→price table (USD per 1M tokens) consulted
**only** when `cost_source='estimated'`. SDK `total_cost_usd` is authoritative
and never recomputed. Prefix-matched (longest prefix wins). Update the `PRICES`
map from <https://www.anthropic.com/pricing> when rates change (last reviewed
2026-05-30: Opus/Sonnet/Haiku 4.x).

## Persistence (hub)

Idempotent DDL in `hub/src/db/schema.sql` (re-runs every boot):

- **`token_usage`** — one row per turn: `id, user_id, session_id, model,
  input/output/cache_creation/cache_read tokens, cost_usd, cost_source,
  created_at`. Indexed by `(user_id, created_at DESC)` and `(session_id)`.
- **`token_usage_daily`** — rollup PK `(user_id, day, model)`; summed tokens +
  cost, upserted via `ON CONFLICT … DO UPDATE` (ADD, not replace) on each event.

DAL: `hub/src/db/token-usage-dal.ts` (`recordTokenUsage`, `sumUserTokenWindows`,
`usageBySession`, `usageByRepo`). All queries scoped by `user_id`.

## Read API

`GET /api/usage/cost` (authed, user-scoped) — `{ timezone, cost_is_estimate:true,
today, seven_day, total, by_session[], by_repo[] }`. Each window/breakdown
carries the four token buckets + `cost_usd`. Per-repo key = `owner/repo` (from
session `github_owner/github_repo`) else `project_dir` else `unknown`.

`GET /api/usage/summary` (P1) is unchanged — subscription OAuth utilization
windows + scheduled-task cost.

## Per-run attribution (fix/run-cost-attribution)

The same `hub/src/ws/agent.ts` `usage_event` handler that records each turn
into `token_usage` also calls `accrueRunCost(sessionId, costUsd)`
(`hub/src/scheduler/dispatcher.ts`) with the identical cost value, so a
scheduled run's `scheduled_task_runs.cost_usd` gets populated at finalize
instead of staying permanently NULL (verified 100% NULL across 493 historical
rows before this fix). This is pure attribution bookkeeping on the
dispatcher's own in-flight run map — it never writes into `token_usage`, so
the daily cost cap total (§ Daily cost cap in
[scheduled-tasks.md](scheduled-tasks.md)) is unaffected and nothing is
double-counted. See [scheduled-tasks.md § Per-run cost attribution](scheduled-tasks.md#per-run-cost-attribution-scheduled_task_runscost_usd).

## Tests

- `supervisor/test/usage-capture.test.ts` — `parseUsageFromResult` extraction.
- `hub/test/usage-pricing.test.ts` — fallback rate match + estimate math.
- `hub/test/usage-event-handler.test.ts` — insert + daily-upsert accumulation.
- `hub/test/usage-cost-api.test.ts` — `/api/usage/cost` aggregation shape.

## Not in P2

- No cost-cap enforcement on `usage_event` (P3 owns the cap flip).
- No cost UI (P3) — the API is ready for the dashboard.

## Phase 18 — dual-bucket billing guardrail (June-15-2026 split)

From June 15 2026 Anthropic splits subscription billing into TWO independent
pools, and Phase 18 makes both visible + controllable WITHOUT introducing any
API-platform key:

- **Interactive subscription pool (unchanged).** Genuine human turns in the
  interactive PTY draw from the normal subscription limits — the four utilization
  windows (`five_hour` / `seven_day` / Max-only `seven_day_opus` /
  `seven_day_oauth_apps`) already polled by the supervisor.
- **Programmatic credit pool (new).** Agent-SDK / headless `stream-json` /
  `claude -p` usage bills against a monthly DOLLAR credit (Pro $20 / Max-5x $100 /
  Max-20x $200, full API list rates, no rollover, claimed once). The supervisor
  poll (`oauth-poll.ts`) surfaces it ADDITIVELY as
  `programmatic_credit { used_usd, limit_usd, resets_at, claimed }` — a dollar
  bucket, not a util% window. Pre-claim / unknown ⇒ explicit empty state, NEVER a
  fabricated number. It travels the existing `usage_report` → `setUsage`
  (`hub/src/usage/store.ts`) → `subscription_usage` WS path additively (old
  supervisors/clients keep working).

### Routing invariant (R-PTY-19)

Every unattended dispatch source — **scheduler / orchestrator-background /
auto-dev / error-capture** (the `AUTOMATION_ACTORS` set in
`hub/src/dispatch/gates.ts`) — rides the stream-json/programmatic transport and
flows through the SINGLE non-bypassable `dailyCostCapGate`. None can reach the
interactive PTY: the Phase-16 human-only guard (`humanOnlyRejectsActor`) rejects
every non-human actor on a `pty-interactive` session. No automation path
constructs an `ANTHROPIC_API_KEY` — the runner spawn paths delete it; the
programmatic transport is subscription OAuth via stream-json, capped. Guarded by
`hub/test/automation-routing-guard.test.ts`.

### Leak alert + opt-in hard-halt (R-PTY-18)

- **Leak alert (always on).** `detectProgrammaticLeak`
  (`hub/src/usage/programmatic-leak.ts`) fires a `programmatic_leak_alert` WS
  event when programmatic `used_usd` rises while NO automation is in flight, or
  above a configured per-interval drain rate. Visible, non-blocking — never a
  silent drain.
- **Hard-halt (opt-in, OFF by default).** `users.programmatic_halt_usd` (NULL =
  off) is an ADDITIONAL predicate at the same `dailyCostCapGate` chokepoint
  (`isOverProgrammaticHalt`): when the claimed credit crosses the bound,
  programmatic/automation dispatch is denied with reason
  `programmatic_credit_halt:$<used>>=$<bound>`. There is no parallel chokepoint;
  the cost cap remains the single dispatch gate. Human interactive PTY turns
  never hit this gate for this reason, so the halt only ever stops automation.

### Tests (Phase 18)

- `supervisor/test/oauth-poll-dual-bucket.test.ts` / `oauth-poll-credit-absent.test.ts`
  — second-bucket parse, empty state, token-never-leaves-host.
- `hub/test/usage-dual-bucket-additive.test.ts` — additive schema + store.
- `hub/test/programmatic-leak-alert.test.ts` — leak heuristic (no false positives).
- `hub/test/programmatic-hard-halt.test.ts` — default-off + halt at the single gate.
- `hub/test/automation-routing-guard.test.ts` — routing + PTY exclusion + no-API-key.

No REST endpoint changed (the hard-halt config is internal), so `docs:sync` is a
no-op for this phase.

## Phase 19 — cutover gate, default-backend selector, fallback (no API key)

Phase 19 turns the SPEC's *"Verify after June 15"* checks into an explicit,
operator-run **cutover gate** and wires the **"If PTY fails" fallback** — all on
the same raw-terminal PTY surface, with **no API key, ever**.

### The June-15 cutover gate (R-PTY-21)

The full runbook + a checkable checklist live at
[`docs/cutover-gate-june15.md`](cutover-gate-june15.md) and
`.planning/phases/19-cutover-gate-and-automation-fallback/cutover-gate-checklist.md`.
It encodes the four billing-classification checks as a **dual-bucket
snapshot → one interactive PTY turn → snapshot → diff** measurement reading the
Phase-18 `subscription_usage` poll. It is **NOT a build blocker** — Phases 15–18
ship before June 15; only the default-on flip + the ChatSurface deletion are gated.

The ChatSurface (stream-json) deletion is gated separately by
`tools/cutover-deletion-gate.mjs`, which consumes the Phase-16 ship verdict
(`16-VERIFICATION.md`) and refuses (exit 1) until the two on-device attestation
triplets (render_fidelity + mobile_reattach: `by` + `at` + `device_build`) are
recorded. As of this writing the gate is **BLOCKED** (attestations pending).

### Default-backend selector (R-PTY-22)

`supervisor/src/runners/backend-selector.ts` `resolveHumanBackend(ctx, config)`
governs which runner a NEW human session uses. It resolves to an EXPLICIT PTY
runner id — `'claude-pty' | 'codex-pty'` — and **never** the bare `claude`/`codex`
id or the legacy stream-json runner (the legacy runner is unreachable from this
path; any attempt throws). Decision rule:

> **FAIL-SAFE:** until the gate records `claudeInteractiveConfirmed`, the default
> is **`codex-pty`** — users are never silently put on a programmatic-billed path.
> interactive ⇒ `claude-pty`; programmatic ⇒ `codex-pty` (and Claude-PTY is
> disabled/unlisted with an alert, operator-override-clearable).

The flip is a **recorded config change** gated on the runbook result — not an
automatic behavior. Defense-in-depth: the selector re-asserts `ctx.isHuman` and
throws for any automation context (independent of the Phase-16 relay guard).

### Fallback = backend-CLI swap, never an API key (R-PTY-23 / R-PTY-36)

If the Claude PTY path fails, the human-coding UX falls back to **Codex** (the
existing Codex PTY runner on the same terminal surface, authed via
**ChatGPT-subscription sign-in**, NOT an API key), then to a stubbed **Gemini**
seam (`supervisor/src/runners/gemini-pty-runner.ts` — feature-flagged OFF /
not-implemented; Gemini's individual/Pro/Ultra tiers sunset June 18 2026). Grok is
not wired (too immature). The fallback is **always** a backend-CLI swap on the PTY
surface — it **never** reaches a provider API key.

A SINGLE shared sanitizer `supervisor/src/runners/env-sanitize.ts`
(`sanitizeSpawnEnv`) scrubs every provider credential from EVERY runner spawn env
(Claude / Codex / Gemini-stub): a named denylist
(`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, setup-token vars) PLUS anchored
credential-class patterns (`*_API_KEY` / `*_AUTH_TOKEN` / `*_ACCESS_TOKEN` /
`*_API_TOKEN` / `*_SETUP_TOKEN`). It operates on the RESOLVED env, so an INHERITED
key in the supervisor's own `process.env` is deleted too. `setup-token`-derived
credentials are PROHIBITED on the interactive path (billing class unverified) and
are never serialized to the hub. The Node PTY host (`pty-host.mjs`) mirrors the
same denylist + patterns as defense-in-depth (it cannot import the `.ts`).

### R-PTY-24 SUPERSEDED (Telegram is NOT on the programmatic pool)

> **R-PTY-24 is SUPERSEDED by R-TG-01..R-TG-12.** R-PTY-24 originally held that
> "Telegram stays on the stream-json programmatic pool by structural necessity."
> That **no longer holds**: Phase 20 sources Telegram from the **transcript** —
> read-only over the human's interactive PTY session — so Telegram does **NOT**
> consume the programmatic credit pool, and it is **never** worked around with an
> API key. See `.planning/REQUIREMENTS.md` (R-TG-01..12) for the authoritative
> supersession block.

### Tests (Phase 19)

- `supervisor/test/default-backend-selector.test.ts` — fail-safe default, gated
  flip, hard-reject of legacy/non-PTY ids, human-only guard, post-`programmatic`
  disable, no-auto-flip, selector→spawn-argv carries no programmatic flag.
- `supervisor/test/codex-fallback-no-apikey.test.ts` — Codex selectable, no key.
- `supervisor/test/gemini-seam-stub.test.ts` — stub off + never default-selected.
- `supervisor/test/no-apikey-fallback-guard.test.ts` — shared sanitizer + per-backend
  behavioral no-API-key (real spawn path, inherited + novel pattern var + benign
  survival) + grep canary.
- `supervisor/test/no-setup-token-on-interactive.test.ts` — setup-token never on
  the spawn env nor serialized to the hub.
- `hub/test/cutover-gate-runbook.test.ts` — runbook + checklist presence/reference.
- `hub/test/docs-supersession.test.ts` — R-PTY-24 supersession consistency.

No REST endpoint changed (selector + gate are internal), so `docs:sync` is a no-op
for this phase too.

## PTYCAP Phase 1 — PTY-interactive token accounting (`runner_type` split)

The interactive PTY path (Phase 15-19 above) had no token/cost capture of its own —
only the stream-json `result` event does. PTYCAP Phase 1 adds a second, independent
capture path for the interactive CLI, RECORDING into the same `token_usage` ledger
tagged by source.

### Flow

```
Claude CLI (interactive PTY/TUI)  writes its OWN per-project transcript JSONL
   (on the SUPERVISOR host, same file the CLI always wrote — not a new capture)
   ↓  supervisor: PtyUsageEmitter (usage/pty-usage-emitter.ts)
   ↓    tails it via tailJsonl (usage/pty-transcript-tail.ts), one pinned file per session
agent→hub WS  `usage_event`  { session_id, model, tokens, cost_usd (estimated),
                                cost_source:'estimated', runner_type:'pty-interactive', ts }
   ↓  hub/src/ws/agent.ts  (RECORD only — same handler, same code path as stream-json)
recordTokenUsage()  →  INSERT token_usage(runner_type)  +  UPSERT token_usage_daily (accumulate, unsplit)
   ↓
GET /api/usage/cost  → same aggregates as today; getTodayTokenTotalByRunner() gives a
                        per-runner-type split read for anything that wants it
```

### Why the tail is supervisor-side, not hub-side

The hub runs in a Coolify container with no `~/.claude/projects` — a hub-side read of
a home-directory-derived transcript path would work in local dev and silently do
NOTHING in production, the exact failure shape `REMO_TELEGRAM_TRANSCRIPT_TAIL` is
documented "keep OFF in Coolify" for. Every new filesystem read this phase adds lives
under `supervisor/src/usage/`. `hub/test/no-hub-side-transcript-fs.test.ts` is the
structural guard: it fails any FUTURE `hub/src/**` module that calls Node's
home-directory resolver, with the single pre-existing allowlisted exception
(`hub/src/telegram/transcript/`).

### The `runner_type` domain

`token_usage.runner_type` is a two-value TEXT column (`'stream-json'` default |
`'pty-interactive'`), enforced live by the `token_usage_runner_type_check` CHECK
constraint and indexed by `idx_token_usage_user_runner_created`
`(user_id, runner_type, created_at DESC)`. (`sessions.runner_type` is a separate,
pre-existing column on a different table with its own `sessions_runner_type_check` —
same name, unrelated purpose: it records which runner a SESSION uses, not which
runner produced a ledger ROW.) An older supervisor build that predates this phase
omits the field entirely; the hub's `usage_event` handler falls back to
`'stream-json'` (`msg.runner_type ?? 'stream-json'`) so old and new supervisors
both record correctly — the zod field itself stays `undefined` when absent (see
`token-usage-runner-type.test.ts`).

### Four decisions recorded here so they read as decisions, not oversights

- **`token_usage_daily`'s primary key `(user_id, day, model)` is unchanged — NOT
  extended with `runner_type`.** The daily rollup stays runner-agnostic; only the
  per-turn `token_usage` rows (and `getTodayTokenTotalByRunner()`) carry the split.
  Splitting the daily PK would fragment the cost-cap/summary aggregation path that
  deliberately sums every source together (the 2026-07 cache-read incident fix
  exists precisely because splitting by source let a bucket hide from the cap) — a
  fourth PK dimension is only worth adding if a future phase needs a PTY-specific
  daily cap.
- **The hub's `sessions.transcript_path` / `setSessionPtyIdentity()` (the Session-Ask
  API's transcript-tail source) remains unwired to this accounting path.**
  `PtyUsageEmitter` resolves and pins its own transcript path independently
  (`resolveTranscriptPath()`, capture-once locator) rather than reading or writing
  the hub's already-known path. The two are different consumers with different
  trust models — Session-Ask is an on-demand hub-triggered read, this is a
  continuously-tailing supervisor-local process — and unifying them was out of
  scope for this phase.
- **Accounting is claude-only for now; Codex PTY sessions are not tagged or
  tailed.** `PtyUsageEmitter.start()` no-ops when `cliKind !== 'claude'`. Codex's
  rollout JSONL has not been verified to carry an equivalent per-turn usage block;
  claiming Codex support without that verification risks silently mis-recording (or
  silently recording zero) Codex PTY spend. Fast-follow once verified.
- **PTY-sourced `cost_usd` is always `cost_source:'estimated'`, never `'sdk'`.** The
  interactive CLI's transcript JSONL carries token counts but no per-record dollar
  cost (unlike the stream-json `result` event's `total_cost_usd`), so the hub's
  list-price pricing fallback (`hub/src/usage/pricing.ts`) is the only cost source
  available for a PTY-tagged row.

This section is RECORD only, exactly like P2 above — gating the interactive PTY path
against the daily cost/token caps is milestone PTYCAP's Phase 2 (below), not this phase.

### Operator smoke check (not a CI gate)

01-RESEARCH.md's Assumption A2 asks for one live confirmation before trusting this in
production, preserved here rather than dropped: spawn a real PTY session through this
branch's supervisor build on a live host, drive one turn, and confirm (a) the
interactive CLI's transcript JSONL appears under the expected per-project directory
and (b) its usage record reaches `token_usage` tagged `runner_type='pty-interactive'`.
This is an operator action — CI has no real interactive PTY host to prove it against —
record the result out-of-band when performed.

### Tests (PTYCAP Phase 1)

- `supervisor/test/pty-usage-tail.test.ts` — `PtyUsageEmitter` / `extractUsage` /
  `resolveTranscriptPath` core behavior. **Not** counted by `bun run check-baseline`
  (it walks `hub/test` only) — run as its own explicit `.woodpecker/qc.yaml` step.
- `supervisor/test/pty-usage-path-containment.test.ts` — ASVS V4 negative test: a
  relative/traversal/NUL-byte `projectDir`, and a located transcript whose real path
  escapes the projects base, both refuse before any read.
- `hub/test/token-usage-runner-type.test.ts` — DAL bucket split, the
  `AgentUsageEvent` zod round-trip, and a schema.sql CHECK-constraint source
  assertion.
- `hub/test/no-hub-side-transcript-fs.test.ts` — the Pitfall-1 guard canary above.
- `hub/test/pty-usage-midflight-visibility.test.ts` — proves `getTodayTokenTotal()`
  climbs mid-turn with no session-close event anywhere (REMO_E2E_DB_URL-gated).

## PTYCAP Phase 2 — PTY pre-flight gate (`hub/src/dispatch/pty-preflight.ts`)

Phase 1 (above) RECORDED PTY spend; nothing yet CHECKED it before a turn started.
`hub/src/ws/client.ts`'s `term.input`/`term.attach_file` relay forwarded raw
keystroke bytes straight to the agent channel with only a license check, the
human-only guard, and the write-arbitration turn lock in front of it — no cost
cap, no token cap, no threshold gate. Phase 2 closes that gap.

### The gate chain

`hub/src/dispatch/pty-preflight.ts` holds ONE literal array that both the
coverage scan and the runtime read (not a decorative copy):

```
ptyPreflightDispatchConfig.gates = [thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]
PTY_AUTOMATION_TURN_GATES        = ptyPreflightDispatchConfig.gates            // same object
PTY_HUMAN_TURN_GATES             = automation chain minus sessionInjectRateGate
```

`checkPtyTurnPreflight({ userId, sessionId, actor: 'human' | 'automation' })`
runs the matching chain, first-block-wins. A human turn is exempt from the
programmatic-credit halt inside `dailyCostCapGate` (the server-set
`DispatchRequest.humanInteractive` flag) — never from the cost or token caps
themselves. It **fails closed**: a thrown gate resolves to
`pty_preflight_error`, and a check that does not settle within 5s resolves to
`pty_preflight_timeout`.

**No automation path reaches the PTY today, and the reason is structural, not
the `runner_type` gate.** Every automation dispatch adapter (ask, work,
Telegram plain text, scheduler, orchestrator) sends a `user_message` frame,
which the supervisor routes to the stream-json runner
(`supervisor/src/runners/session-bridge.ts`). The PTY accepts only `term.*`
frames, and the only hub writers of those are the web `term.input` relay and
the Telegram permission keystrokes. Keying on `sessions.runner_type` is dead
in prod (see the "Independent of `sessions.runner_type`" bullet below and the
`client.ts` comment), so it is NOT the door. The automation chain is built
and proven here, and Phase 3 (section "PTYCAP Phase 3" below) adds the
flag-gated automation branch and the structural pins that keep the door
closed.

### Call site: `hub/src/ws/client.ts` — every prompt SUBMIT

The `term.input` relay calls `checkPtyTurnPreflight({ …, actor: 'human' })`
(server-inferred — this relay is reachable only from an authenticated
`/ws/client` cookie connection) on **every frame that can submit a prompt**,
as judged by `classifyPtyInput`. Each submit gets its own fresh check at the
moment it would be written; no verdict is cached or shared across frames or
writers.

- **What counts as a submit (fail closed).** CR or LF; **any escape sequence
  not on a small known-safe allowlist** (arrows, Home/End, PgUp/PgDn,
  Insert/Delete, Shift-Tab, focus in/out, bracketed-paste markers, lone Esc,
  Esc-Esc, Alt+printable); C1 CSI/SS3 code points; input that is not valid
  base64 or UTF-8 (a raw 0x9b byte is 8-bit CSI to the PTY). Enter has
  encodings with no CR/LF byte — the Claude CLI's key parser maps the kitty /
  CSI-u sequences `ESC[13u` and `ESC[57414u` to "return" whether or not kitty
  mode was ever enabled, and `ESC O M` is keypad Enter in application mode — so
  a CR/LF-only test was bypassable by a hand-crafted client.
- **Split sequences.** The CLI buffers an incomplete escape across writes, so
  `ESC[` then `13u` in two frames is one Enter. Any escape left OPEN at the end
  of a forwarded frame (a lone Esc, `ESC[`, `ESC[13`, `ESC O`, …) is remembered
  per SESSION (`ptyEscTail`, not per writer — a second connection cannot
  complete it) and the next frame is classified joined with it. An open
  CSI/SS3 prefix is itself a submit, so both the prefix and its completion are
  checked — a prefix that passed under the cap cannot be completed unchecked
  after the cap is crossed.
- **Not gated:** plain typing, Backspace, Tab, Ctrl-C, Esc, navigation keys, and
  `term.attach_file` (it types a path, it does not submit). A user over a cap
  can still type, navigate, interrupt and cancel; only submitting is refused.
- **Enter is refused everywhere while over a cap — not just on prompts.** The
  hub cannot tell a prompt submit from an Enter that confirms a permission
  prompt, a question menu, or a slash command such as `/exit`. So once over a
  cap, a turn that was already running can stall on a permission prompt; Esc
  (cancel) still works. Raising the cap (Settings → Usage) unblocks it.
- **Independent of `sessions.runner_type`.** That column defaults to
  `'stream-json'` and the web client never sets it, while the supervisor writes
  every `term.input` to the PTY on its own `REMO_PTY_INTERACTIVE` env flag —
  gating on the column would leave the check dead in prod.
- **Not keyed on the turn lock.** In prod the lock releases only on its 60s idle
  TTL (`turn_complete` is wired only in transcript-tail mode), so a "once per
  turn" check meant once per idle gap: it refused Ctrl-C mid-turn, and a
  keystroke every <60s kept one passing check alive all day.
- **Ordering:** each write frame claims its slot in a per-(session, writer)
  chain SYNCHRONOUSLY on receipt, before any DB check, so frames from one writer
  reach the PTY in exactly their arrival order — a keystroke never overtakes a
  submit that is still being checked. Immediately before each write the relay
  re-verifies it is still the session's client writer AND holds the turn lock;
  if the lock went free meanwhile it re-takes it, and if another writer now
  holds it the frame is dropped (a dropped submit is refused with
  `not_current_writer`). The agent channel is resolved at send time, so a
  supervisor reconnect mid-check is honoured.
- **Refusal:** the frame is dropped and the sender gets
  `{ type: 'send_refused', channel: 'term', session_id, reason }`.
  `TerminalSurface` prints a red status line in the terminal
  (`web/src/lib/termRefusal.ts`); chat hooks ignore `channel: 'term'`.

### What this does NOT do (explicitly deferred)

- **The check covers each SUBMIT, not the work that follows it.** One passing
  submit can start work that keeps going inside the TUI (a looping prompt,
  background subagents) — those self-continuations never cross the hub, so a
  cap crossed mid-run does not interrupt them. Interrupting a PTY session whose
  usage events cross a cap is a follow-up.
- **No per-connection rate limit on term frames.** Term frames short-circuit
  before the structured-message limiter. Memory is bounded — each
  (session, writer) chain holds at most `MAX_PENDING_TERM_FRAMES` (256) pending
  frames; past that, frames are dropped with a `term_backpressure` refusal — and
  a single writer has at most one check in flight, but many connections could
  each drive checks. Follow-up: a per-writer submit rate limit.
- **The stream-json `send_message` handler in `hub/src/ws/client.ts` is still
  NOT gated by `dailyCostCapGate`/`dailyTokenCapGate`** — only the Claude usage
  threshold gate runs there. This is a **pre-existing gap predating PTYCAP**,
  not something Phase 2 introduced or was asked to fix (PTYCAP's whole mandate
  is the interactive PTY path specifically — the milestone that "blocks every
  other milestone" because the orchestrator is going to drive the PTY, not
  ChatSurface). Tracked as follow-up, not silently left undocumented.
- **Telegram's permission/question-response keystroke injection
  (`injectPtyKeystroke`, `hub/src/api/telegram-webhook.ts`) is NOT preflight-
  checked.** It answers an EXISTING pending prompt raised by an already
  in-flight (already-gated) turn — per `turn-lock.ts`'s own documented
  invariant, a response is exempt from turn acquisition because it completes
  the holder's turn rather than starting a new one. It spends nothing new;
  gating it would be gating the wrong event.
- **Telegram's plain-text dispatch** (`telegram/dispatch.ts` -> `dispatch()`)
  sends a `user_message`, which the supervisor routes to the stream-json
  runner, NOT the PTY. It runs the threshold/cost/token caps plus
  `governedAutomationPtyGate` via the existing pipeline -- it was never
  ungated, so Phase 2 does not touch it.
- **Phase 3 admission** (`governedAutomationPtyGate`, letting a governed
  automation actor drive a PTY) is documented in the "PTYCAP Phase 3" section
  below. Phase 2 only proved the gate chain that admission must pass.

### Tests (PTYCAP Phase 2)

- `hub/test/pty-preflight.test.ts` — chain shape/order (SC-1), the scanned
  literal being the same object that runs, the human chain excluding
  `sessionInjectRateGate` (SC-3), human exemption from the programmatic-credit
  halt (but not the cost cap), fail-closed on a thrown gate and on timeout, and
  `isPtySubmit`.
- `hub/test/ws-client-pty-preflight.test.ts` — the relay wiring: every submit is
  checked (also on a default `stream-json` session); typing, Ctrl-C, Esc and
  attachments never are; a refusal sends `send_refused` on the term channel;
  ordering is kept while a submit is paused mid-check; supersede or lock
  release mid-check drops the frame; a queued submit is checked with state
  fresh at promotion. Nine of these fail against the previous lock-keyed
  implementation.
- `web/test/term-refusal.test.ts` — the user-facing refusal text.
- `hub/test/token-cap-coverage.test.ts` — "known dispatchers" names
  `dispatch/pty-preflight.ts` (SC-2).
- `hub/test/term-relay-auth.test.ts` / `term-relay-human-guard.test.ts` — stub
  `checkPtyTurnPreflight` so their unrelated concerns don't need Postgres.

## PTYCAP Phase 3 -- governed-automation guard (hub/src/dispatch/governed-pty.ts)

Phase 2 built the automation preflight chain but nothing could call it. Phase 3
adds the admission decision a non-human actor must pass before it may drive a
`pty-interactive` session, behind a flag that is OFF by default, and pins the
door structurally so a new producer cannot bypass it. With the flag ON, Phase 3
production still admits NOTHING, by design (see Governors; Phase 4 replaced the two fail-closed slots, see "PTYCAP Phase 4" below).

### Flag

`REMO_GOVERNED_AUTOMATION_PTY` -- read at call time by
`governedAutomationEnabled()` (never cached). True only for `1|true|yes|on`
after trim and lowercase; anything else, including garbage, is OFF. Default
OFF is a TRUE no-op: with the flag off the gate returns exactly the legacy
decision and reason string for every (actor x runnerType) pair, calls its
resolver once and invokes zero governors. This is proven by the OFF == legacy
differential in `hub/test/governed-pty-gate.test.ts` (one test per OFF value).
Flipping it in prod is an owner-only live cutover and is not documented here
with a production value.

### The gate

`governedAutomationPtyGate(resolver)` (gate name `governed_automation_pty`;
formerly `humanOnlyPtyGate`, hard rename with no alias) is composed into the
ask, work and Telegram dispatch gate lists. Decision order:

1. Resolve `{ actor, runnerType }` (once).
2. Non-PTY runner, or the exact `human` actor: ok.
3. Flag OFF: block `automation_blocked_on_pty:<actor>` (the legacy reason).
4. Actor not in `AUTOMATION_ACTORS`: block with the same legacy reason.
5. Governors in fixed order, first block wins.

Eligible actors are `AUTOMATION_ACTORS` members only. `external-ask`,
`external-work`, the empty string and unknown strings are always denied, flag
ON and every governor passing included. The actor is server-inferred (the ask
and work resolvers return compile-time constants; nothing in a request body can
claim `human` or `automation`).

### Governors

Fixed order, cheapest and most authoritative first. Governors are
NON-CONSUMING checks (no writes, no counters). The dollar cost cap is NOT a
governor. A thrown governor is a typed denial
`automation_blocked_on_pty:<actor>:governor_error:<name>`, never a pass.

| Order | Governor | Phase-3 body | Block reason |
|---|---|---|---|
| 1 | `kill_switch` | real (Phase 4): the same function as the dispatcher-list gate, fresh read, fail closed | `automation_halted:<scope>` |
| 2 | `token_cap` | blocks when `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP_DISABLED` is truthy | `governor_unconfigured:token_cap` |
| 3 | `inject_rate` | still blocks an invalid `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR` (unset/blank uses the default 4); Phase 4 also COUNTS the de-duplicated trailing-hour union | `governor_unconfigured:inject_rate` or `over_session_inject_rate:<n>>=<cap>` |
| 4 | `lifetime_counter` | real (Phase 4): non-consuming lifetime check, needs a counter key | `lifetime_counter_key_missing` or `lifetime_inject_exhausted:<n>>=<cap>` |

The token "over the limit" evaluation stays with `dailyTokenCapGate`; the
`token_cap` governor only refuses a disabled ceiling. Since Phase 4 the
`kill_switch` and `lifetime_counter` governors are real (the same function
references the dispatcher-list gates run, no wrapper). With the flag ON the door
still admits nothing in production until a Phase 5 producer supplies a counter
key and a per-turn token: it refuses `lifetime_counter_key_missing`. The admit path is proven only under test dependency injection
(`_setGovernorsForTests` / `_resetGovernorsForTests`); there is deliberately no
public governors parameter, which would be a bypass handle.

### The door (`checkPtyTurnPreflight` automation branch)

For a non-`human` actor `checkPtyTurnPreflight` checks the flag FIRST (before
any DB-backed gate), then runs the automation spend chain, then the governors.
Block reasons are `automation_blocked_on_pty:<actor>` or
`automation_blocked_on_pty:<actor>:<governor_reason>`. A throwing gate or
governor resolves to `pty_preflight_error`; a check that does not settle in 5s
resolves to `pty_preflight_timeout`. The human chain (`PTY_HUMAN_TURN_GATES`)
NEVER runs a governor, and a human turn passes with the fail-closed production
governors and the flag ON (pinned in `hub/test/pty-preflight.test.ts`).

### Door pins (`hub/test/pty-door-guard.test.ts`)

DB-free structural source scans with non-vacuous scanner self-checks:

- Exactly two hub modules emit `term.*` frames to the agent (the web relay and
  the Telegram keystroke injector); the frame-type set is derived from
  `CLIENT_TO_HUB_TERM_TYPES`.
- Supervisor canary: the `user_message` and `permission_response` branches of
  `supervisor/src/runners/session-bridge.ts` reference no PTY runner or PTY
  write.
- Caller pins: actor `automation` is assigned only under `hub/src/orchestrator/`;
  actor `human` only in `ws/client.ts`; `checkPtyTurnPreflight(` is called only
  from `pty-preflight.ts`, `ws/client.ts` or `orchestrator/`;
  `injectPtyKeystroke(` only in `pty-inject.ts` and `telegram-webhook.ts`;
  `dispatchToSession` is imported only by `telegram-webhook.ts` and
  `telegram/doctor.ts` (alias-aware scan; doctor takes it as an injected
  `dispatch` param for the buffered replay of an authenticated-webhook message,
  and its call object is pinned to `source: 'human'`).
- The flag and DI literals live only in `dispatch/governed-pty.ts`.
- The actor is server-inferred: nothing under `hub/src/dispatch/` reads a
  request source or actor field, and `DispatchRequest` declares none.
- The Telegram dispatch `source` is a REQUIRED parameter with no `human`
  default; the webhook passes `'human'` at the authenticated boundary.
- A new hub emitter of `term.*` frames or a new privileged caller fails this
  test.

### Exemptions (pinned, with justification)

Exactly two preflight exemptions, each with a one-line justification:

- **Telegram permission-answer keystrokes** (`injectPtyKeystroke`): answers an
  EXISTING pending prompt of an already-gated turn; it spends nothing new.
- **`term.attach_file`**: types a path into the terminal, it does not submit.

Documented non-hole inconsistency (D-10): the web relay refuses an Enter that
confirms a permission prompt while over a cap, but the Telegram permission-answer
keystroke is not preflighted, so Telegram can answer the same prompt over cap.
Both only complete the holder's already-admitted turn; neither starts new spend.

### Honest scope

The three call-site gates (ask, work, Telegram) are NOT the door onto a PTY:
all of them send `user_message`, which the supervisor routes to the stream-json
runner. The door is the PTY turn preflight plus the structural pins above.
SC-1 ("no automation actor reaches a PTY without passing the governors") is
therefore met structurally, and the admit path is proven only under test DI.
SC-4 holds: the five supervisor no-API-key and argv-allowlist guard tests pass
with no file under `supervisor/` changed.

### Residuals and hand-offs

- **D-15, cookie / legacy-JWT:** `human` is a credential identity, not proof of
  typing. A future bearer-automation lane must use `/ws/agent` or an ext key,
  never a cookie, so it cannot be mistaken for the human relay.
- **D-12, count before trust:** an admitted automation PTY turn must be COUNTED
  (durable ledger) before the governed chain is trusted. Delivered in Phase 4
  (the door reserves before the send).
- **D-14, reserve-before-send:** Phase-3 governors are non-consuming checks;
  atomic reserve-before-send consumption was delivered in Phase 4.
- **D-11:** the Phase-2 mechanism claims above were corrected here (structural
  `user_message` routing, not the `runner_type` gate; Telegram plain text goes
  via `user_message`).

### Tests (PTYCAP Phase 3)

- `hub/test/governed-pty-gate.test.ts` (28) -- flag OFF differential, flag
  parsing, eligible actors, governor order and reasons, thrown governor, DI.
- `hub/test/pty-preflight.test.ts` additions -- the governed automation branch
  (9) and the human chain never running a governor (4).
- `hub/test/pty-door-guard.test.ts` (21) -- the door pins above.
- `hub/test/ws-client-pty-preflight.test.ts` -- the ws-client strip case (a
  client-supplied actor is ignored; the relay actor stays `human`).
- `hub/test/telegram-human-only-guard.test.ts` -- the missing-source case.

## PTYCAP Phase 4 -- lifetime inject counter, kill switch, 60% alarm

Phase 3 left two fail-closed governor slots. Phase 4 fills them and puts the same
controls on every machine dispatch path. Code: `hub/src/dispatch/automation-controls.ts`
(neutral module; imports no gate or governor module), `hub/src/api/automation.ts`,
`hub/src/observability/token-cap-alarm.ts`.

### Ledger and atomic reserve

`automation_inject_ledger` is append-only (no deletes; `released_at`, reset markers and
page rows are compensation rows). `reserveInject` runs ONE reservation inside a
per-counter-key advisory lock (plus a fixed-order per-session lock when the rate check
runs): lifetime count first, then the trailing-60-minute rate over the de-duplicated set
union of the session's `routine_run_log` inject rows (joined by `inject_token`) and ledger
reserve rows. It is idempotent per `(counter_key, token)`. The reserve happens BEFORE the
send; a refusal or a send failure releases it and frees the queue slot. Requests that are
parked, queued or dropped before a send never count. `dispatch()` runs `preSendGuard` before
`store.open` and a SEPARATE final halt check immediately before `deps.send`. Machine paths that emit a
`session.start` / `run_command` OUTSIDE `deps.send` (the launch primitives, spawn-on-error, the heal route,
the scheduler supervisor and TEAB senders) re-read the kill switch through `haltBeforeMachineSend`
(`dispatch/automation-controls.ts`) immediately before the transmission, fresh and fail closed; a halt closes
the run row / reservation the path opened. `dispatch()` also re-reads it before handing control to a machine
request's `ensureOnline`.

### Counter keys

| Key | Assigned by |
|---|---|
| `task:<scheduled_tasks.id>` | scheduler agent sender and every orchestrator inject (online and autospawn) through the resolver: one budget per orchestrator |
| `triage:<application_uuid>` | scheduler triage sender (one budget per Coolify application) |
| `heal:<userId>:<repo>` | `POST /api/sessions/heal` |
| `session:<id>` | where no task exists |

Only server code assigns keys (`counter-key-assignment-guard.test.ts`); a request body can
never carry one.

### Coverage matrix

| Path | Kill switch | Lifetime counter | Reason |
|---|---|---|---|
| orchestrator inject (online + autospawn), scheduler agent, triage | first | last | counted, keyed |
| error-capture, feedback, revanote | first | exempt | event stream with no task identity; bounded by their own rate limits and the spend caps |
| ask, work | first | exempt | key-less external requests; bounded by `askRateGate` / `workRateGate`, the repo allowlist and the spend caps |
| Telegram dispatch, cloud send | never | never | HUMAN surfaces: a halt must not lock the owner out of their own sessions |
| PTY door (automation) | governor 1 | governor 4 + reserve | human actor never reserved |
| scheduler `fireTask` / one-time `fire()` / orchestrator due-scan / auto-launch / orphan resume | halt check | n/a | every run path, not keyed on `isManual` |
| `POST /api/sessions/heal` | halt check first | one `heal:<userId>:<repo>` reserve | MACHINE surface (panel F-2): the external self-heal service emits `session.start` outside the guarded launch primitives |
| `POST /api/sessions/:id/launch`, `POST /api/supervisors/:id/start` | never | never | HUMAN web Connect/Start |

`kill-switch-coverage.test.ts` is default-deny: a new machine gate list must be counted or
carry an exemption reason. `launch-callers-guard` and `session-start-senders-guard`
enumerate the launch primitives (the predicate runs only when a caller passes `machine: true`)
and every `session.start` sender. Refusal reasons: `automation_halted:<scope>` and
`lifetime_inject_exhausted:<n>>=<cap>`; the heal route's 503 bodies use the same codes
(`automation_halted`, `lifetime_inject_exhausted`).

### The literal lifetime cap (read this)

The lifetime cap is a COUNT, never a rate: default **1000** per counter key, raisable with
`REMO_AUTOMATION_LIFETIME_INJECT_CAP` (invalid value refuses boot), reset only by the owner.
A key that fires every 15 minutes uses 1000 injects in about ten days, so recurring
automation continues indefinitely only through owner resets or a raised cap. The owner is
paged once at **80 percent** of the cap (`ceil(0.8 * cap)`, the 80% lifetime warning) and
once at exhaustion, each per counter key and reset epoch (page rows in the same ledger;
every count query filters to reserve rows only). Panel F-5a resolved this from the ROADMAP
SC-1 text itself.

### Kill switch and owner emergency paths

Scopes: global (admin role), user (always the caller), session (owned by the caller, 404
otherwise). State is a row in `automation_kill_switch` (three partial unique indexes) read
fresh on every check and fail closed; `REMO_AUTOMATION_KILL_SWITCH` is the call-time
break-glass that engages global regardless of the database (a restart is needed to change it).

| Route | Auth | Notes |
|---|---|---|
| `GET /api/automation/kill-switch` | session | env flag, global row, caller's user row, session rows |
| `POST /api/automation/kill-switch/engage` | session, NO step-up, ACTIVE license | row only; never stops a running session or cancels an in-flight turn |
| `POST /api/automation/kill-switch/release` | session + login under 15 min old | fires the event-driven resume of deferred work for that scope |
| `POST /api/automation/lifetime/reset` | session + login under 15 min old | appends a reset marker; answers `{ok, counter_key}`; 404 with no ledger rows |

Emergency paths with no UI: the API engage; the env break-glass plus restart (the path for
an owner in expired-license grace); recovery from a stale login is a fresh login.

### Alarm (60 percent)

A token-usage listener (fire-and-forget) feeds `token-cap-alarm.ts`, which coalesces per
user (5 s quiet, 30 s max wait), reads the ceiling through `getTokenCapStatus` (cap disabled
means silent), claims `(user_id, local_date)` atomically in `token_cap_alarms` and emails
`users.email` once per local day when usage first crosses `REMO_TOKEN_CAP_ALARM_PCT`
(default 60). The delivered flag flips only on a successful send; an undelivered claim
retries on later usage events (5 attempts, 300 s cooldown). In-app and Telegram fan-out run
only after the email was delivered.

### Door contract for the Phase 5 producer

The door reserves after the governors with `{counterKey, turnToken}` supplied only from
`hub/src/orchestrator/`. The token is PER TURN (never the constant per-session
`pty-preflight:` token); a missing token refuses `pty_turn_token_missing`, a missing key
`lifetime_counter_key_missing`; the door owns consumption. Blocked results compose as
`automation_blocked_on_pty:<actor>:<reason>`. `reserveInject(` callers are pinned
(`reserve-caller-guard.test.ts`: the controls module, the door, the heal route).

### Residuals

- In-flight turns are not cancelled by an engage; only the next send is refused.
- Deleting and recreating a task or session re-mints its counter key (a fresh budget).
- Per-key 1000 lifetime: a 15 minute cron needs an owner reset about every ten days.
- A halt detected after a once-task claim RE-ARMS the task (no burned client work); the
  once-work sender re-arms and finalizes that attempt as skipped. The once-due sweep
  cadence is unchanged.
- Releasing ANY scope resumes the deferred orchestrator orphans in that scope.
- With the PTY flag ON, the ask, work and Telegram governed lists carry no counter key, so
  the `lifetime_counter` governor refuses `lifetime_counter_key_missing` until Phase 5/7
  supply keys: fail closed, flag default OFF.
- G-1 (supervisor): the PTY usage emitter now dedupes on `message.id` (supervisor 0.15.1),
  but a signed supervisor MSI must reach hosts before it takes effect; until then the
  recorded PTY consumption (and so the effective ceiling) is roughly 2.5x too low.
- The real-Postgres proof of the SQL is CI-only (`hub/test/e2e/automation-controls-checks.ts`,
  called from an existing DB-gated e2e test body; zero new skips).
- Deferred to Milestone GOV: Telegram or UI kill-switch trigger; opt-in cancellation of
  active runs; counter policy for QC keys (Phases 7-9).

### Tests (PTYCAP Phase 4)

`automation-schema`, `automation-controls-core`, `automation-controls-config`,
`dispatch-final-halt`, `dispatch-reserve`, `automation-tracer`, `automation-api`,
`automation-boot-order`, `token-usage-listener`, `token-cap-alarm`,
`kill-switch-coverage`, `scheduler-halt`, `once-rearm`, `orchestrator-tick-halt`,
`sessions-heal-halt`, `launch-machine-guard`, `launch-callers-guard`,
`session-start-senders-guard`, `reserve-caller-guard`, `counter-key-assignment-guard`,
`replay-reentry-guard`, and supervisor `pty-usage-tail` (dedupe).

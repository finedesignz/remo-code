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

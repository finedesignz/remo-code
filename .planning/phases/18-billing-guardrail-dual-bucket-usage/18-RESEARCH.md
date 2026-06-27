# Phase 18: billing-guardrail-dual-bucket-usage - Research

## Summary

The June-15-2026 Anthropic split is confirmed: programmatic Claude usage on subscription plans (Agent
SDK, `claude -p`, headless `stream-json`, GitHub Actions, third-party agents) moves OFF interactive
subscription limits ONTO a separate per-user monthly DOLLAR credit pool, billed at full API list rates,
no rollover, claimed once. Interactive Claude Code in a terminal stays on subscription limits. This
phase surfaces BOTH buckets in the existing poll, alerts/halts on programmatic drain, and pins the
structural invariant that automation rides the programmatic path behind the cost cap (never the PTY).

The load-bearing unknowns are (1) WHICH endpoint exposes the programmatic credit balance (the existing
poll hits `/api/oauth/usage` for subscription windows; the credit pool may be the same endpoint, a
sibling, or only the account UI), and (2) the exact leak heuristic. Findings below; the endpoint is the
gating manual re-verification against a live post-claim account.

## Key findings

### 1. The June-15 billing split (R-PTY-17, R-PTY-19) — CONFIDENCE: HIGH (announced), MEDIUM (mechanics)
- **Two independent buckets.** Interactive pool (UNCHANGED): Claude.ai web/desktop/mobile, Claude Code
  used interactively in the terminal, Claude Cowork — all keep drawing from the normal subscription
  limits. Agent SDK credit pool (NEW): a fixed monthly DOLLAR credit funding programmatic + autonomous
  usage, billed at full API list prices, no rollover.
- **Credit amounts (reported):** Pro $20 / Max-5x $100 / Max-20x $200 per month. Refreshes each billing
  cycle. Must be CLAIMED once via a pre-June-15 email ("before June 15", widely reported ~June 8) — so
  until the user claims, the programmatic bucket is "unclaimed" (an explicit empty state, not zero
  spend).
- **`claude -p` = headless / non-interactive mode** — exactly remo-code's current spawn
  (`supervisor/src/runners/claude-runner.ts` uses `--input-format stream-json --output-format
  stream-json`). That path is the programmatic entrypoint → metered against the credit pool from
  June 15 (~95% confidence per the SPEC). This is precisely why the human PTY surface exists and why
  automation is explicitly KEPT on this metered path behind the cost cap.
- **Implication for the poll:** the second bucket is a DOLLAR balance (used/limit/resets/claimed), NOT
  a utilization% window. It needs its own additive shape on the `UsagePayload` — do not jam it into the
  four existing `{utilization, resets_at}` windows.
- Re-verify: amounts + claim mechanics are from secondary reporting of Anthropic's May-14-2026
  announcement; treat the dollar figures as display-only and read the real numbers from the live
  endpoint.

### 2. WHICH endpoint exposes the programmatic credit balance — CONFIDENCE: LOW (OPEN ITEM, gating)
- The existing poll: `OAUTH_USAGE_URL = https://api.anthropic.com/api/oauth/usage` with the
  `anthropic-beta: oauth-2025-04-20` header (ported from the ClaudeUsage module). It returns the four
  subscription windows.
- It is UNCONFIRMED whether `/api/oauth/usage` was extended to include the Agent-SDK credit pool, or
  whether a sibling endpoint (e.g. `/api/oauth/credits` — name unverified) carries it, or whether the
  balance is only in the account web UI (in which case the supervisor cannot poll it and the bucket
  stays an explicit "unknown" empty state).
- MANDATE: the adapter MUST degrade to an explicit "programmatic bucket unknown / unclaimed" state when
  the endpoint does not return a usable credit balance. It NEVER fabricates a dollar number. This is
  the same fail-safe posture as the subscription poll's `no_usable_windows` → `{ ok:false }`.
- GATING manual re-verification: on a live, post-claim Max account after June 15, capture the actual
  response body that carries the credit balance (endpoint + field names). Until then the parser is
  provisional and the UI shows the empty state. Same `autonomous:false` checkpoint posture as the
  Phase-15 compile spike.

### 3. Programmatic-leak heuristic (R-PTY-18) — CONFIDENCE: MEDIUM (design choice)
- "Leak" definition (documented, errs toward visible): programmatic credit `used_usd` increases while
  the hub observes NO automation dispatch in flight for that user, OR the drain rate exceeds a
  user-configured $/interval threshold.
- The hub already knows dispatch in-flight state (the dispatch pipeline + `dailyCostCapGate` run there),
  so the leak detector is best placed in the HUB (it has both the polled credit snapshot via the store
  and the dispatch state) rather than the supervisor (which only has the raw poll).
- Alert = a WS event (e.g. `programmatic_leak_alert`) + a usage-tab notice. NEVER suppress silently.
- Hard-halt (opt-in): when `used_usd` crosses a user-configured bound, add a predicate at
  `dailyCostCapGate` so programmatic/automation dispatch is denied (typed reason
  `programmatic_credit_halt`). Off by default; the alert fires before the bound, so it is never a
  surprise. Human PTY turns are unaffected (they are on the interactive pool and never hit this gate
  for this reason).

### 4. Automation-routing invariant (R-PTY-19) — CONFIDENCE: HIGH (existing code)
- `hub/src/dispatch/gates.ts` already centralizes `dailyCostCapGate` / `isOverCostCap` as the SINGLE
  chokepoint, and `hub/test/mount-order.test.ts` + the dispatch tests already assert every inbound
  user→session dispatch flows through it. CLAUDE.md §"Cross-cutting invariants" mandates this.
- Phase 18 adds a TEST that asserts each unattended source (scheduler / orchestrator-background /
  auto-dev / error-capture) is on the stream-json/programmatic transport AND passes through
  `dailyCostCapGate`, and that NONE of them can reach the interactive PTY (the Phase-16 human-only
  guard rejects non-interactive dispatch sources). This is a regression guard, not new routing.

### 5. Existing poll → store → WS wiring (R-PTY-17, R-PTY-20) — CONFIDENCE: HIGH (read in repo)
- Supervisor: `oauth-poll.ts` `pollUsage()` returns `{ ok, usage: UsagePayload }`; sent as a
  `usage_report` agent message.
- Hub: `hub/src/ws/agent.ts:582` `setUsage(userId, msg.usage)` → `subscription_usage` broadcast;
  `hub/src/ws/client.ts:196` forwards to web; shapes in `hub/src/ws/agent-protocol.ts:147` (Zod) +
  `hub/src/ws/protocol.ts:347`. EXTEND all four additively (optional second-bucket field) so old
  supervisors/clients keep working.
- `hub/src/usage/store.ts` is in-memory, reconverges on restart (5-min repoll) — fine for the credit
  snapshot too; no DB needed for the snapshot.

### 6. QC gate
- `bun run check-baseline` (per-file isolation; register new hub/test + supervisor/test files in
  `tools/regression-baseline.json` if required). `web/test/no-indigo.test.ts` unaffected (UI adds a
  card in existing accent tokens).

## Open technical questions for the implementer to resolve (feed SUMMARYs)
1. The endpoint + response shape that carries the Agent-SDK programmatic credit balance on a live
   post-claim account (the gating item — until captured, the bucket is an explicit empty state).
2. Whether the leak heuristic's "automation in flight" signal is cleanly readable at the leak-detector
   site in the hub (it should be — the dispatch pipeline runs there).
3. The exact list of unattended dispatch sources to assert in the routing guard test (scheduler /
   orchestrator-background / auto-dev / error-capture — confirm none added since).

## Validation Architecture
- Poll parser: unit test with a FIXTURE response body (post-claim shape) → second bucket parsed; an
  endpoint-absent / no-credit-field body → explicit empty state, NO fabricated number.
- Token-never-leaves-host: a test asserts the second-bucket addition does not serialize any token into
  the `usage_report` payload (grep + assertion the payload has no token field).
- Leak alert: a fixture where `used_usd` rises with no in-flight automation → alert emitted; a rise
  WITH in-flight automation → no false alert.
- Hard-halt: opt-in off by default (a test asserts default-off); when on + bound crossed →
  `dailyCostCapGate` denies programmatic dispatch with the typed reason; human PTY turn unaffected.
- Routing guard: each unattended source passes `dailyCostCapGate` + is rejected by the human-only guard
  on the PTY surface.
- WS additivity: an old-shape `subscription_usage` (no second bucket) still validates.

## Sources
- Anthropic June-15-2026 billing split (two buckets; Agent SDK / `claude -p` / headless onto a separate
  monthly dollar credit at full API rates, no rollover, claim-once): The New Stack
  "Anthropic splits billing again: Agent SDK gets separate credit pools"; InfoWorld "Anthropic puts
  Claude agents on a meter across its subscriptions"; XDA "Claude subscriptions no longer include Agent
  SDK and claude -p usage"; codersera / digitalapplied / chatforest explainers (all May 2026, secondary
  reporting of the May-14 announcement — re-verify the dollar figures + claim flow + endpoint).
- Existing infra: `supervisor/src/usage/oauth-poll.ts`, `hub/src/usage/store.ts`,
  `hub/src/ws/{agent,client,protocol,agent-protocol}.ts`, `hub/src/dispatch/gates.ts`,
  `hub/src/api/usage.ts`.
- Cross-cutting invariants: `CLAUDE.md`.

## RESEARCH COMPLETE

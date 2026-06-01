# Phase 18: billing-guardrail-dual-bucket-usage - Context

Extend the existing supervisor usage poll so the user can SEE both billing buckets — the interactive
subscription pool AND the new post-June-15 programmatic credit pool — and be alerted (with an optional
hard-halt) when programmatic credit drains unexpectedly. Plus the structural routing decision:
unattended automation rides the stream-json/programmatic path behind the existing non-bypassable cost
cap; only genuine human turns touch the interactive PTY.

This is monitoring + guardrail. It does **NOT** gate the rip (Phases 15–17 ship before June 15; the
rip is gated only by surface-proven mechanical verification per the SPEC §"Sequencing safeguard"). The
June-15 measurement that gates the *default backend* lives in Phase 19, and consumes the dual-bucket
poll built here.

## Phase Boundary

**In scope.**
- Extend `supervisor/src/usage/oauth-poll.ts` to parse and emit a SECOND bucket — the programmatic
  Agent-SDK credit pool — alongside the existing four subscription windows, in a way that maps onto the
  existing `usage_report` → `hub/src/usage/store.ts` → `subscription_usage` WS broadcast path.
- Hub store + WS protocol carry the second bucket additively (no shape break for existing clients).
- Programmatic-leak alert: detect programmatic-credit consumption that is unexpected (consumed while no
  automation run is in flight, or rate-of-drain above a threshold) and surface it (WS event + a
  user-visible notice).
- Optional hard-halt: a user-controlled switch that, when programmatic credit crosses a configured
  bound, halts further programmatic/automation dispatch (rides the existing `dailyCostCapGate` gate
  seam — same chokepoint, additional predicate). Off by default; no surprise hard-stop.
- Automation-routing assertion: scheduler / orchestrator-background / auto-dev / error-capture dispatch
  is explicitly on the stream-json/programmatic path behind `dailyCostCapGate`; the PTY-runner
  human-only guard (Phase 16) ensures automation never rides the interactive PTY.
- Usage strip/tab renders BOTH buckets without exposing the OAuth token.

**Out of scope.**
- The PTY runner + human-only guard themselves (Phases 15–16).
- The rip (Phase 17).
- The June-15 measurement runbook + default-backend flip (Phase 19) — Phase 18 only BUILDS the poll it
  uses.
- Any API-key path (forbidden, all phases).
- Changing the cost-cap *amount* semantics (P3a already counts real token cost); Phase 18 only adds the
  programmatic-credit predicate as an additional, optional bound.

## Sequencing

- **Depends on Phase 16** (the human-only guard must exist so the automation-routing assertion has a
  guard to point at). Buildable BEFORE June 15 — the second bucket's numbers will simply read zero /
  unclaimed until the user claims the Agent-SDK credit, which is the correct empty state.
- Independent of Phase 17's rip for the poll itself; the automation-routing assertion references the
  preserved stream-json automation transport (Phase 17 keeps the runner-side stream-json path, deletes
  only its human chat UI).

## Implementation Decisions (LOCKED — from spec + roadmap)

### Dual-bucket poll (R-PTY-17)
- Extend the SAME poll (`oauth-poll.ts`) and the SAME WS path (`usage_report` →
  `subscription_usage`). Do NOT build a parallel poller.
- HARD INVARIANT carried verbatim: the OAuth access token lives ONLY on the dev machine
  (`~/.claude/.credentials.json`), read ONLY in the supervisor poll, NEVER serialized to the hub. Only
  the parsed, non-secret utilization/credit snapshot is sent. The second bucket adds NO new secret to
  the wire.
- The programmatic credit pool is a monthly DOLLAR credit (Pro $20 / Max-5x $100 / Max-20x $200),
  billed at full API list rates, no rollover, claimed once before it activates (see RESEARCH). The
  snapshot SHALL carry the bucket as `{ used_usd, limit_usd, resets_at, claimed: bool }` (exact field
  names = Claude's discretion) — a dollar bucket, NOT a util% window like the subscription ones, so it
  needs its own shape, additive to the existing payload.
- Endpoint reality is uncertain: the existing poll hits `/api/oauth/usage`. Whether that endpoint
  surfaces the new credit pool, or a sibling endpoint does, is an OPEN ITEM (RESEARCH) to confirm
  against a live post-claim account. Until confirmed the adapter degrades to "programmatic bucket
  unknown / unclaimed" (an explicit empty state) — never fabricates a number.

### Programmatic-leak alert + optional hard-halt (R-PTY-18)
- "Leak" = programmatic credit consumed when it should not be: (a) drain observed while NO automation
  dispatch is in flight, or (b) drain rate above a user threshold. Definition is heuristic and
  documented; it errs toward ALERTING (visible), never toward silent suppression.
- Alert is a WS event + a user-visible usage-tab notice. No silent drain.
- Hard-halt is OPT-IN (off by default). When on and the bound is crossed, it adds a predicate at the
  existing `dailyCostCapGate` chokepoint so further programmatic/automation dispatch is denied with a
  typed reason. NEVER a surprise stop — the user configured the bound and the alert fired first.

### Automation routed to programmatic path behind the cost cap (R-PTY-19)
- This phase does not re-route automation; it ASSERTS + DOCUMENTS the existing invariant and adds a
  guard test: every unattended dispatch source (scheduler / orchestrator-background / auto-dev /
  error-capture) flows through `dailyCostCapGate` (the single `isOverCostCap` source of truth) and is
  on the stream-json/programmatic transport, never the interactive PTY. The Phase-16 human-only guard
  is the structural enforcement that automation cannot ride the PTY.
- No API key anywhere — the automation path is the user's subscription OAuth via stream-json
  (programmatic pool), capped, never an API platform key.

### Dual-bucket rendered in usage UI (R-PTY-20)
- The existing usage strip/tab (`UsageStrip` / `UsageTab`) renders the second bucket: dollars
  used/remaining + reset, plus the leak-alert notice and the hard-halt toggle. Token never exposed.
- Blue accent / no-indigo unaffected; `web/test/no-indigo.test.ts` stays green.

### Constraints carried (spec §Hard constraints)
- No `ANTHROPIC_API_KEY` ever; no API-key fallback.
- Official client only; OAuth token never serialized to the hub (poll-side invariant preserved).
- Only genuine human turns touch the PTY (the automation-routing assertion is the other half of this
  invariant — automation stays OFF the PTY).
- Interactive CLI only for human sessions (inherited).
- QC gate: `bun run check-baseline` (per-file isolation; register new test files in
  `tools/regression-baseline.json` if the gate requires it).

### Claude's Discretion
- Exact field names for the programmatic-bucket snapshot; whether the leak heuristic lives in the
  supervisor or the hub (prefer the hub, where dispatch in-flight state is known); the alert WS event
  name; the hard-halt config key + default-off storage location; poll cadence for the second bucket
  (reuse the existing 5-min interval unless the endpoint demands otherwise).

## Canonical References

### Source spec (authoritative)
- `.planning/architecture/interactive-pty-runner-SPEC.md` §"Context — why this exists" (the June-15
  split), §"If PTY fails", §"Hard constraints".

### Existing usage poll infra (EXTEND — do not rebuild)
- `supervisor/src/usage/oauth-poll.ts` — the proven OAuth usage poll; `pollUsage()`,
  `parseUsageResponse`, `readAccessToken` (token-never-leaves-host invariant lives here).
- `hub/src/usage/store.ts` — in-memory per-user `UsagePayload` snapshot; `setUsage`/`getUsage`.
- `hub/src/ws/agent.ts:582` — `usage_report` handler → `setUsage` → broadcast `subscription_usage`.
- `hub/src/ws/client.ts:196` — `subscription_usage` send to web.
- `hub/src/ws/protocol.ts:347` — `subscription_usage` WS message shape (extend additively).
- `hub/src/ws/agent-protocol.ts:147` — `usage_report` Zod schema (extend additively).
- `hub/src/api/usage.ts` — `/api/usage/*` REST surface.

### Cost-cap chokepoint (the hard-halt seam — reuse, do not fork)
- `hub/src/dispatch/gates.ts` — `dailyCostCapGate` + `isOverCostCap` (the SINGLE source of truth).
  `getTodayTokenCostUsd` (`hub/src/db/token-usage-dal.ts`). Hard-halt adds a predicate HERE.

### Web usage UI
- `UsageStrip` / `UsageTab` (web) — render the second bucket + alert + toggle.

### Cross-cutting invariants
- CLAUDE.md §"Cross-cutting invariants": cost cap non-bypassable (single `dailyCostCapGate`);
  `schema.sql` idempotent-only (a hard-halt config column, if persisted, is idempotent DDL; backfills →
  `hub/scripts/`); OAuth token never serialized to the hub.

## Specific Ideas
- The existing four-window poll already proves the token-never-leaves-host pattern; the second bucket
  is the same pattern with a dollar shape — minimal new surface, maximal reuse.
- The hard-halt is the cost cap's twin: the cap counts spend, the halt counts programmatic-credit
  drain; both terminate at the same `dailyCostCapGate` chokepoint so there is still ONE place dispatch
  is gated.

## Deferred Ideas
- Per-automation-source credit attribution (which routine burned the programmatic credit) — needs the
  usage_event ledger joined to dispatch source; future.
- DB-persisted historical programmatic-credit timeseries (today's store is in-memory, reconverges on
  restart) — future.

---
Status: ready for planning.

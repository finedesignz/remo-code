<!-- updated: 2026-07-12 -->

# Roadmap — Milestone PTYCAP (Token-Gate the Interactive PTY Path)

> **This milestone blocks every other milestone.** The owner has decided the orchestrator will
> drive the interactive PTY (see `.planning/PROJECT.md` → Position on Anthropic). The PTY path
> currently has **no token ceiling** — usage is recorded only post-hoc, and `dailyCostCapGate` is a
> *dollar* cap, which is theatre on a flat-rate subscription. Arming automation on the PTY before
> gating it points the exact gun that killed the owner's Max subscription on 2026-07-11.
>
> Prior-milestone roadmaps archived under `.planning/milestones/`. Phase dirs are milestone-scoped
> (`PTYCAP-NN-slug`).

## Hard invariants (encoded in every phase's success criteria)

- **No provider API key on the PTY path — ever.** The argv allowlist-of-one, `env-sanitize.ts`, and
  the no-API-key guard tests stay green. Relaxing *human-only* does NOT relax *no-API-key*.

- **The actor is server-inferred, never client-asserted** (cookie ⇒ human, api_key ⇒ agent). A
  spoofed `source` field must never be able to impersonate a human turn.

- **No dispatch path may spend outside the gate chain.** `hub/test/token-cap-coverage.test.ts`
  scans every `gates: [...]` in `hub/src` and fails CI on omission. Anything that spawns a CLI turn
  *outside* `dispatch()` (e.g. the supervisor's circuit-breaker probe) is a defect, not an exception.

- **Caps are denominated in tokens.** Dollars are advisory.
- Additive idempotent DDL only (`schema.sql` re-runs every boot); backfills → `hub/scripts/` one-shots.

## Phases

- [ ] **Phase 1: PTY Token Accounting** — live, mid-turn token accounting for a PTY turn (post-hoc is too late; a TUI turn can run for many minutes).
- [ ] **Phase 2: PTY Pre-Flight Gate** — a programmatic turn cannot be written to the PTY without passing the full gate chain.
- [ ] **Phase 3: Governed-Automation Guard** — `humanOnlyPtyGate` → `governedAutomationPtyGate`, new flag, default OFF.
- [ ] **Phase 4: Lifetime Inject Counter + Kill Switch** — rate ceilings don't stop a slow grind; add a lifetime per-task counter and a real kill switch.
- [ ] **Phase 5: Throwaway-Repo Due→PR Proof** — prove the thing actually works, once, on a repo nobody cares about.
- [ ] **Phase 6: Hardening + Docs + Release** — real-Postgres e2e, docs, version bump, ship, smoke-verify.

## Phase Details

### Phase 1: PTY Token Accounting

**Goal**: The hub knows what a PTY turn is spending *while it spends it*, not after.
**Depends on**: #346 (token gate on all stream-json paths) merged.
**Success Criteria**:

  1. (SC-1) A live PTY turn's token usage is observable mid-turn, not only on completion.
  2. (SC-2) Interactive and programmatic usage remain in separate buckets (the metering early-warning signal).
  3. (SC-3) A long-running TUI turn that crosses the ceiling mid-flight is detectable.

**Plans:** 2/4 plans executed

Plans:

- [x] 01-01-PLAN.md — TRACER: one PTY assistant turn's tokens reach the ledger end-to-end (supervisor transcript tail → `usage_event` tagged `pty-interactive` → `token_usage.runner_type`)
- [x] 01-02-PLAN.md — SC-2: bucket split proven at the DAL, the zod WS contract, the DDL source, and the live Postgres CHECK constraint; untagged frames still record as `stream-json`
- [ ] 01-03-PLAN.md — SC-3 mid-flight visibility of `getTodayTokenTotal()`, plus the Pitfall-1 hub-side-fs guard canary and the ASVS-V4 transcript path-containment negative test
- [ ] 01-04-PLAN.md — wire the SC-1 proof into the Woodpecker PR gate, re-measure `tools/regression-baseline.json`, document the path and its four explicit deferrals

### Phase 2: PTY Pre-Flight Gate

**Goal**: No programmatic turn reaches the PTY without passing the full gate chain.
**Depends on**: Phase 1.
**Success Criteria**:

  1. A programmatic write to the PTY passes `[thresholdGate, dailyTokenCapGate, dailyCostCapGate, sessionInjectRateGate]` or it does not happen.
  2. `token-cap-coverage.test.ts` is extended to cover the PTY path.
  3. Human turns are unaffected — a human at a keyboard is never gated by an inject-rate ceiling.

### Phase 3: Governed-Automation Guard

**Goal**: Automation may drive the PTY, but only under governance.
**Depends on**: Phase 2 (the gate must exist before the door opens).
**Success Criteria**:

  1. `humanOnlyPtyGate` becomes `governedAutomationPtyGate`: a non-human actor is admitted **only** when carrying token cap + inject-rate ceiling + lifetime counter + kill switch.
  2. Actor remains server-inferred. A spoofed `source` cannot impersonate a human (negative test).
  3. Flag-gated, **default OFF**. A true no-op when off.
  4. The no-API-key and argv-allowlist guard tests still pass unchanged.

### Phase 4: Lifetime Inject Counter + Kill Switch

**Goal**: A slow grind is as impossible as a fast loop.
**Depends on**: Phase 3.
**Success Criteria**:

  1. A **lifetime** per-task inject counter (4/hr forever is still 35,000/year).
  2. An owner-facing kill switch halts all automation immediately, hub-wide and per-session.
  3. Alarm emails the owner at 60% of the daily token ceiling.
  4. Default daily token cap lowered from 50M to a survivable figure (~20M).

### Phase 5: Throwaway-Repo Due→PR Proof

**Goal**: The orchestrator produces one reviewable PR, unattended, on a repo nobody cares about.
**Depends on**: Phase 4.
**Success Criteria**:

  1. Branch-only. **Never merges to main.** One whitelisted repo. Hard budget.
  2. It produces a reviewable PR with a green CI check, or it cleanly does nothing and says why.
  3. This has **never once happened**. Until it does, the orchestrator is unproven and unsellable.

### Phase 6: Hardening + Docs + Release

**Goal**: Shipped, documented, verified live.
**Depends on**: Phases 1–5.
**Success Criteria**:

  1. Real-Postgres e2e covers the PTY gate + the governed-automation guard + the kill switch.
  2. `CLAUDE.md` env section + `docs/` updated; `bun run docs:sync` clean (docs-drift CI green).
  3. Version bumped in lockstep, deployed, smoke-verified at app.remo-code.com.

## Progress

| Phase | Status |
|-------|--------|
| 1. PTY Token Accounting | In Progress|
| 2. PTY Pre-Flight Gate | Not started |
| 3. Governed-Automation Guard | Not started |
| 4. Lifetime Counter + Kill Switch | Not started |
| 5. Throwaway-Repo Due→PR Proof | Not started |
| 6. Hardening + Docs + Release | Not started |

## Dependency graph

```
#346 ──> Phase 1 ──> Phase 2 ──> Phase 3 ──> Phase 4 ──> Phase 5 ──> Phase 6
```

Strictly serial by design. Each phase is a safety precondition for the next. **Do not parallelize
Phase 3 ahead of Phase 2** — that is the ordering that caused the 2026-07-11 incident.

## After PTYCAP

Milestone **GOV** (the governance surface: org spend ledger, policy caps, audit, kill switch UI,
receipts page) — that is the product being sold. See `.planning/PROJECT.md` → Planned Milestones.

**Before Milestone MONEY**: run the 48-hour demand test (fleet-ops angle, $99/mo team waitlist,
r/ClaudeAI + HN). It is unrun, it is free, and it is the biggest untested assumption in the project.

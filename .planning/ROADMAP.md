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
- [ ] **Phase 7: Unified Self-Heal Routing** — ONE heal pipeline fed by EVERY failure source; live-session-first routing; fail fast as `no_routable_session` instead of hanging 6h.
- [ ] **Phase 8: Periodic Task QC + Optimization** — a bounded meta-task auditing every `scheduled_tasks` row; allowlisted auto-fixes only; everything else is an emailed proposal.
- [ ] **Phase 9: Cap-Hit → QC Trigger** — a cap-hit fires ONE bounded, non-recursive QC pass that fixes the cause or escalates to the human.

> **Phases 7–9 are specified now, BUILT LATER.** They are written during PTYCAP so the design exists
> before the capability is armed — but they are **not buildable until PR #346 lands and Phases 1–4
> are green**. They ARM unattended AI spawning in response to failures: the same capability class
> that burned the owner on 2026-07-11. The Phase-4 **lifetime inject counter + kill switch are a hard
> precondition** for any failure-triggered spawn. Phase 7 additionally **rebases on PR #346**, which
> currently owns `hub/src/scheduler/senders/triage.ts`, `hub/src/dispatch/gates.ts`,
> `hub/src/db/supervisor-dal.ts`, `hub/src/sessions/stale-run-reaper.ts` and the four dispatchers.

## Phase Details

### Phase 1: PTY Token Accounting
**Goal**: The hub knows what a PTY turn is spending *while it spends it*, not after.
**Depends on**: #346 (token gate on all stream-json paths) merged.
**Success Criteria**:
  1. (SC-1) A live PTY turn's token usage is observable mid-turn, not only on completion.
  2. (SC-2) Interactive and programmatic usage remain in separate buckets (the metering early-warning signal).
  3. (SC-3) A long-running TUI turn that crosses the ceiling mid-flight is detectable.

**Plans:** 4 plans (waves 1 / 2 / 2 / 3)

Plans:
- [ ] 01-01-PLAN.md — TRACER: one PTY assistant turn's tokens reach the ledger end-to-end (supervisor transcript tail → `usage_event` tagged `pty-interactive` → `token_usage.runner_type`)
- [ ] 01-02-PLAN.md — SC-2: bucket split proven at the DAL, the zod WS contract, the DDL source, and the live Postgres CHECK constraint; untagged frames still record as `stream-json`
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

### Phase 7: Unified Self-Heal Routing
**Goal**: EVERY failure source (Coolify deploy webhook, scheduled-task failure, error-capture,
feedback intake) feeds ONE heal pipeline with ONE routing decision — not four half-healers. A
failure with nowhere to go fails FAST and says so; it never hangs for six hours.
**Spec**: `.planning/phases/PTYCAP-07-self-heal-routing/07-SPEC.md`
**Depends on**: Phase 4 (lifetime counter + kill switch must exist before failure-triggered spawning
is armed) **and PR #346** (which owns `triage.ts`, `gates.ts`, `supervisor-dal.ts`,
`stale-run-reaper.ts` + the four dispatchers — Phase 7 rebases on it, never races it).
**Success Criteria**:
  1. All four failure sources call ONE `routeHeal()` seam; a guard test fails CI if a source
     constructs its own routing/dispatch.
  2. Routing is: repo session LIVE → dispatch into the live session (no spawn); LIVE-less +
     allowlisted → autospawn via the existing BSA path, then dispatch; LIVE-less + not allowlisted →
     terminal `skipped`/`no_routable_session` within seconds, exactly one notification.
  3. It rides the shared `hub/src/dispatch/` chain (gates → queue → grace → finalize). No
     hand-rolled per-subsystem dispatch (CLAUDE.md invariant).
  4. No heal run can sit `pending` until the 6h `run_timeout` reaper — replayed by the incident
     fixtures (runs `8a6e0534`, `fa377e27`; task `0e16bf38`).
  5. Flag-gated; default OFF is a true no-op reproducing today's behaviour exactly.

### Phase 8: Periodic Task QC + Optimization
**Goal**: A recurring, bounded meta-task audits every `scheduled_tasks` row for failing / silently
skipping / never firing / misconfigured / dead-session-routed, fixes ONLY what is on an explicit
safe-fix allowlist, and emails a PROPOSAL for everything else.
**Spec**: `.planning/phases/PTYCAP-08-task-qc/08-SPEC.md`
**Depends on**: Phase 4 (its own bounded ceiling rides the same counter/kill-switch machinery).
**Success Criteria**:
  1. Six detectors run against real rows and classify without writing: FAILING, SKIP_FOREVER,
     NEVER_FIRED, MISCONFIGURED, DEAD_SESSION, OPTIMIZE.
  2. The auto-fix allowlist is a literal, enumerated set. A fix not on it is IMPOSSIBLE to apply —
     a guard test asserts the writer rejects any unlisted fix kind.
  3. It NEVER auto-disables a task, never mutates another session's in-flight work, and never opens
     a dev loop: its own token ceiling is separate and small.
  4. Everything not auto-fixed becomes one digest email with a proposal per finding.
  5. Flag-gated; default OFF; empty allowlist ⇒ report-only.

### Phase 9: Cap-Hit → QC Trigger
**Goal**: Hitting a token cap stops being a dead end. It fires a single bounded QC pass that tries to
fix the CAUSE, and escalates to the human when it cannot.
**Spec**: `.planning/phases/PTYCAP-09-cap-hit-qc-trigger/09-SPEC.md`
**Depends on**: Phase 4 **and** Phase 8 (the QC pass IS the Phase-8 engine, re-targeted at one cause).
**Success Criteria**:
  1. A `dailyTokenCapGate` / `sessionInjectRateGate` / lifetime-counter block emits ONE typed
     cap-hit event carrying the attributed cause.
  2. **Anti-recursion (the incident shape):** a cap-hit raised INSIDE a QC run escalates to the human
     and spawns NOTHING. Provable by test: QC-origin cap-hit ⇒ zero QC runs enqueued.
  3. Dedupe: at most one QC run per `(task_id, cause)` per window; the second is dropped, logged.
  4. QC runs on a separate, bounded, non-recursive budget that cannot be raised by a QC run.
  5. Flag-gated; default OFF ⇒ a cap-hit behaves exactly as it does today (email only).

## Progress

| Phase | Status |
|-------|--------|
| 1. PTY Token Accounting | Planned — 4 plans (#346 confirmed merged) |
| 2. PTY Pre-Flight Gate | Not started |
| 3. Governed-Automation Guard | Not started |
| 4. Lifetime Counter + Kill Switch | Not started |
| 5. Throwaway-Repo Due→PR Proof | Not started |
| 6. Hardening + Docs + Release | Not started |
| 7. Unified Self-Heal Routing | Specced, not started (blocked on #346 + Phase 4) |
| 8. Periodic Task QC + Optimization | Specced, not started (blocked on Phase 4) |
| 9. Cap-Hit → QC Trigger | Specced, not started (blocked on Phases 4 + 8) |

## Dependency graph

```
#346 ──> Phase 1 ──> Phase 2 ──> Phase 3 ──> Phase 4 ──> Phase 5 ──> Phase 6
                                                 │
                                                 ├──> Phase 7 (also rebases on #346)
                                                 │
                                                 └──> Phase 8 ──> Phase 9
```

Phases 1–6 are strictly serial by design. Each is a safety precondition for the next. **Do not
parallelize Phase 3 ahead of Phase 2** — that is the ordering that caused the 2026-07-11 incident.

Phases 7–9 hang off **Phase 4**, not off Phase 6: the lifetime inject counter and the kill switch are
the preconditions that make failure-triggered spawning survivable. Phase 7 and Phase 8 may be built
in parallel once Phase 4 is green (they share no files: 7 owns the heal-routing seam + the four
failure sources, 8 owns a new `task-qc` module + `scheduled_tasks` reads). **Phase 9 must not start
before Phase 8** — it re-uses Phase 8's engine, and building the trigger before the bounded engine
exists recreates the unbounded-loop shape.

## After PTYCAP

Milestone **GOV** (the governance surface: org spend ledger, policy caps, audit, kill switch UI,
receipts page) — that is the product being sold. See `.planning/PROJECT.md` → Planned Milestones.

**Before Milestone MONEY**: run the 48-hour demand test (fleet-ops angle, $99/mo team waitlist,
r/ClaudeAI + HN). It is unrun, it is free, and it is the biggest untested assumption in the project.

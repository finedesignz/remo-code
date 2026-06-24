---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 03
type: execute
wave: 2
depends_on:
  - 18-01
  - 18-02
files_modified:
  - hub/src/usage/programmatic-leak.ts
  - hub/src/dispatch/gates.ts
  - hub/src/ws/protocol.ts
  - hub/src/db/schema.sql
  - hub/test/programmatic-leak-alert.test.ts
  - hub/test/programmatic-hard-halt.test.ts
autonomous: true
requirements:
  - R-PTY-18
must_haves:
  truths:
    - "A programmatic-leak alert fires when programmatic credit drains while NO automation dispatch is in flight, OR drain rate exceeds a user threshold — surfaced as a WS event + usage notice, never suppressed silently"
    - "An OPTIONAL hard-halt (OFF by default) adds a predicate at the existing dailyCostCapGate so programmatic/automation dispatch is denied when the user-configured programmatic-credit bound is crossed"
    - "The hard-halt NEVER affects human interactive PTY turns (they are on the interactive pool and do not pass this gate for this reason); it is never a surprise (alert fires first; user set the bound)"
  artifacts:
    - path: "hub/src/usage/programmatic-leak.ts"
      provides: "leak detector (drain vs in-flight automation) + hard-halt predicate"
  key_links:
    - from: "programmatic-leak hard-halt predicate"
      to: "dailyCostCapGate chokepoint in hub/src/dispatch/gates.ts"
      via: "additional predicate at the SAME single dispatch gate (no parallel chokepoint)"
      pattern: "isOverCostCap(...) || isOverProgrammaticHalt(...)"
---

<objective>
No silent drain, no surprise hard-stop. Detect programmatic-credit leaks and alert; add an opt-in
hard-halt that rides the EXISTING cost-cap chokepoint (so dispatch is still gated in exactly one
place). Human PTY turns are never halted.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-CONTEXT.md
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-RESEARCH.md
@hub/src/dispatch/gates.ts
@hub/src/usage/store.ts
@hub/src/ws/protocol.ts
@CLAUDE.md
</context>

<threat_model>
- **T-18-04 — Silent drain (HIGH).** Programmatic credit quietly empties because nothing watches it.
  Mitigation: a leak detector + a WS alert event + a usage-tab notice; the design errs toward visible.
  A test asserts a drain with no in-flight automation raises the alert; a drain WITH legit in-flight
  automation does NOT false-alert.
- **T-18-05 — Surprise hard-stop (CRITICAL).** A hard-halt that fires unconfigured or that also halts
  human work would be a worse failure than the leak. Mitigation: hard-halt is OPT-IN, default OFF (test
  asserts default-off); it only ever denies programmatic/automation dispatch at `dailyCostCapGate`,
  NEVER a human interactive PTY turn; the leak alert precedes the bound so it is never silent. Block
  on: CRITICAL.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Programmatic-leak detector + WS alert</name>
  <files>hub/src/usage/programmatic-leak.ts, hub/src/ws/protocol.ts, hub/test/programmatic-leak-alert.test.ts</files>
  <read_first>
    - hub/src/usage/store.ts (snapshot incl. programmatic_credit)
    - hub/src/dispatch/gates.ts (how in-flight dispatch state is observable)
  </read_first>
  <acceptance_criteria>
    - A pure-ish detector takes (prev snapshot, new snapshot, in-flight-automation flag, user threshold) → optional `ProgrammaticLeakAlert`
    - Alert when used_usd rises AND no automation in flight, OR drain rate over threshold; otherwise none
    - A `programmatic_leak_alert` WS message is added to protocol.ts and emitted to the user's client connections
    - Test: drain + no in-flight ⇒ alert; drain + in-flight ⇒ no alert (no false positive)
  </acceptance_criteria>
  <action>
    Implement the detector in the hub (it has both the snapshot and dispatch state). Keep the heuristic
    documented in a header comment (RESEARCH §3). Emit the alert via the existing per-user client
    broadcast helper.
  </action>
  <verify>
    <automated>cd hub; bun test test/programmatic-leak-alert.test.ts 2>$null</automated>
  </verify>
  <done>Leaks are visible; no false alerts during legitimate automation.</done>
</task>

<task type="auto">
  <name>Task 2: Opt-in hard-halt predicate at dailyCostCapGate</name>
  <files>hub/src/dispatch/gates.ts, hub/src/db/schema.sql, hub/test/programmatic-hard-halt.test.ts</files>
  <read_first>
    - hub/src/dispatch/gates.ts (dailyCostCapGate, isOverCostCap — the SINGLE chokepoint)
    - hub/src/db/schema.sql (idempotent DDL only; where user-scoped config lives)
  </read_first>
  <acceptance_criteria>
    - A user-scoped, default-OFF config (e.g. `users.programmatic_halt_usd NUMERIC NULL`, idempotent DDL) controls the bound; absent/null ⇒ disabled
    - `dailyCostCapGate` gains a predicate: programmatic/automation dispatch is denied with reason `programmatic_credit_halt` ONLY when the config is set AND the programmatic used_usd ≥ bound
    - The gate change does NOT add a new chokepoint — it extends the single existing one
    - A test asserts: default-off ⇒ never halts; on + bound crossed ⇒ programmatic dispatch denied; a human interactive PTY turn is NOT subject to this denial
  </acceptance_criteria>
  <action>
    Add the optional config column (idempotent ALTER, no backfill — schema.sql re-runs every boot).
    Extend `dailyCostCapGate`'s predicate set; keep `isOverCostCap` as the cost predicate and add
    `isOverProgrammaticHalt` beside it. Reuse the snapshot from the store. The human PTY path does not
    flow through this gate (the human-only guard + interactive pool) — assert that boundary in the test.
  </action>
  <verify>
    <automated>cd hub; bun test test/programmatic-hard-halt.test.ts 2>$null</automated>
    Manual: toggle the bound on a live account; confirm a programmatic dispatch is denied while a human PTY turn still runs.
  </verify>
  <done>Opt-in hard-halt rides the single cost-cap chokepoint; default-off; never halts humans.</done>
</task>

</tasks>

<verification>
- default-off proven; no surprise stop
- hard-halt denies ONLY programmatic/automation dispatch, never the interactive PTY
- leak alert fires on genuine drain, not on legit automation
- still exactly ONE dispatch chokepoint (grep for new isOver* used only inside gates.ts)
- `bun run check-baseline` green
</verification>

<success_criteria>
The user sees programmatic-credit leaks immediately and can opt into a hard-halt that stops only
automation, never their own interactive work, with the cost cap remaining the single dispatch gate.
</success_criteria>

<output>
Create `.planning/phases/18-billing-guardrail-dual-bucket-usage/18-03-SUMMARY.md`.
</output>

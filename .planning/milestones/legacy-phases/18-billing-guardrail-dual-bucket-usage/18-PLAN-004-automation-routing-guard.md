---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 04
type: execute
wave: 2
depends_on:
  - 18-03
files_modified:
  - hub/test/automation-routing-guard.test.ts
  - docs/usage-cost.md
autonomous: true
requirements:
  - R-PTY-19
must_haves:
  truths:
    - "Every unattended dispatch source (scheduler / orchestrator-background / auto-dev / error-capture) flows through the single dailyCostCapGate and rides the stream-json/programmatic transport"
    - "No automation source can reach the interactive PTY surface — the Phase-16 human-only guard rejects non-interactive dispatch sources"
    - "No API key anywhere on the automation path — it is subscription OAuth via stream-json (programmatic pool), capped"
  artifacts:
    - path: "hub/test/automation-routing-guard.test.ts"
      provides: "regression guard asserting automation routing + PTY exclusion"
  key_links:
    - from: "scheduler/orchestrator-bg/auto-dev/error-capture dispatch"
      to: "dailyCostCapGate (programmatic path) and NOT the PTY human-only surface"
      via: "shared dispatch pipeline gates + Phase-16 human-only guard"
      pattern: "dispatch source ∈ automation ⇒ gated by cost cap, rejected by PTY guard"
---

<objective>
Assert + document (do NOT re-route) the structural invariant: unattended automation rides the
programmatic stream-json path behind the non-bypassable cost cap, and can never ride the interactive
PTY. This is a regression guard plus the docs that pin the rationale.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-CONTEXT.md
@.planning/phases/18-billing-guardrail-dual-bucket-usage/18-RESEARCH.md
@hub/src/dispatch/gates.ts
@CLAUDE.md
@docs/usage-cost.md
</context>

<threat_model>
- **T-18-06 — Automation escapes the cost cap (HIGH).** A new or refactored automation source dispatches
  without passing `dailyCostCapGate`, draining the programmatic pool uncapped. Mitigation: a guard test
  enumerates the automation sources and asserts each routes through the single gate (mirrors the
  existing mount-order/dispatch invariant). Block on: HIGH.
- **T-18-07 — Automation rides the interactive PTY (CRITICAL, ToS).** An automation source injected into
  the interactive PTY is the flagged "robot pressing enter via the interactive entrypoint" move
  (SPEC constraint 3). Mitigation: a negative test asserts each automation source is REJECTED by the
  Phase-16 human-only guard at the PTY surface. Block on: CRITICAL.
</threat_model>

<tasks>

<task type="auto">
  <name>Task 1: Automation-routing regression guard test</name>
  <files>hub/test/automation-routing-guard.test.ts</files>
  <read_first>
    - hub/src/dispatch/gates.ts (dailyCostCapGate, the gate list each dispatch passes)
    - the Phase-16 human-only guard module (the PTY-surface dispatch-source check)
  </read_first>
  <acceptance_criteria>
    - The test enumerates the automation dispatch sources (scheduler, orchestrator-background, auto-dev, error-capture) and asserts each passes through `dailyCostCapGate`
    - The test asserts each automation source is REJECTED by the human-only guard if pointed at the PTY surface (negative)
    - The test asserts no automation path constructs an ANTHROPIC_API_KEY env / API-platform call (grep-style assertion over the dispatch + runner spawn paths)
  </acceptance_criteria>
  <action>
    Author the guard against the real dispatch source enum + the Phase-16 guard. If Phase 16's guard
    module name differs, resolve it from the runner spawn path. Keep the test data-driven over the
    source list so a new source forces an explicit decision.
  </action>
  <verify>
    <automated>cd hub; bun test test/automation-routing-guard.test.ts 2>$null</automated>
  </verify>
  <done>Automation routing + PTY exclusion + no-API-key are regression-guarded.</done>
</task>

<task type="auto">
  <name>Task 2: Document the dual-bucket routing in docs/usage-cost.md</name>
  <files>docs/usage-cost.md</files>
  <read_first>
    - docs/usage-cost.md (existing cost-ledger + cap section)
  </read_first>
  <acceptance_criteria>
    - A new section documents: the two buckets (interactive subscription vs programmatic credit), that human PTY turns bill interactive, that automation bills programmatic behind the cost cap, the leak alert + opt-in hard-halt, and the NO-API-KEY invariant
    - No drift: the doc references the actual gate (`dailyCostCapGate`) + the WS `subscription_usage` / `programmatic_leak_alert` shapes
  </acceptance_criteria>
  <action>
    Append the section; keep it consistent with the SPEC's wording. `docs:sync` only if a REST endpoint
    changed (none here — the hard-halt config is internal).
  </action>
  <verify>
    <automated>cd hub; bun run check-baseline 2>$null</automated>
  </verify>
  <done>Routing + guardrail documented; no doc drift.</done>
</task>

</tasks>

<verification>
- each automation source passes dailyCostCapGate (guard test)
- each automation source rejected at the PTY human-only guard
- no ANTHROPIC_API_KEY on any automation path
- docs/usage-cost.md updated; `bun run check-baseline` green
</verification>

<success_criteria>
The automation-on-programmatic-behind-the-cap / never-on-the-PTY / no-API-key invariant is both
regression-guarded and documented.
</success_criteria>

<output>
Create `.planning/phases/18-billing-guardrail-dual-bucket-usage/18-04-SUMMARY.md`.
</output>

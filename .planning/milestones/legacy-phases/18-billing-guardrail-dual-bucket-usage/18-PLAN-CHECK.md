# Phase 18 — Plan Check + Nyquist Verdict

**Checked:** 2026-05-31
**Checker:** orchestrator (gsd-plan-checker / gsd-nyquist-validator subagents unavailable in this
planning-agent context — no Task nesting. Manual review against the gsd-plan-checker + Nyquist rubric.
CAVEAT: not an independent subagent verdict — re-run the subagent checkers before execution if
available.)

## Requirement coverage (R-PTY-17..20)

| Req | Plan(s) | Covered |
|-----|---------|---------|
| R-PTY-17 dual-bucket usage poll (token never serialized) | 01 (poll) + 02 (store/WS additive) | ✅ |
| R-PTY-18 programmatic-leak alert + optional hard-halt | 03 | ✅ |
| R-PTY-19 automation routed to programmatic path behind cost cap, no API key | 04 | ✅ |
| R-PTY-20 dual-bucket rendered in usage UI (no token exposed) | 05 | ✅ |

No orphan requirements; no plan task without a requirement.

## Quality-gate checklist (per workflow step 8 rubric)

- [x] PLAN.md files created in phase dir (5 plans, waves 1-1-2-2-3)
- [x] Each plan has valid YAML frontmatter (wave, depends_on, files_modified, autonomous, requirements, must_haves)
- [x] Every task has `<read_first>` including the file being modified
- [x] Every task has `<acceptance_criteria>` with source/behavior/CLI assertions (no subjective language)
- [x] `<action>` blocks carry concrete identifiers (`UsagePayload.programmatic_credit`, `dailyCostCapGate`, `isOverProgrammaticHalt`, `programmatic_leak_alert`, fixture paths) without full implementations
- [x] Dependencies correct: {01,02} → 03 → 04; {02,03} → 05
- [x] Waves assigned (1: poll + schema additivity; 2: leak/halt + routing guard; 3: UI)
- [x] must_haves derived from the phase goal + R-PTY-17..20
- [x] `<threat_model>` present on every plan (security_enforcement=true); the two CRITICAL threats
      (OAuth-token leak T-18-01; surprise hard-stop T-18-05; automation-on-PTY T-18-07) each carry a
      NEGATIVE test (the dangerous path produces nothing)
- [x] Sequencing safeguard respected: Phase 18 is monitoring/guardrail, does NOT gate the rip; the
      default-backend gate is Phase 19
- [x] Hard constraints carried: no API key (routing guard asserts it); official client only; OAuth token
      never serialized to the hub (negatively tested); automation never on the interactive PTY
- [x] schema.sql additions are idempotent DDL only (hard-halt config column), no backfill
- [x] WS/schema changes are ADDITIVE (old supervisor/client compat tested)

## Nyquist (validation sampling) verdict

VALIDATION.md present with a per-task verification map, sampling biased to the load-bearing security
invariants (token-never-leaks; no-surprise-halt; automation-never-on-PTY), Wave-0 stubs + shared
fixtures (with-credit / no-credit bodies), and explicit manual-only gating items (the programmatic-
credit endpoint capture; live leak+halt round-trip). CRITICAL invariants are sampled with NEGATIVE
tests, not just positive ones. The fail-safe empty state (unknown endpoint ⇒ no fabricated number) is
sampled. **Dimension 8: PASS.**

## Risks / decisions still open for the operator

1. **Programmatic-credit endpoint + body shape (HIGH, gating).** Unconfirmed whether `/api/oauth/usage`
   carries the credit pool, a sibling does, or only the account UI. Until captured on a live post-claim
   account after June 15, the bucket is an explicit empty state. `18-PLAN-001` Task 1 is
   `autonomous:false` for this reason. (Endpoint facts are secondary-sourced + fast-moving — re-verify.)
2. **Leak heuristic tuning (MED).** "Drain with no in-flight automation OR rate-over-threshold" is a
   first-cut heuristic; the in-flight-automation signal must be cleanly readable at the detector site
   (it should be — the dispatch pipeline runs in the hub). Tune thresholds after live observation.
3. **Dollar figures display-only (LOW).** The $20/$100/$200 amounts are reported, not authoritative;
   the UI reads the real numbers from the endpoint and the figures are never hard-coded into logic.

## Verdict

**PASS — ready to execute, gated on the manual programmatic-credit endpoint capture (18-PLAN-001 Task 1)
which can only complete on a live post-claim account after June 15.** Coverage complete (R-PTY-17..20,
no orphans), threat models present with the OAuth-token-leak + surprise-hard-stop + automation-on-PTY
risks each negatively tested, WS/schema changes additive (old-client compat tested), and the
monitoring-not-rip-gate boundary honored. Re-run independent gsd-plan-checker / gsd-nyquist-validator
subagents before execution if available (this verdict was authored manually — no Task nesting in the
planning-agent context).

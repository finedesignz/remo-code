---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 04
subsystem: automation-routing-guard
requirements: [R-PTY-19]
provides: [automation-routing regression guard, dual-bucket routing docs]
key-files:
  created: [hub/test/automation-routing-guard.test.ts]
  modified: [docs/usage-cost.md]
commit: 641c91c
---

# Phase 18 Plan 04: Automation-routing guard Summary

Asserts + documents (does NOT re-route) the structural invariant: every
unattended automation source rides the stream-json/programmatic path behind the
single non-bypassable cost cap, and can never ride the interactive PTY.

## What shipped
- `automation-routing-guard.test.ts` (data-driven over scheduler /
  orchestrator-background / auto-dev / error-capture):
  - each is a recognised `AUTOMATION_ACTORS` member,
  - each is REJECTED by `humanOnlyRejectsActor` on a `pty-interactive` session,
  - each is ALLOWED on stream-json (still cost/halt-capped at the single gate),
  - only `human` may drive a pty-interactive session,
  - no supervisor runner spawn path SETS `ANTHROPIC_API_KEY` (all delete it).
- `docs/usage-cost.md` Phase-18 section: the two buckets, human PTY ⇒ interactive
  pool / automation ⇒ programmatic pool behind `dailyCostCapGate`, leak alert +
  opt-in hard-halt, the NO-API-KEY invariant, and the Phase-18 test list.

## Notes
- No REST endpoint changed by this plan, so `docs:sync` is a no-op (verified: regen produced only CRLF churn, zero semantic diff — reverted).

## Tests (hub — in check-baseline)
- `automation-routing-guard.test.ts`: 15 pass / 0 fail.

## VALIDATION bindings
- Each automation source passes the single gate + is PTY-excluded (T-18-06/T-18-07): satisfied.
- No ANTHROPIC_API_KEY on any automation path: grep-asserted over the runner spawn files.

## Self-Check: PASSED
Files exist; commit 641c91c in log.

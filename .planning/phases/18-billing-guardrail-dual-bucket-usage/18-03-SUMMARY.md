---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 03
subsystem: hub-leak-guardrail
requirements: [R-PTY-18]
provides: [detectProgrammaticLeak, isOverProgrammaticHalt, getProgrammaticHaltStatus, programmatic_leak_alert WS, users.programmatic_halt_usd]
key-files:
  created:
    - hub/src/usage/programmatic-leak.ts
    - hub/test/programmatic-leak-alert.test.ts
    - hub/test/programmatic-hard-halt.test.ts
  modified:
    - hub/src/dispatch/gates.ts
    - hub/src/ws/protocol.ts
    - hub/src/db/schema.sql
commit: c32d98e
---

# Phase 18 Plan 03: Leak alert + opt-in hard-halt Summary

No silent drain, no surprise hard-stop. A leak detector + WS alert make
programmatic-credit drain visible; an opt-in hard-halt rides the EXISTING
`dailyCostCapGate` chokepoint as an additional predicate (no parallel gate).

## What shipped
- `detectProgrammaticLeak(prev, next, automationInFlight, threshold)` (pure):
  fires `drain_without_automation` when used_usd rises with no automation in
  flight, or `drain_rate_exceeded` when delta exceeds the configured rate; never
  on a flat/reset or absent bucket. No false positive during legit automation.
- `programmatic_leak_alert` WS message added to `protocol.ts`.
- `isOverProgrammaticHalt(bound, credit)` — opt-in, default OFF (null/≤0 bound,
  absent/unclaimed credit ⇒ false).
- `getProgrammaticHaltStatus(userId)` reads `users.programmatic_halt_usd` + the
  store snapshot; `dailyCostCapGate` extended with the predicate AFTER the cost
  check — denies with `programmatic_credit_halt:$<used>>=$<bound>`. Single
  chokepoint preserved; human PTY turns never hit it for this reason.
- `users.programmatic_halt_usd NUMERIC(10,4) NULL` — idempotent ALTER, no backfill
  (schema.sql re-runs every boot).

## Tests (hub — in check-baseline)
- `programmatic-leak-alert.test.ts`: 6 pass (drain w/o automation ⇒ alert; with automation ⇒ none; over-rate ⇒ alert; flat/reset/absent ⇒ none).
- `programmatic-hard-halt.test.ts`: 10 pass (predicate default-off, gate integration, typed reason, human PTY not an automation actor on the PTY surface).
- `cost-cap-real-tokens.test.ts` re-run green (cost cap unaffected — halt off when bound null).

## VALIDATION bindings
- Leak alert fires on genuine drain, not legit automation (T-18-04): satisfied.
- Hard-halt opt-in default-off, denies only programmatic dispatch, never the PTY (T-18-05): satisfied.
- Still exactly ONE dispatch chokepoint: `isOverProgrammaticHalt` used only inside `gates.ts`.

## Self-Check: PASSED
Files exist; commit c32d98e in log.

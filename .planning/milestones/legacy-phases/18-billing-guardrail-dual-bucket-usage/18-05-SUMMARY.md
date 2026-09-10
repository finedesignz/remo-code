---
phase: 18-billing-guardrail-dual-bucket-usage
plan: 05
subsystem: web-usage-ui
requirements: [R-PTY-20]
provides: [ProgrammaticCreditCard, LeakAlertBanner, hard-halt control, useProgrammaticLeakAlert, PATCH /api/profile programmatic_halt_usd]
key-files:
  modified:
    - web/src/pages/settings/UsageTab.tsx
    - web/src/hooks/useSubscriptionUsage.ts
    - web/src/hooks/useProfile.ts
    - web/src/pages/SettingsPage.tsx
    - hub/src/db/dal.ts
    - hub/src/api/profile.ts
  created: [web/test/usage-dual-bucket.test.tsx]
commit: b5fc4e3
---

# Phase 18 Plan 05: Usage UI dual-bucket Summary

The Usage tab now renders BOTH buckets and the guardrail controls: subscription
windows (existing) + the programmatic credit dollar bucket, a dismissible leak
banner, and an opt-in hard-halt toggle. Empty state when unknown/pre-claim. No
token exposed. Blue accent preserved.

## What shipped
- `ProgrammaticCreditCard`: dollars used/remaining + reset countdown when claimed;
  explicit "not claimed or unavailable" empty state otherwise (no fabricated number).
  Driven from `summary.claude_window.programmatic_credit` (the WS snapshot via
  `/api/usage/summary`).
- `useProgrammaticLeakAlert` hook + `LeakAlertBanner` (dismissible, non-blocking).
- Hard-halt control in the Controls card: OFF-by-default toggle + USD bound input;
  persists via `PATCH /api/profile { programmatic_halt_usd }` (0/null ⇒ OFF). Copy:
  "Halts automation only — your interactive sessions keep running" + "Off by default".
- Hub: `updateProfile` + `getUserById` carry `programmatic_halt_usd`; PATCH handler
  validates (non-negative; 0 ⇒ null/OFF).
- Hooks refactored to expose pure `reduceSubscriptionUsage` / `reduceProgrammaticLeakAlert`
  reducers so the logic is testable without a React mock (avoids Bun mock.module
  cross-file pollution).

## Tests (web — outside check-baseline; `bun test`)
- `usage-dual-bucket.test.tsx`: 9 pass (additive reducer, leak reducer, source guarantees: empty state, no token, blue/no-indigo, hard-halt default-off + automation-only copy).
- `no-indigo.test.ts`: green. Full web suite: 66 pass / 0 fail. `tsc -b`: clean.

## VALIDATION bindings
- Both buckets + empty state render; no token in UI (T-18-08): source-asserted.
- Leak banner + hard-halt toggle (default off): present + copy-asserted.
- Accent blue / no indigo: asserted.

## Self-Check: PASSED
Files exist; commit b5fc4e3 in log.

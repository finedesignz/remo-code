---
phase: 18
slug: billing-guardrail-dual-bucket-usage
status: final
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-31
---

# Phase 18 — Validation Strategy

Monitoring + guardrail phase. The load-bearing risks are (a) leaking the OAuth token by accident while
adding the second bucket, (b) a surprise hard-stop, and (c) automation silently escaping the cost cap
or riding the PTY. Sampling is biased toward those three invariants plus the fail-safe empty state when
the credit endpoint is unknown.

---

## Test Infrastructure

- `bun test` in `supervisor/` and `hub/` (per-file isolation via `bun run check-baseline`; register new
  test files in `tools/regression-baseline.json` if the gate requires it).
- Fixtures committed under `supervisor/test/fixtures/` and/or `hub/test/fixtures/`:
  `oauth-usage-with-credit.json` (post-claim body carrying the programmatic bucket),
  `oauth-usage-no-credit.json` (endpoint absent / pre-claim → explicit empty state).
- No new prod endpoint expected for the snapshot (rides existing `subscription_usage`). If a hard-halt
  config field is persisted, it is idempotent DDL in `schema.sql` (no backfill); `docs:sync` only if a
  REST endpoint changes.

---

## Sampling Rate

- CRITICAL invariants (OAuth token never serialized; no surprise hard-stop / opt-in default-off;
  automation never reaches the PTY): 100% — each has a positive AND a negative assertion (the dangerous
  path produces nothing).
- HIGH invariants (no fabricated credit number when endpoint unknown; automation passes the cost cap;
  WS additivity / old-client compat): one positive + one adversarial test each.
- MED/quality (leak alert fires on genuine drain; no false alert during legit automation; UI renders
  both buckets): one test each.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|--------|
| 18-01-01 | 01 | 1 | R-PTY-17 | T-18-01 | second bucket parsed; OAuth token NEVER in payload | unit | `bun test supervisor/test/oauth-poll-dual-bucket.test.ts` | ⬜ pending |
| 18-01-02 | 01 | 1 | R-PTY-17 | T-18-02 | endpoint absent/pre-claim ⇒ explicit empty state, no fabricated $ | unit (neg) | `bun test supervisor/test/oauth-poll-credit-absent.test.ts` | ⬜ pending |
| 18-02-01 | 02 | 1 | R-PTY-17 | T-18-03 | WS/store carry 2nd bucket additively; old-shape still validates | unit | `bun test hub/test/usage-dual-bucket-additive.test.ts` | ⬜ pending |
| 18-03-01 | 03 | 2 | R-PTY-18 | T-18-04 | leak alert fires on drain w/ no in-flight automation; no false alert otherwise | unit | `bun test hub/test/programmatic-leak-alert.test.ts` | ⬜ pending |
| 18-03-02 | 03 | 2 | R-PTY-18 | T-18-05 | hard-halt default OFF; when ON+bound crossed ⇒ dailyCostCapGate denies programmatic; human PTY unaffected | unit (neg) | `bun test hub/test/programmatic-hard-halt.test.ts` | ⬜ pending |
| 18-04-01 | 04 | 2 | R-PTY-19 | T-18-06/07 | each unattended source passes dailyCostCapGate + is rejected on the PTY surface (human-only guard) | unit (neg) | `bun test hub/test/automation-routing-guard.test.ts` | ⬜ pending |
| 18-05-01 | 05 | 3 | R-PTY-20 | T-18-08 | usage UI renders both buckets + alert + halt toggle; no token exposed; no-indigo green | unit | `bun test web/test/usage-dual-bucket.test.tsx; bun test web/test/no-indigo.test.ts` | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

All test files above are Wave-0 stubs to author first (they fail until the impl lands). Fixtures
(`oauth-usage-with-credit.json`, `oauth-usage-no-credit.json`) are Wave-0 artifacts shared by plans
01–03.

---

## Manual-Only Verifications (the gating items)

1. **Programmatic-credit endpoint capture (R-PTY-17, gating).** On a live post-claim Max account after
   June 15, capture the real endpoint + response body carrying the Agent-SDK credit balance. Until
   captured, the parser is provisional and the UI shows the explicit empty state. `autonomous:false`
   checkpoint — the Phase-18 analogue of the Phase-15 compile spike.
2. **Live leak alert + hard-halt round-trip** — drive a real automation run, confirm the credit drains
   the programmatic bucket (not the interactive one) and the alert reflects it; toggle the hard-halt
   bound and confirm a programmatic dispatch is denied while a human PTY turn still runs.

---

## Notes

- The token-never-leaves-host invariant is tested as a NEGATIVE assertion (the payload has no token
  field) — deliberate, since the whole second-bucket addition touches the same poll that reads the
  credentials file.
- The hard-halt default-off is tested explicitly so a future refactor cannot silently flip it on.
- Automation-never-on-the-PTY is tested as a negative assertion against the Phase-16 human-only guard.

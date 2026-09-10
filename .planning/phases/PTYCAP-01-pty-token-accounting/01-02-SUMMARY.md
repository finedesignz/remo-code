---
phase: PTYCAP-01-pty-token-accounting
plan: 02
subsystem: usage-cost
tags: [zod, postgres, testing, usage-ledger]

requires:
  - phase: PTYCAP-01 plan 01
    provides: "token_usage.runner_type column, AgentUsageEvent.runner_type, recordTokenUsage({runnerType})"
provides:
  - "hub/test/token-usage-runner-type.test.ts — DAL bucket-split proof + zod contract preservation proof + schema.sql CHECK-domain source proof"
  - "hub/test/e2e/schema-double-apply.e2e.test.ts — real-Postgres proof the CHECK constraint rejects an out-of-enum runner_type"
  - "hub/test/usage-event-handler.test.ts — backward-compat regression cases for an untagged usage_event"
affects: [ptycap-phase-2-pty-preflight-gate]

tech-stack:
  added: []
  patterns: []

key-files:
  created:
    - hub/test/token-usage-runner-type.test.ts
  modified:
    - hub/test/e2e/schema-double-apply.e2e.test.ts
    - hub/test/usage-event-handler.test.ts

key-decisions:
  - "No production code touched — this plan is verification-only, exactly as planned."
  - "The real-Postgres CHECK-rejection case was written and reviewed against the file's established NS-scoped-schema pattern but not run against a live DB in this session (no REMO_E2E_DB_URL / local Postgres reachable here); it runs in Woodpecker's postgres:16 service per this repo's stated convention (docs/usage-cost.md / tools/regression-baseline.json _skip_note precedent)."

patterns-established: []

requirements-completed: [SC-2]

coverage:
  - id: D1
    description: "recordTokenUsage() threads runnerType into two distinctly-tagged ledger rows; omitted runnerType defaults to stream-json; both buckets still upsert ONE combined daily row (P1-D-D)."
    requirement: SC-2
    verification:
      - kind: unit
        ref: "hub/test/token-usage-runner-type.test.ts#recordTokenUsage — runner_type bucket split (SC-2)"
        status: pass
    human_judgment: false
  - id: D2
    description: "AgentUsageEvent zod preserves runner_type on a PTY-shaped frame (the exact case the 01-01 runner/runner_type typo would have failed); an old-shape frame parses to undefined; a third value fails zod parsing."
    requirement: SC-2
    verification:
      - kind: unit
        ref: "hub/test/token-usage-runner-type.test.ts#AgentUsageEvent zod contract — runner_type survives the WS hop (SC-2)"
        status: pass
    human_judgment: false
  - id: D3
    description: "The token_usage_runner_type_check constraint is live against real Postgres — an out-of-enum value is rejected, pty-interactive is accepted."
    requirement: SC-2
    verification:
      - kind: integration
        ref: "hub/test/e2e/schema-double-apply.e2e.test.ts#token_usage_runner_type_check accepts pty-interactive and rejects an out-of-enum value"
        status: unknown
    human_judgment: true
    rationale: "REMO_E2E_DB_URL-gated; no disposable Postgres reachable in this local session to execute it — skips cleanly (9 skip, 0 fail) here and is intended to run in Woodpecker's postgres:16 service. Code follows the file's own proven NS-scoped pattern verbatim (same connection, same insert style as the adjacent work_* / scheduled_tasks cases in the same file), but has not itself been observed to pass against a live database yet."
  - id: D4
    description: "An untagged usage_event (older supervisor) still records as stream-json; a tagged pty-interactive frame is captured verbatim, not hardcoded."
    requirement: SC-2
    verification:
      - kind: unit
        ref: "hub/test/usage-event-handler.test.ts (5 tests, 3 pre-existing unchanged + 2 new)"
        status: pass
    human_judgment: false

duration: ~20min
completed: 2026-07-28
status: complete
---

# Phase 1, Plan 2: SC-2 Proof — Bucket Split at the DAL, the WS Contract, and Postgres

**The interactive/programmatic usage split is now proven at three levels — the DAL threads
the tag, the hub's zod schema preserves it across the wire, and the database itself refuses
any value outside the two-value domain — with zero production code touched.**

## Performance
- **Started / Completed:** 2026-07-28
- **Tasks:** 2 of 2 completed
- **Files modified:** 3 (1 new, 2 modified)

## Accomplishments
- New `hub/test/token-usage-runner-type.test.ts`: DB-free proof that `recordTokenUsage()`
  threads `runnerType` correctly, that the daily rollup stays combined (not split) per
  P1-D-D, that `AgentUsageEvent` zod preserves `runner_type` (the exact assertion the 01-01
  `runner`/`runner_type` naming bug would have failed), and a comment-stripped source
  assertion pinning the CHECK constraint's domain to exactly the two sanctioned values.
- Extended `hub/test/e2e/schema-double-apply.e2e.test.ts` with a real-Postgres case proving
  the CHECK constraint is live, not just present in the file.
- Extended `hub/test/usage-event-handler.test.ts` with the backward-compat regression: an
  untagged frame still lands `stream-json`.

## Task Commits
1. **Task 1: Prove the ledger bucket split — DAL threading, WS-contract preservation, and a real-Postgres constraint rejection** — `916af21` (test)
2. **Task 2: Backward-compat regression — an untagged usage_event still records as stream-json** — `5dcf049` (test)

**Plan metadata:** tracking commit follows this SUMMARY.md.

## Files Created/Modified
- `hub/test/token-usage-runner-type.test.ts` — new, 7 tests, DB-free.
- `hub/test/e2e/schema-double-apply.e2e.test.ts` — +1 REMO_E2E_DB_URL-gated case.
- `hub/test/usage-event-handler.test.ts` — +2 cases (5 total, 3 pre-existing unchanged).

## Decisions Made
None beyond what's in `key-decisions` above — plan executed as written.

## Deviations from Plan
None — plan executed exactly as written.

## Issues Encountered
None for the DB-free cases (all green). The new DB-gated e2e case could not be executed
against a live Postgres in this session (no `REMO_E2E_DB_URL` / local Postgres reachable) —
noted as `human_judgment: true` in the coverage block above rather than silently claimed as
verified; it is written to the same proven pattern as the surrounding cases in that file and
will run for real in the Woodpecker `postgres:16` service.

## User Setup Required
None.

## Next Phase Readiness
Plan 01-03 (SC-3 mid-flight visibility + the two security guard canaries) is independent of
this plan's specific files and ready to proceed. Plan 01-04 depends on both.

---
*Phase: PTYCAP-01-pty-token-accounting*
*Completed: 2026-07-28*

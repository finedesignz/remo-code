---
phase: PTYCAP-07-self-heal-routing
plan: 02
subsystem: hub/db + hub/heal
tags: [heal, ledger, postgres, advisory-lock, schema, internal-task]
status: complete
requires: []
provides:
  - heal_events table + indexes (additive DDL)
  - scheduled_tasks.is_internal column (additive, never backfilled)
  - claimHealEvent / claimHealNotification / setHealOutcome / getHealEvent / isHealGenerated
  - countRepoDispatchesLastHour / countTaskClaimsToday / pruneHealEvents / listStaleLaunchingHealEvents / windowBucket
  - isInternalScheduledTask (flag OR __internal_ prefix)
affects: [07-03..07-11]
key-files:
  created:
    - hub/src/db/heal-events-dal.ts
    - hub/src/heal/internal-task.ts
    - hub/test/heal-schema.test.ts
    - hub/test/heal-events-dal.test.ts
    - hub/test/heal-internal-task.test.ts
    - hub/test/e2e/heal-events.e2e.test.ts
  modified:
    - hub/src/db/schema.sql
    - hub/src/db/dal.ts
    - hub/src/db/scheduled-tasks-dal.ts
    - hub/test/e2e/schema-double-apply.e2e.test.ts
decisions:
  - "Claim window/cap/retention are claim ARGUMENTS; the DAL never reads env. An injectable nowMs makes the real-window check testable; created_at is written from that same clock."
  - "Opportunistic prune before the claim transaction swallows+logs its own failure (a reap failure must not block a claim); every claim-path failure still propagates (fail closed)."
  - "isInternalScheduledTask(null/undefined) returns true (fail closed)."
requirements: [SH-05, SH-02]
completed: 2026-10-13
plan_head_before: 60c06112e1ee13870c1ec16f237fb5758a797439
commits: 3
actuals:
  tokens: 9500
  tasks: 3
  commits: 3
---

# Phase PTYCAP-07 Plan 02: Heal event ledger and DAL Summary

Atomic heal claim (tx advisory lock + real elapsed-window check + per-user hourly cap, unique indexes as backstop), single-winner notification ownership, durable run provenance, bounded retention (never < 24h) and a durable internal-task marker, all additive and flag-independent (nothing is wired into a live path yet).

## Task commits

| Task | Commit | Scope |
| ---- | ------ | ----- |
| 1 | 6e93d51 | heal_events DDL + is_internal column; heal-schema.test.ts; double-apply e2e case |
| 2 | db4f90a | heal-events-dal.ts; DB-free unit tests; real-Postgres concurrency e2e |
| 3 | 0eae51e | internal-task.ts; ensureInternal*Task INSERTs set is_internal true; ScheduledTask type |

## Verification

- `bun test hub/test/heal-schema.test.ts hub/test/schema-sql-lint.test.ts`: 18 pass, 0 fail.
- `bun run tools/schema-sql-lint.ts`: OK (5 pre-existing allowed pragmas, no new findings).
- `bun test hub/test/heal-events-dal.test.ts`: 23 pass, 0 fail.
- `bun test hub/test/heal-internal-task.test.ts`: 8 pass, 0 fail.
- `bun test hub/test/triage-routing.test.ts`: 4 pass; `coolify-webhook.test.ts`: 29 pass; `deploy-storm-dedupe.test.ts`: 8 pass; `triage-log-snippet.test.ts`: 6 pass.
- `bun test hub/test/heal-flag-off.test.ts`: 89 pass, 0 fail (re-run at end).
- No file changed under hub/src/dispatch, scheduler, api, orchestrator. claimDeployFailure and coolify_deploy_idempotency untouched.

## Deviations from Plan

None to code scope. One verification gap, not a code deviation:

**Real-Postgres e2e not executed locally.** `hub/test/e2e/heal-events.e2e.test.ts` (8-way concurrent claim, bucket-straddle, 8-way notification claim, trigger_run_id uniqueness, user cap, 23h/49h prune, two-hop provenance, COALESCE outcome) and the new schema-double-apply case are DB-gated on `REMO_E2E_DB_URL`; this host has no Postgres/docker, so they skip locally (explicit skip). They are written for postgres:16 semantics and must pass in Woodpecker CI (`bun run orchestrator:e2e`). The concurrency guarantees are therefore proven in the DB-free tests only at the structural level (lock-before-insert source pin, fake-executor branch coverage) until CI runs.

## Known Stubs

None. (Nothing here is wired to a live path; consumers arrive in later plans.)

## Threat Flags

None beyond the plan's threat model (T-07-04..08 mitigations implemented as specified).

## Self-Check: PASSED

- hub/src/db/heal-events-dal.ts, hub/src/heal/internal-task.ts, the four test files: present.
- Commits 6e93d51, db4f90a, 0eae51e: present on phase-ptycap-07-self-heal-routing.

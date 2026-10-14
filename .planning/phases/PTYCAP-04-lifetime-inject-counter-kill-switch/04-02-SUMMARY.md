---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 02
subsystem: hub-dispatch
tags: [kill-switch, lifetime-counter, advisory-lock, reservation, tracer, postgres, schema]

requires:
  - phase: PTYCAP-04-01
    provides: corrected PTY usage accounting (G-1)
  - phase: PTYCAP-03-governed-automation-guard
    provides: governor slots, gate-list conventions
provides:
  - automation_inject_ledger / automation_kill_switch / token_cap_alarms tables + routine_run_log.inject_token (additive, idempotent)
  - hub/src/dispatch/automation-controls.ts (neutral module; shared contract for plans 03-08)
  - dispatch(): preSendGuard before store.open, separate finalHaltCheck immediately before deps.send, release of reservation + slot on every refusal/failure
  - DispatchRequest.counterKey (server-set) and the orchestrator ONLINE inject path keyed by task:<id> (resolver, fail closed)
  - real-Postgres proof helper wired into an existing e2e body (zero new tests, zero new skips)
affects: [PTYCAP-04-03..08, PTYCAP-05 (PTY door consumes reserveInject), PTYCAP-09]

plan_head_before: 289b3771ef099a6a5583725be3f8aeb5b429c91c
actuals:
  tokens: 28700
  tasks: 4
  commits: 5

tech-stack:
  added: []
  patterns:
    - "One atomic reservation: per-counter-key advisory lock, then a fixed-order per-session lock, lifetime check first, rate check over the de-duplicated set union, update-or-insert"
    - "Append-only compensation: released_at / reset marker / page rows; nothing is ever deleted"
    - "Real-SQL proof helper (not a test file) called from an existing DB-gated e2e test body"

key-files:
  created:
    - hub/src/dispatch/automation-controls.ts
    - hub/test/automation-schema.test.ts
    - hub/test/automation-controls-core.test.ts
    - hub/test/automation-controls-config.test.ts
    - hub/test/dispatch-final-halt.test.ts
    - hub/test/automation-tracer.test.ts
    - hub/test/fixtures/automation-fake-sql.ts
    - hub/test/e2e/automation-controls-checks.ts
  modified:
    - hub/src/db/schema.sql
    - hub/src/dispatch/pipeline.ts
    - hub/src/orchestrator/inject.ts
    - hub/test/e2e/orchestrator-tokencap.e2e.test.ts
    - hub/test/orchestrator-autospawn-inject.test.ts
    - hub/test/orchestrator-command-prompts.test.ts

key-decisions:
  - "Exhaustion page is also claimed from the lifetime GATE: the gate is where a spent budget is first seen (the in-lock reserve only refuses on a race), so a reserve-only page would never fire"
  - "A second advisory lock per session (taken only when the rate check runs, always AFTER the counter-key lock) so two counter keys on one session cannot both pass the rate ceiling"
  - "releaseKillSwitch matches each scope's own key only (a session-scope row also records user_id for audit)"
  - "Counter-key resolver failure on the online inject path returns failed (fail closed), never an unkeyed dispatch"

requirements-completed: [SC-1, SC-2]

coverage:
  - id: D1
    description: "Schema: three additive tables + routine_run_log.inject_token, no FKs, partial unique indexes, lint-clean"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "hub/test/automation-schema.test.ts"
        status: pass
      - kind: other
        ref: "bun run schema-lint"
        status: pass
    human_judgment: false
  - id: D2
    description: "Controls module: fresh-read kill switch (fail closed), non-consuming gates, token-idempotent atomic reservation, rate union, pages once per epoch, reset, boot asserts"
    requirement: "SC-1, SC-2"
    verification:
      - kind: unit
        ref: "hub/test/automation-controls-core.test.ts, hub/test/automation-controls-config.test.ts"
        status: pass
    human_judgment: false
  - id: D3
    description: "dispatch(): guard before open, final halt immediately before send, release of reservation + slot"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/dispatch-final-halt.test.ts"
        status: pass
      - kind: unit
        ref: "hub/test/dispatch-pipeline.test.ts (untouched)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Tracer: orchestrator online inject counted before send, exhausts, halts, final-halts, releases, frees the slot"
    requirement: "SC-1, SC-2"
    verification:
      - kind: unit
        ref: "hub/test/automation-tracer.test.ts"
        status: pass
    human_judgment: false
  - id: D5
    description: "The SQL itself against real Postgres (concurrency, partial unique indexes, ON CONFLICT claims, casts, rate-union dedupe)"
    requirement: "SC-1, SC-2"
    verification:
      - kind: e2e
        ref: "hub/test/e2e/automation-controls-checks.ts via orchestrator-tokencap.e2e.test.ts UNDER-cap test (Woodpecker only)"
        status: pending-ci
    human_judgment: false

duration: 90min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 02: Tracer - lifetime counter + kill switch through schema, controls, pipeline, inject

**One orchestrator inject is now counted by an atomic, token-idempotent reservation (lifetime + rate over the de-duplicated union) before the send, refused at the cap, halted by a kill-switch row (re-checked immediately before the send), released on failure, and never strands the in-flight slot.**

## Accomplishments

- Schema: `automation_inject_ledger` (append-only, no FKs, unique `(counter_key, token)`), `automation_kill_switch` (three partial unique indexes), `token_cap_alarms` (for 04-05), `routine_run_log.inject_token`. `bun run schema-lint` clean.
- `automation-controls.ts` imports only `db/postgres.ts`, type-only `pipeline.ts`, and late dynamic imports (`notify.ts`); never `gates.ts` / `governed-pty.ts`. Drift tests pin the duplicated rate-cap parser, the inject-outcome list and the gate names.
- `dispatch()` runs `preSendGuard` after the online/park decision and before `store.open` (so parked/queued/dropped requests never count), and a SEPARATE `finalHaltCheck` after `markDispatched`, immediately before `deps.send`. Refusals and send throws release the reservation (stamp `released_at`) and free the queue slot. Requests with neither the kill-switch gate nor a `counterKey` never import the controls module (`dispatch-pipeline.test.ts` untouched and green).
- Orchestrator online inject path: kill-switch gate FIRST, lifetime-counter gate LAST, `counterKey = task:<id>` via `resolveOrchestratorCounterKey` (fail closed on resolver error). The autospawn path is 04-03.
- 80 percent warning and exhaustion pages: one per (counter key, kind, reset epoch) through ledger page rows; all counts filter to reserve rows only.

## CI-only Postgres checks (how they are wired)

`hub/test/e2e/automation-controls-checks.ts` exports `runAutomationControlsChecks` (no `test()` call, not collected by `bun test`). It is called at the end of the body of the existing UNDER-cap control test in `hub/test/e2e/orchestrator-tokencap.e2e.test.ts` (third `test` arg timeout raised to 120 s; the `maybe = describe.skip` gate idiom is unchanged). Woodpecker qc (postgres:16, `REMO_E2E_DB_URL`) therefore executes it; locally the whole describe stays skipped. Test-call count in that file is unchanged (3 before and after); skip baseline stays 259. It covers: tables exist; 20 concurrent reserves -> exactly 5 ok; token idempotency; release/re-reserve; 5 concurrent rate-checked reserves over distinct counter keys -> exactly 2 ok; rate-union dedupe (ledger + run-log = one, NULL-token queued = one, non-inject outcome = zero); reset keeps history; page claims once per epoch under concurrency; kill-switch partial unique index (two concurrent global engages -> one row), scopes, release, history; `token_cap_alarms` ON CONFLICT claim; text/uuid casts against `users.id::text` and `sessions`; resolver against a real orchestrator `scheduled_tasks` row; real inject path with cap 1. It cleans only rows it created (unique prefix) and restores env. It could NOT be run locally (no Postgres/Docker); the orchestrator opens the draft PR after this plan so Woodpecker proves it.

## Verification

| Gate | Result |
|---|---|
| `automation-schema.test.ts` | 7 pass |
| `automation-controls-core.test.ts` | 31 pass |
| `automation-controls-config.test.ts` | 13 pass |
| `dispatch-final-halt.test.ts` | 8 pass |
| `automation-tracer.test.ts` | 11 pass |
| `dispatch-pipeline.test.ts` (untouched) | 37 pass |
| `orchestrator-tokencap.e2e.test.ts` | all skipped locally, same test count |
| `bun run schema-lint` | OK |
| `bun run check-baseline` | pass=2449 skip=259 fail=0 (baseline pass=2379 skip=259) |
| `tsc --noEmit` (hub) | 427 errors, equal to the pre-edit baseline |
| `bun run docs:sync` | not run (no routes / OpenAPI touched) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Exhaustion page never fired from the normal path**
- **Found during:** Task 4 (tracer asserted one exhaustion page at the first refused inject)
- **Issue:** the non-consuming lifetime gate refuses first; the in-lock reserve only refuses on a race, so a reserve-only exhaustion page would almost never be sent (T-04-08).
- **Fix:** `lifetimeCounterCheck` also claims the once-per-epoch exhaustion page (best-effort, never changes the gate result); test added.
- **Commit:** 6876a9e

**2. [Rule 1 - Bug] Kill-switch release missed session-scope rows**
- **Found during:** writing the real-Postgres helper (engage records `user_id` on a session row; release matched `user_id IS NOT DISTINCT FROM NULL`)
- **Fix:** release is one statement per scope matching that scope's own key; fake + core test updated.
- **Commit:** 6876a9e

**3. [Rule 2 - Missing critical] Session-level rate lock**
- **Issue:** the plan locks per counter key only; two counter keys on one session could both pass the rate check (the plan's own e2e case uses distinct keys per session).
- **Fix:** a second `pg_advisory_xact_lock` on the session, taken only when the rate check runs and always after the counter-key lock (fixed order, no deadlock).

**4. [Rule 3 - Blocking] Existing unit tests had no DB for the new online-path resolver**
- `orchestrator-autospawn-inject.test.ts` and `orchestrator-command-prompts.test.ts` (3 spots) build `InjectDeps` without `resolveCounterKey`; the default resolver needs a DB, so they returned `failed:counter_key_unresolved`. Added `resolveCounterKey: async () => 'task:T1'` to those deps (test-only, behavior assertions unchanged).
- **Commits:** 596a36b, 6876a9e

**5. [Scope addition] Shared fake-sql fixture**
- `hub/test/fixtures/automation-fake-sql.ts` (not a test file, no `mock.module`) is shared by the core, config and tracer tests instead of three copies; not listed in `files_modified`.

**Atomic-commit note:** commit 7df43fe (controls module + core test) type-references `DispatchRequest.counterKey`, which lands in the next commit (596a36b, pipeline wiring); tests pass at every commit but `tsc` was only checked at HEAD.

## Issues Encountered

None blocking. Pre-existing `inject.ts(129,18) TS2352` is part of the 427 tsc baseline.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (T-04-04 through T-04-10b mitigated as listed; T-04-06 boot-assert wiring is 04-05; T-04-09 static pin on `counterKey` assignment is 04-03).

## Next Phase Readiness

Plans 04-03..08 can import the shared contract names from `automation-controls.ts` unchanged. Open item for the orchestrator: push the branch and open the DRAFT PR (base = Phase 3 branch) so Woodpecker proves `automation-controls-checks.ts`; read the result once at phase end.

## Self-Check: PASSED

All created files exist and commits 3fe2fbe, 7df43fe, 596a36b, 6876a9e, 040bc2f are present.

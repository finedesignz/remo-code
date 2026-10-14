---
phase: PTYCAP-07-self-heal-routing
plan: 10
subsystem: hub/heal tests
tags: [self-heal, guards, e2e, flag-off, single-seam]
requires: [07-08, 07-09]
provides: [heal-single-seam-guard, heal-gate-order-assertion, heal-flag-matrix, heal-incident-replay-e2e]
affects: [07-11]
key-files:
  created:
    - hub/test/heal-single-seam.test.ts
    - hub/test/e2e/heal-incident-replay.e2e.test.ts
  modified:
    - hub/test/token-cap-coverage.test.ts
    - hub/test/counter-key-assignment-guard.test.ts
    - hub/test/session-start-senders-guard.test.ts
    - hub/test/launch-callers-guard.test.ts
    - hub/test/heal-flag-off.test.ts
status: complete
commits: 3
plan_head_before: fe7379f1bf80edfb56bc57af12191ce14991bd46
actuals:
  tokens: 36000
  tasks: 3
  commits: 3
---

# Phase PTYCAP-07 Plan 10: Seam guards, flag matrix and incident replay Summary

CI now fails if any failure source builds its own dispatch, capacity routing, supervisor frame or launch for a heal; routeHeal is proven never invoked for any non-ON flag value; and the incident is replayed (V1, V2, 8-way concurrency, autospawn ledger) against real Postgres in the Woodpecker postgres:16 step.

## Commits
- fef86ae Task 1: `heal-single-seam.test.ts` plus additive extensions to the cap, key, session-start and launch-caller guards
- eea906e Task 2: final flag matrix appended to `heal-flag-off.test.ts`
- ce9d550 Task 3: `e2e/heal-incident-replay.e2e.test.ts`

## What was built
- `heal-single-seam.test.ts` (26 tests): (A) pin table of forbidden-token counts per legacy file (capacity picker, supervisor-frame sender, launch call, online lister, `dispatch(`, session-start literal), comment-stripped; unlisted files in the four source areas must hold zero; legacy bodies sit between `heal-legacy-path` marker pairs. (B) inside `hub/src/heal`: no picker/frame/lister/launch call/orchestrator-enabled predicate/session-start/ensure-online/interval timer; one gates literal (route.ts); every dispatch call is `deps.dispatch` in route.ts; lifetime key assigned in route.ts only and always from `buildHealKey`; `REMO_HEAL` env only in config.ts and flag.ts; route.ts launches only via `governedLaunch`. (C) each source reads the flag before it reaches routeHeal; no `as any` in sources. SH-06: the legacy triage `PendingTriage` map, `onTriageAssistantMessage`, `REMO_TRIAGE_TIMEOUT_MS` cannot return. Every scanner is proven against violating fixture strings and self-checked against known legacy tokens.
- `token-cap-coverage`: `heal/route.ts` added to the known dispatchers; new test asserts the heal list is the only one under `hub/src/heal` and holds the six gates in the locked order.
- counter-key / session-start / launch-callers guards: new additive describe blocks (heal key only in route.ts from the shared builder; no session-start literal in heal or governed-launch; no launch call in heal, route imports governedLaunch, governed-launch classified MACHINE).
- `heal-flag-off.test.ts`: 11 OFF values and 10 ON values (incl. mixed case and padded) across Coolify, error-capture, feedback and the real `finalizeRun` failed-run path (real dispatcher loaded under a query so the file-level dispatcher mock does not apply; the scheduled-task source is spied). OFF: zero routeHeal and zero scheduled-source calls, legacy traces unchanged. ON: exactly one routeHeal per entry point. Flag read at call time.
- `heal-incident-replay.e2e.test.ts`: fixtures for runs 8a6e0534/fa377e27, task 0e16bf38, apps xxhodf65/zl7c3u88 (deterministic padding documented in the header). Real claims, ledger, gates, reservation, run finalization and the real reaper loader; only notifier send, launch, supervisor-online, the autospawn park dispatch and the ws channel are injected.

## Verification (one test file per process)
- heal-single-seam 26 pass; token-cap-coverage 5; counter-key-assignment-guard 6; session-start-senders-guard 11; launch-callers-guard 9; heal-flag-off 133 (89 baseline + 44 new); heal-incident-replay.e2e 10 skip (no `REMO_E2E_DB_URL`, expected).
- `git diff fe7379f..HEAD -- hub/src` is empty; removed-line count in all five extended test files is 0 (additive only).
- tsc over `hub`: no diagnostics in any touched test file.
- CI wiring: `package.json` `orchestrator:e2e` = `bun test hub/test/e2e/*.e2e.test.ts`, run by `.woodpecker/qc.yaml` against postgres:16; the new file matches the glob. No local Postgres or PGlite exists in this environment, so the e2e logic was reviewed against schema.sql, the DAL and the sinks but NOT executed; the first real run is the Woodpecker QC step.

## Deviations from Plan
1. **[Scope] `as HealEvent` casts in the source builders.** SH-02 asks for no casts; `sources/{coolify,error-capture,feedback}.ts` each end their literal with `as HealEvent`. Removing them is a `hub/src` edit (forbidden here), so the guard asserts no `as any` in sources and no `HealEvent` cast at the call sites, not zero `as HealEvent` in the builders. Flagged for 07-11 / a follow-up.
2. **[Design] Pin counts derive from comment-stripped whole-word counts**, not raw `git grep -c` (raw counts include prose in comments). Counts are identical at the pre-phase tree b25f07c2 and PLAN_BASE fe7379f for every file in the four source areas; derivation recorded in the test header.
3. **[Design] Autospawn e2e cases stub the park `dispatch`** (return `parked_offline`) instead of the real pipeline, to avoid the process-global grace buffer timers; reservation, ledger row, launch and gates remain real.
4. **[Note] 07-08 residual (refused/failed heal outcomes may also send the default scheduled-task failure email) NOT fixed here.** SC2's "exactly one notification" covers the three routing branches; the no_routable_session branch is already single (`notified: true` suppresses the default email). A `refused`/`failed` outcome on the scheduled-task source with a ledger row sends the heal owner notice and still lets the default failure email go, which is two messages on two channels (never zero). Closing it needs `notified` surfaced on every `HealOutcome` (`types.ts`, `route.ts`), which this plan prohibits (hub/test only). Recommend 07-11 or a follow-up own the change with a test.

## Known Stubs
None.

## Threat Flags
None. T-07-38/39/40 mitigated as planned (pinned counts + self-checks + violating-fixture proofs; harness prod-DSN refusal and `REMO_E2E_DB_URL`-only connection).

## Self-Check: PASSED
All created files exist; commits fef86ae, eea906e, ce9d550 present on the branch.

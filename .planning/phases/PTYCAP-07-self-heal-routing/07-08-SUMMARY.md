---
phase: PTYCAP-07-self-heal-routing
plan: 08
subsystem: hub/heal
tags: [self-heal, coolify, scheduled-task, finalize-hook, notification-owner]
requires: [07-06, 07-07]
provides: [buildCoolifyHealEvent, healFailedScheduledRun, dispatchTriage-flag-switch, suppressDefaultFailureEmail]
affects: [07-09, 07-10]
key-files:
  created:
    - hub/src/heal/sources/coolify.ts
    - hub/src/heal/sources/scheduled-task.ts
    - hub/test/heal-source-coolify.test.ts
    - hub/test/heal-source-scheduled-task.test.ts
  modified:
    - hub/src/api/coolify-webhook.ts
    - hub/src/scheduler/dispatcher.ts
    - hub/src/scheduler/post-run/dispatcher.ts
status: complete
commits: 2
plan_head_before: 60e78e089cb050ebbfd98b6328bca61670123a52
actuals:
  tokens: 45000
  tasks: 2
  commits: 2
---

# Phase PTYCAP-07 Plan 08: Coolify and scheduled-task heal sources Summary

Coolify deploy failures and failed scheduled-task runs now feed `routeHeal` behind `REMO_HEAL_UNIFIED`; the Coolify incident replays V1 and V2 pass at the source level and the flag-OFF traces are unchanged.

## Commits
- 131ddf5 Task 1: Coolify source builder, `dispatchTriage` flag switch, V1/V2 replays
- 185705d Task 2: scheduled-task source, `finalizeRun` hook, single notification owner

## What was built
- `sources/coolify.ts`: `buildCoolifyHealEvent` - canonical repo ident from `git_repository`, else the app-uuid resolver, else null; time-free dedupe key `coolify:<app>:<hash(repo,sha)>`; prompt from `renderTriagePrompt` (log snippet fenced); legacy `[triage: __internal_triage]` stored framing; metadata and trigger run ids both the deployment run; no `bound_session_id`.
- `coolify-webhook.ts`: legacy body moved verbatim to `dispatchTriageLegacy` between `heal-legacy-path:begin/end` markers; new `dispatchTriage` checks the flag (static import of `heal/config.ts` only) and either calls the legacy function or `dispatchTriageViaHeal` (lazy imports of the builder and `routeHeal`; no catch, no fallback). Optional 4th `healOpts` arg forwards test deps; production passes none.
- `sources/scheduled-task.ts`: `healFailedScheduledRun` - event only for status failed, not only_if_active, not `run_timeout`, non-internal (flag OR name), provenance false (throw => no event), task session resolves to a non-rootless canonical repo, per-task daily count below the ceiling. Returns true only when the routeHeal outcome has `notified: true`.
- `scheduler/dispatcher.ts` `finalizeRun`: for `failed` runs only, a hook between the task load and `onRunFinalized`; lazy-imports config and the source, returns false on any error (logged). `suppressDefaultFailureEmail` is added to the post-run payload only when true (conditional spread, so flag-OFF arguments are identical).
- `post-run/dispatcher.ts`: `afterRun` args carry the optional field; `buildDefaultEmailActions` takes an optional 5th `opts` and returns `[]` for a failed outcome when set; byte-for-byte unchanged otherwise.

## Verification (one test file per process)
- heal-source-coolify 15 pass; heal-source-scheduled-task 33 pass
- heal-flag-off 89 pass (unmodified); token-cap-coverage 3; counter-key-assignment-guard 3; coolify-webhook 29; triage-routing 4
- coolify-webhook-triage-e2e 1 skip, coolify-webhook-secret 1 pass / 7 skip (no local Postgres, expected)
- scheduler 49; scheduler-run-reaper 7; stale-run-reaper 6; triage-finding-forward 19; once-tasks 5; scheduler-dispatch 11; send-fence-scheduled-run 2
- `tsc --noEmit`: no errors in touched files. `git grep claimDeployFailure -- hub/src/heal` empty; no diff in `hub/src/{error-capture,feedback,dispatch,db}`; `git diff` removed-line count for `scheduler/dispatcher.ts` is 0.

## Deviations from Plan
1. **[Order] RED-first not separately committed.** The source module existed before the test file ran, so no standalone red run was recorded; both test files were written against the behavior list and pass on first (Task 1) / second (Task 2, one test-data fix: an all-`a` string normalizes as a hex run) run.
2. **[Design] Flag reader loaded lazily in `finalizeRun`.** A static `heal/config.ts` import would pull the orchestrator controller graph (via `isAutospawnEnabled`) into every importer of the scheduler dispatcher and risks link-time failures under existing partial module mocks. The dynamic import runs only for `failed` runs and any import error resolves to "hook off".
3. **[Design] V1 reaper check uses the real `reapStaleRuns`** with an injected pending-run loader over the fake run store (zero candidates, zero finalize calls) instead of a SQL check.

## Residual / notes
- `HealOutcome.notified` exists only on `no_routable_session`. A `refused` or `failed` heal outcome also sends one owner notice (07-06) but does not expose `notified`, so the default failure email still goes out for those (possible duplicate notice, never zero). Surfacing `notified` on all outcomes would change `types.ts`/`route.ts` outside this plan; flagged for 07-10/11.
- The Coolify V2 autospawn case parks the metadata run under the autospawn deadline timer, as designed in 07-06; it is not terminal at return.

## Known Stubs
None.

## Threat Flags
None. T-07-29..33 mitigated as planned.

## Self-Check: PASSED
All created files exist; commits 131ddf5 and 185705d present on the branch.

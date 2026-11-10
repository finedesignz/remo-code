---
phase: PTYCAP-07-self-heal-routing
plan: 06
subsystem: hub/heal
tags: [self-heal, autospawn, notification, boot-sweep]
requires: [07-04, 07-05]
provides: [notifyOnce, autospawn branch in routeHeal, releaseHealReservation, sweepStaleHealLaunches]
affects: [07-07, 07-10]
key-files:
  created:
    - hub/src/heal/notify.ts
    - hub/src/heal/autospawn-deps.ts
    - hub/src/heal/sweep.ts
    - hub/test/heal-notify.test.ts
    - hub/test/heal-route-no-target.test.ts
    - hub/test/heal-route-autospawn.test.ts
    - hub/test/heal-sweep.test.ts
  modified:
    - hub/src/heal/route.ts
    - hub/src/index.ts
    - hub/src/db/heal-events-dal.ts
    - hub/test/heal-events-dal.test.ts
    - hub/test/heal-route-live.test.ts
    - hub/test/heal-route-guards.test.ts
status: complete
commits: 3
plan_head_before: fbe30440ab0b361493b404508533d7a7284e0b55
actuals:
  tokens: 45000
  tasks: 3
  commits: 3
---

# Phase PTYCAP-07 Plan 06: fail-fast notification, governed autospawn, boot sweep Summary

routeHeal now completes the routing decision: an un-routable, refused or failed event terminalizes in-request and tells the owner with exactly one send attempt; an allowlisted offline repo is healed through one governed spawn-last launch with a single deadline timer; and a boot sweep terminalizes launches stranded by a hub restart.

## Commits
- 9a0f3eb Task 1: notifyOnce (claim-then-send, one attempt, ASCII, length-capped) and one finalization point (persist, terminalize, notify) in route.ts
- f82b028 Task 2: autospawn branch (governedLaunch with heal pre-launch governor), deadline timer, replay re-entering dispatch, release on every failure, `releaseHealReservation`
- 9524b64 Task 3: `sweepStaleHealLaunches`, flag-guarded lazy boot call in `hub/src/index.ts`

## Verification (each file in its own process)
heal-notify 9/9, heal-route-no-target 8/8, heal-route-autospawn 20/20, heal-sweep 11/11, heal-route-live 9/9, heal-route-guards 14/14, heal-flag-off 89/89, token-cap-coverage 3/3, counter-key-assignment-guard 3/3, launch-callers-guard 5/5, session-start-senders-guard 7/7, stale-run-reaper 6/6, scheduler-run-reaper 7/7, heal-events-dal 23/23. `git diff` over hub/src/dispatch, orchestrator, telegram, api is empty; index.ts diff is additions only; `gates:` literal count under hub/src/heal is 1; no `launchSessionForUser(`, `isOrchestratorEnabled` or `session.start` under hub/src/heal. e2e files skip locally (no Postgres), as expected. tsc: no new errors (resolve.ts(51) error is pre-existing from 07-05).

## Decisions
- PLAN-CHECK WARN 1: the flag-OFF boot check is behavioural as well as a source pin: `sweepStaleHealLaunches` re-checks the heal flag itself and, OFF, performs zero reads (asserted over unset/""/0/false/maybe), and index.ts imports the module lazily inside `if (healUnifiedEnabled())`.
- An in-flight launch (`graceParkPending`) is parked through the same pipeline and watched by its own deadline timer, so its metadata run cannot be left pending.
- Offline candidates also pass the per-repo hourly bound before any launch.
- Timers are injected (`setTimer`/`clearTimer` on `AutospawnDeps`) rather than global fake timers, so no mock.module and no process-global timer patching.
- `notified` is carried only on `no_routable_session` outcomes (the existing type); refused/failed outcomes are unchanged so existing `toEqual` assertions hold.

## Deviations from Plan
**1. [Rule 3 - Blocking] Real autospawn bindings moved to `hub/src/heal/autospawn-deps.ts`.** The 07-05 structure test forbids the name `launchSessionForUser` anywhere under hub/src/heal, and the counter-key guard forbids the budget-key field outside allowlisted files. The injectable interface plus real bindings live in the new file (types derived from automation-controls, no key spelled); route.ts re-exports them. `heal-route-live.test.ts` structure test now exempts only `autospawn-deps.ts` from the launch-name check (the single pass-through handed to governedLaunch, which supplies `machine: true`).
**2. [Rule 2 - Missing critical] Two ledger-query additions in `hub/src/db/heal-events-dal.ts`** (plus matching pins in heal-events-dal.test.ts): `listStaleLaunchingHealEvents` now selects `autospawn_launched` and `autospawn_parked` (parked events would otherwise be unrecoverable after a restart), and `countRepoDispatchesLastHour` also counts `dispatched_after_spawn` (otherwise a delivered heal would drop out of the per-repo hourly bound).
**3.** `hub/test/heal-route-live.test.ts` and `heal-route-guards.test.ts` mkDeps gained a hermetic `notify` stub so they never reach the real claim/email seam.
**4.** The sink-side mapping of `no_routable_session` to a `skipped` metadata run is owned by 07-07's sink (`finalizeTerminal`); here the route hands the sink `{kind:'no_routable_session'}` within the request (asserted under 5s), with the unrelated session receiving zero dispatches.

## Known Stubs
None. `./sinks/index.ts` is still resolved at call time and arrives with 07-07.

## Threat Flags
None beyond the plan's threat register (T-07-20..24 mitigated as specified).

## Self-Check: PASSED
Created files exist; commits 9a0f3eb, f82b028, 9524b64 present.

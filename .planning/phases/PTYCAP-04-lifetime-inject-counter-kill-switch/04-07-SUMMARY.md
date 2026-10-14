---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 07
subsystem: hub-spawn-paths
tags: [kill-switch, launch-primitives, orphan-resume, self-heal, enumerating-pin]
requires:
  - phase: PTYCAP-04-05
    provides: /api/automation router (release route), controls module
  - phase: PTYCAP-04-06
    provides: kill gate on every dispatch list, scheduler/tick halts
provides:
  - machine-origin option (machine: true) on launchSessionForUser and launchOrchestrator
  - halt check before the auto-launch debounce stamp
  - orchestrator orphan deferral without finalizing (skipped_halted)
  - POST /api/sessions/heal as a MACHINE surface (halt check, heal:<repo> lifetime reservation, release on non-started exits)
  - release-time, event-driven orphan resume sweep for every scope
  - launch-callers-guard and session-start-senders-guard (default-deny enumerating pins)
affects: [PTYCAP-04-08]

plan_head_before: 87a8efb
actuals:
  tokens: 16300
  tasks: 4
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Explicit machine-origin option on shared primitives; predicate consulted only when set"
    - "Per-file/per-route default-deny enumerating pin with a scanner self-check"

key-files:
  created:
    - hub/test/launch-machine-guard.test.ts
    - hub/test/orchestrator-autolaunch-halt.test.ts
    - hub/test/orphan-resume-halt.test.ts
    - hub/test/launch-callers-guard.test.ts
    - hub/test/session-start-senders-guard.test.ts
    - hub/test/sessions-heal-halt.test.ts
  modified:
    - hub/src/telegram/launch.ts
    - hub/src/orchestrator/auto-launch.ts
    - hub/src/orchestrator/orphan-resume.ts
    - hub/src/orchestrator/inject.ts
    - hub/src/scheduler/senders/agent.ts
    - hub/src/ask/dispatch.ts
    - hub/src/work/dispatch.ts
    - hub/src/api/sessions.ts
    - hub/src/api/automation.ts
    - hub/src/api/orchestrator.ts
    - hub/test/automation-api.test.ts
    - hub/test/orchestrator-autospawn-inject.test.ts
    - hub/test/scheduler-dispatch.test.ts
    - hub/test/counter-key-assignment-guard.test.ts
    - hub/test/reserve-caller-guard.test.ts

key-decisions:
  - "The predicate is consulted ONLY when a caller passes machine: true; Telegram /doctor, Telegram commands and the web start routes never pass it, so human launches are never blocked"
  - "POST /api/sessions/heal is MACHINE (panel F-2); api/sessions.ts POST /:id/launch and api/supervisors.ts POST /:id/start are HUMAN, classified after opening each handler"
  - "Release-time sweep lister lives in orphan-resume.ts (listOnlineSupervisorsForRelease), so api/automation.ts stays free of the supervisor registry and the 04-05 D-07 static pin is unchanged"

requirements-completed: [SC-2]

coverage:
  - id: D1
    description: "Launch primitives refuse machine launches during a halt; human launches unaffected; auto-launch halts before the debounce stamp"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "launch-machine-guard (4), orchestrator-autolaunch-halt (6), orchestrator-autolaunch (16, unchanged)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Orchestrator orphans deferred without finalizing; non-orchestrator orphans never deferred; guards run first"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "orphan-resume-halt (7)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Four machine callers pass machine: true; every launch caller and session.start sender is classified (default deny)"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "launch-callers-guard (4), session-start-senders-guard (6), orchestrator-autospawn-inject (14), scheduler-dispatch (11)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Self-heal route halted, counted and pinned"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "sessions-heal-halt (8), counter-key-assignment-guard (3), reserve-caller-guard (6)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Release of any scope resumes deferred work; best-effort; no polling"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "automation-api (21), mount-order (22)"
        status: pass
    human_judgment: false

duration: 70min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 07: Non-dispatch spawn holes closed

**Machine spawns (autospawn, scheduler lazy launch, ask/work ensureOnline, auto-launch, orchestrator orphan resume, the self-heal route) now stop during a halt, human launch paths are untouched, deferred orchestrator runs resume on release without polling, and every `session.start` sender and launch caller is pinned default-deny.**

## Accomplishments

- **Task 1 (f4bd344):** optional `machine?: true` on `launchSessionForUser` and `launchOrchestrator`; the kill-switch predicate is consulted first only when set (reasons `automation_halted:<scope>` / `automation_halted`). `maybeAutoLaunchOrchestrator` halts before stamping the 5s debounce and passes `machine: true`. In orphan-resume, orchestrator orphans are deferred after the user_stopped and restart-cap guards and BEFORE the reboot UPDATE (row untouched, id in new `skipped_halted`), evaluated per orphan with its own user and session id; non-orchestrator orphans are never deferred; the orchestrator relaunch passes `machine: true` as a final re-check.
- **Task 2 (0e684b5):** `machine: true` passed by inject autospawn, scheduler `maybeLaunchOfflineSession` (halted result flows through the existing default `{ skip: reason }` branch, run finalizes skipped), ask and work `ensureOnline` (false, pipeline parks). A refused autospawn surfaces `autospawn_launch_automation_halted:<scope>`, already benign in macro-cycle by the `autospawn_launch_` prefix rule. Two enumerating pins added.
- **Task 3 (95b4fd3):** `/heal` checks the halt before `pickSessionTarget`, makes ONE `reserveInject` (`heal:<repo>`, fresh `heal:<uuid>` token, actor `self-heal`, no rate enforcement) before the hop loop, and `releaseInject` in a `finally` on every exit that did not start a session. Counter-key and reserve-caller pin allowlists updated; the sender pin asserts halt < reserve < pick < send ordering in the handler slice.
- **Task 4 (9640ad1):** a release that actually released a row fires `resumeDeferredWork` (not awaited, all errors swallowed and logged): late-imports orphan-resume, lists the online supervisors for the scope (global: every supervisor with its own owner id; user/session: the releaser's) and calls the supervisor-scoped `resumeOrphansForSupervisor`. Engage and no-op releases trigger nothing.
- **Fix (bbcecbf):** hold the tsc baseline for the widened union.

## Session.start sender classification (verified by opening each site)

| Site | Class | Evidence |
|---|---|---|
| `dispatch/spawn-on-error.ts` | MACHINE | post-gate; gate lists carry the kill gate (04-06) plus pipeline final check |
| `orchestrator/auto-launch.ts` | MACHINE | `machine` option; halt before debounce; pinned |
| `orchestrator/orphan-resume.ts` (generic) | not deferred (human or machine indistinguishable) | orchestrator relaunch deferred and re-checked |
| `telegram/launch.ts` | FLAGGED | machine option; callers pinned by launch-callers-guard |
| `api/sessions.ts` POST `/heal` | MACHINE | external self-heal service; halt + reservation + pin |
| `api/sessions.ts` POST `/:id/launch` | HUMAN | web Connect/Start of the user's own session, cookie-authenticated, user-initiated; comments reference the web "can't connect" report |
| `api/supervisors.ts` POST `/:id/start` | HUMAN | web Start button; per-supervisor authorizeSupervisor |

Launch callers: MACHINE = `orchestrator/inject.ts`, `scheduler/senders/agent.ts`, `ask/dispatch.ts`, `work/dispatch.ts` (all `machine: true`); HUMAN = `telegram/doctor.ts`, `telegram/commands.ts` (no `machine: true`).

## Verification

| Gate | Result |
|---|---|
| launch-machine-guard / orchestrator-autolaunch-halt / orphan-resume-halt | 4 / 6 / 7 pass |
| orchestrator-autolaunch / orphan-resume | 16 pass / 9 skip (DB-gated, pre-existing) |
| launch-callers-guard / session-start-senders-guard | 4 / 6 pass (scanners find 6 callers, 7+ senders) |
| orchestrator-autospawn-inject / scheduler-dispatch / ext-work-containment | 14 / 11 / 18 pass |
| sessions-heal-halt / counter-key-assignment-guard / reserve-caller-guard / sessions-launch | 8 / 3 / 6 / 26 pass |
| automation-api / mount-order | 21 / 22 pass |
| `bun run check-baseline` | run 1: pass=2651 skip=259 fail=1 (failing test name not captured); rerun: pass=2652 skip=259 fail=0 (baseline pass=2379 skip=259) |
| `tsc --noEmit` (hub) | 427 errors, equal to baseline (first pass showed 430; the 3 new were fixed in bbcecbf) |
| `bun run docs:sync` | not run (no route added/removed; OpenAPI source untouched) |
| Skips | 259, zero added |

## Deviations from Plan

**1. [Rule 3 - Blocking] Lister placed in orphan-resume.ts instead of imported into automation.ts**
The 04-05 D-07 pin forbids `supervisor-registry` in `api/automation.ts`. Added `listOnlineSupervisorsForRelease` to orphan-resume.ts (late registry import) so the pin stays unchanged; automation.ts still contains `resumeOrphansForSupervisor` and not `resumeOrphanSessionsForUser`.

**2. [Rule 1 - Bug] Widened result union broke type check**
`api/orchestrator.ts` read `res.error` on the widened `launchOrchestrator` union; added an exhaustive `automation_halted` case (unreachable from the human route). Two test typings fixed. tsc back to 427.

**3. [Info] Existing test updates (additive field only)**
`orchestrator-autospawn-inject.test.ts` and `scheduler-dispatch.test.ts` launch-argument assertions now include `machine: true`; each gained one halted-refusal test.

**4. [Info] Heal control-flow shape**
The `/heal` hop loop is wrapped in `try { ... } finally { release }` without re-indenting the existing loop body (smallest diff). The two new 503 bodies (`automation_halted`, `lifetime_inject_exhausted`) are not yet in the hand-assembled OpenAPI doc.

**5. [Info] `check-baseline` first run failed once**
Run 1 reported fail=1 (output tail only; the name was not captured). The immediate rerun passed fully (fail=0). Unreproduced; no touched file is implicated by evidence.

## Issues Encountered

None blocking. Process note: the plan-head ledger (protocol 0c) was not written; `plan_head_before` is the verified HEAD before Task 1 (`87a8efb`) and `commits: 5` is `git rev-list --count 87a8efb..HEAD`.

## Known Stubs

None.

## Threat Flags

None. T-04-32..37 mitigated as planned (machine option inside primitives, human paths proven not to consult the predicate, debounce ordering, defer-before-UPDATE, enumerating pins, heal classified machine).

## Self-Check: PASSED

All created files exist; commits f4bd344, 0e684b5, 95b4fd3, 9640ad1, bbcecbf present.

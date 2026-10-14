---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 06
subsystem: hub-dispatch
tags: [kill-switch, coverage-test, scheduler, once-task, orchestrator-tick]
requires:
  - phase: PTYCAP-04-03
    provides: kill gate first + lifetime gate last on inject (x2), scheduler agent, triage
  - phase: PTYCAP-04-04
    provides: PTY door governors (kill_switch governor via killSwitchCheck)
provides:
  - kill-switch gate first in the error-capture, feedback, revanote, ask and work gates lists
  - kill-switch-coverage.test.ts: default-deny structural scan of every gates list (human allowlist, PTY door pin, counter exemption map)
  - scheduler fireTask halt (every run path, not keyed on isManual) and pre-claim halt in fire() for one-time tasks
  - rearmOnceTask (inverse of claimOnceTask); post-claim halt and the once-work sender re-arm instead of burning client work
  - orchestrator due-scan skips halted users; cycle runner returns before the cadence stamp
affects: [PTYCAP-04-07, PTYCAP-04-08]

plan_head_before: 538dbbbc4897ce82560a655fe1b42061ea169290
actuals:
  tokens: 21000
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Default-deny gates-list classification test (HUMAN / PTY door / MACHINE) modeled on token-cap-coverage"
    - "Gate-order recording in adapter tests via a controls leaf mock"

key-files:
  created:
    - hub/test/kill-switch-coverage.test.ts
    - hub/test/scheduler-halt.test.ts
    - hub/test/orchestrator-tick-halt.test.ts
    - hub/test/once-rearm.test.ts
  modified:
    - hub/src/error-capture/dispatcher.ts
    - hub/src/feedback/dispatcher.ts
    - hub/src/revanote/dispatcher.ts
    - hub/src/ask/dispatch.ts
    - hub/src/work/dispatch.ts
    - hub/src/scheduler/dispatcher.ts
    - hub/src/scheduler/senders/work.ts
    - hub/src/db/scheduled-tasks-dal.ts
    - hub/src/orchestrator/controller.ts
    - hub/test/error-capture-dispatch.test.ts
    - hub/test/revanote-dispatch.test.ts
    - hub/test/once-tasks.test.ts
    - hub/test/scheduler-bounds-autodisable.test.ts

key-decisions:
  - "Human lists (telegram/dispatch.ts, cloud/send.ts) and the PTY door array stay free of the kill gate; the test asserts absence in both the scanned lists and the source files"
  - "Key-less adapters (error-capture, feedback, revanote, ask, work) are kill-only; each has a reason in the counter exemption map, and a new machine list must be counted or exempt (default deny)"
  - "taskSessionId(task) = target_id for session targets, else payload.work_session_id, else task.session_id; passed to the session-scoped kill-switch rows"
  - "If rearmOnceTask itself fails after a post-claim halt, fall through to a visible skipped run row rather than losing the task silently"
  - "The once-work sender re-arms on an automation_halted: skip AND finalizes that attempt's run as skipped (never as completed work); work_runs stays queued because a gate skip precedes store.open"

requirements-completed: [SC-2]

coverage:
  - id: D1
    description: "Kill gate first in all five remaining machine lists; spend gates untouched and unreordered"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "error-capture-dispatch (1), revanote-dispatch (8), feedback-webhook (13), ext-ask-gates (12), ext-work-gates (6), token-cap-coverage (3)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Structural coverage test: default deny, human allowlist, PTY pin, counter exemptions, scanner self-check"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/kill-switch-coverage.test.ts (10)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Scheduler halts every run path; once tasks not claimed while halted and re-armed after a post-claim halt"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/scheduler-halt.test.ts (11), hub/test/once-rearm.test.ts (6)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Orchestrator tick idles without stamping cadence"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/orchestrator-tick-halt.test.ts (4)"
        status: pass
    human_judgment: false

duration: 45min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 06: Kill-switch coverage of the dispatch surface

**The kill switch is now the first gate of every non-human dispatch list, a default-deny structural test keeps it that way, and the scheduler and orchestrator tick stop work before dispatch without ever burning a one-time client task.**

## Accomplishments

- **Task 1 (f8dc796):** `automationKillSwitchGate` first in the error-capture, feedback and revanote lists (import + one element each; no reorder, no counter, no counterKey). The two adapter tests leaf-mock the controls module and record gate order: the first gate that runs is `automation_kill_switch`, then `threshold`.
- **Task 2 (779420a):** kill gate first in the ask and work lists, before `thresholdGate` and the governed-PTY composition. `kill-switch-coverage.test.ts` (10 tests) scans all 12 `gates: [` lists with the bracket-balanced scanner: parse failures hard-fail, known-file self-check, kill gate first on every MACHINE list, HUMAN lists (telegram, cloud) carry no kill gate, PTY door pin (`activeGovernors()` in preflight, `killSwitchCheck` in governed-pty), counted lists end with the lifetime gate, other machine lists must be in the exemption map with a reason, no stale classification. Written RED first (ask and work failed), then GREEN.
- **Task 3 (1a312ce):** `fireTask` halt check before the threshold block and every task_type branch, not keyed on `isManual`; reproduces the cost-cap skipped branch (run row `automation_halted:<scope>`, broadcast, `onRunFinalized`, fire timestamps unless `skipCronUpdate`) and returns `{ runIds }`. `fire()` checks the halt BEFORE `claimOnceTask` for one-time tasks and passes `onceClaimed` to `fireTask`; a halt after the claim calls the new `rearmOnceTask` and returns `{ runIds: [] }` with no run row. The once-work sender re-arms on an `automation_halted:` skip. `controller.ts`: `user_id` added to the scan select, halted tasks skipped per task (own user + session); the cycle runner returns before `markRowsFired` and `runMacroCycle`.

## Verification

| Gate | Result |
|---|---|
| kill-switch-coverage / ext-ask-gates / ext-work-gates / cloud-send / token-cap-coverage | 10 / 12 / 6 / 7 / 3 pass |
| error-capture-dispatch / revanote-dispatch / feedback-webhook | 1 / 8 / 13 pass |
| scheduler-halt / orchestrator-tick-halt / once-rearm | 11 / 4 / 6 pass |
| once-tasks / dispatcher-disabled-guard / scheduler-bounds-autodisable / scheduler-dispatch / teab-e2e / teab-sender / orchestrator-metrics / orchestrator-controller / orchestrator-tick-reinject | 5 / 3 / 4 / 10 / 2 / 4 / 10 / 11 / 9 pass |
| ext-ask-envelope / reaper, ext-work-containment / enqueue-failure / publish / reply | 0 fail each |
| `bun run check-baseline` | pass=2610 skip=259 fail=0 (baseline pass=2379 skip=259) |
| `tsc --noEmit` (hub) | 427 errors, equal to baseline |
| `bun run docs:sync` | not run (no routes / OpenAPI touched) |
| Skips | 259, zero added |

## Deviations from Plan

**1. [Rule 3 - Blocking] Two scheduler tests broke on the dispatcher's new imports**
`once-tasks.test.ts` and `scheduler-bounds-autodisable.test.ts` mock the scheduled-tasks DAL by name, so the dispatcher's new `rearmOnceTask` import failed to resolve; both also now reach the controls module. Added a `rearmOnceTask` stub and the shared leaf mock (`fixtures/automation-controls-leaf.ts`) to each. No assertion changed. Every other test in the plan's mock-hazard list passed unchanged (dispatcher-disabled-guard, scheduler-dispatch, teab-*, orchestrator-metrics, orchestrator-controller, orchestrator-tick-reinject).

**2. [Info] Adapter test assertion style**
The error-capture and revanote tests mocked `gates.ts` already; they now also leaf-mock the controls module with a recording kill gate (instead of only passing through) so the first-gate assertion is observable. The real controls module also passed unmocked, but the leaf keeps those tests about their own subject.

**3. [Info] No feedback dispatcher test exists**
`feedback-webhook.test.ts` passed unchanged; the feedback list is covered by the structural scan.

**4. [Info] Re-arm failure fallback**
Not in the plan: if `rearmOnceTask` throws or changes no row after a post-claim halt, the halt branch records a visible skipped run instead of returning silently (a silently burned client task is the failure the panel locked against).

## Once-task re-fire after release (verified, residual documented)

`listDueOnceTasks` selects `enabled = true AND run_at <= now`, and the sweep is started at boot (`index.ts`), so a re-armed or never-claimed one-time task fires through the atomic claim after release with no new code and no polling added. While halted the existing sweep still ticks (10s default) and each tick costs one `isAutomationHalted` read per due once task, then returns without claiming. Sweep cadence unchanged (out of scope). Residual: the DB-level SQL of `rearmOnceTask` is proven against an in-memory emulation plus a pinned statement text; the real-Postgres leg runs only in Woodpecker (no local Postgres on this host), and no e2e test was added here (zero new skips rule; the e2e extension point stays 04-02's).

## Issues Encountered

None blocking. A mock of `orchestrator-rows-dal.ts` in the new tick test needed the real module spread (other exports such as the run-log insert are imported transitively).

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (T-04-27..31 mitigated as listed).

## Next Phase Readiness

Plan 04-07 (machine-origin flag on launch primitives, `/api/sessions/heal`) and 04-08 can rely on every dispatch list and the scheduler/orchestrator entry points being haltable. Draft PR #506 still awaits Woodpecker for the real-Postgres leg.

## Self-Check: PASSED

Created files exist (kill-switch-coverage, scheduler-halt, orchestrator-tick-halt, once-rearm tests); commits f8dc796, 779420a, 1a312ce present on the branch; `plan_head_before..HEAD` = 3 code commits.

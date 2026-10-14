---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 03
subsystem: hub-dispatch
tags: [lifetime-counter, kill-switch, orchestrator-inject, scheduler, static-pins, run-log]

requires:
  - phase: PTYCAP-04-02
    provides: automation-controls module, dispatch() reserve + final halt, DispatchRequest.counterKey, orchestrator online-path tracer
provides:
  - orchestrator autospawn inject path counted and haltable (same gate composition as the online path)
  - grace replay re-enters dispatch() (gated, reserved once per token), never the raw send
  - one budget per orchestrator (taskId authoritative, else the resolver, resolved once per inject on whichever path runs)
  - routine_run_log.inject_token written by the orchestrator modules that record a dispatched inject
  - scheduler agent (task:<id>) and triage (triage:<application_uuid>) senders keyed, kill switch first, lifetime counter last
  - macro-cycle treats automation_halted:* and lifetime_inject_exhausted:* refusals as benign (no per-tick failure page)
  - static pins: counterKey assignment allowlist, replay re-entry; pipeline reserve semantics tests
affects: [PTYCAP-04-04..08]

plan_head_before: 1cf2bfd769259513aa0ce7e182abe6795cff8142
actuals:
  tokens: 11250
  tasks: 4
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Leaf-mock factory for automation-controls (hub/test/fixtures/automation-controls-leaf.ts) for tests that mock gates.ts"
    - "Static pins with a self-check that the scanner finds the known sites"

key-files:
  created:
    - hub/test/orchestrator-inject-counterkey.test.ts
    - hub/test/orchestrator-runlog-token.test.ts
    - hub/test/scheduler-counter-keys.test.ts
    - hub/test/dispatch-reserve.test.ts
    - hub/test/counter-key-assignment-guard.test.ts
    - hub/test/replay-reentry-guard.test.ts
    - hub/test/fixtures/automation-controls-leaf.ts
  modified:
    - hub/src/orchestrator/inject.ts
    - hub/src/orchestrator/macro-cycle.ts
    - hub/src/orchestrator/merge-command.ts
    - hub/src/orchestrator/wave-runner.ts
    - hub/src/db/orchestrator-rows-dal.ts
    - hub/src/scheduler/senders/agent.ts
    - hub/src/scheduler/senders/triage.ts
    - hub/test/orchestrator-autospawn-inject.test.ts
    - hub/test/orchestrator-macro-cycle.test.ts
    - hub/test/scheduler-dispatch.test.ts

key-decisions:
  - "A caller-supplied taskId is authoritative: counterKey = task:<taskId> and the resolver is not consulted; the resolver runs only when taskId is absent (merge command, verify tail, wave runner pass a session id only)"
  - "On the autospawn path the key is resolved AFTER the AND-chain and BEFORE the launch, so a resolver failure fails closed without spawning a session; the online path never reaches that code, so the resolver runs exactly once per inject"
  - "The replay thunk re-enters dispatch with the request the pipeline hands it and the same deploy deps (the request carries token + counterKey); a parked request is never reserved, a replayed token reserves once"
  - "Only run-log rows whose outcome is an inject outcome carry inject_token"

requirements-completed: [SC-1]

coverage:
  - id: D1
    description: "Orchestrator autospawn path keyed + gated like the online path; replay re-enters dispatch; one budget per orchestrator"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "hub/test/orchestrator-inject-counterkey.test.ts (10), hub/test/orchestrator-autospawn-inject.test.ts (13)"
        status: pass
    human_judgment: false
  - id: D2
    description: "macro-cycle threads taskId; automation_halted:/lifetime_inject_exhausted: refusals do not page"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "hub/test/orchestrator-macro-cycle.test.ts (23)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Dispatched inject run-log rows record the inject token (rate-union dedupe key), scanner-pinned"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "hub/test/orchestrator-runlog-token.test.ts (14)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Scheduler agent and triage senders carry counter keys and both gates; exhaustion finalizes skipped"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "hub/test/scheduler-counter-keys.test.ts (8), hub/test/scheduler-dispatch.test.ts (10)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Pipeline reserve semantics and the two structural pins (key assignment, replay)"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "hub/test/dispatch-reserve.test.ts (9), counter-key-assignment-guard.test.ts (3), replay-reentry-guard.test.ts (3)"
        status: pass
    human_judgment: false

duration: 75min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 03: Counted dispatch paths - orchestrator + scheduler

**Every counted dispatch path in D-05 (orchestrator inject on both lists, scheduler agent, triage) now carries a server-set counter key, the kill-switch gate first and the lifetime-counter gate last; the grace replay re-enters dispatch(); and key drift / replay bypass are pinned by tests.**

## Accomplishments

- **Task 1 (768e460):** autospawn inject path uses the same gate composition and `counterKey` as the online path; replay thunk calls `deps.dispatch(req, deployDeps)` (errors swallowed and logged as before); a small `resolveInjectCounterKey` helper makes `taskId` authoritative. macro-cycle passes `taskId: input.taskId` and treats `automation_halted:` / `lifetime_inject_exhausted:` refusals as benign next to the existing autospawn prefix rule (cost-cap refusals and failures still page).
- **Task 2 (d9ab019):** `NewRoutineRunLogEntry.inject_token` + the INSERT; macro-cycle, merge-command and wave-runner record the token of a dispatched inject (wave-runner via `ExecuteResult.injectToken` set only on `dispatched`).
- **Task 3 (b5dcf37):** `sendAgentTask` keyed `task:<task.id>`; `sendTriage` keyed `triage:<application_uuid>` (both routing branches converge on one request build). Exhaustion reaches `markSkipped` and finalizes `skipped` through the existing prefix rule (no mapping change).
- **Task 4 (a207a5b):** `dispatch-reserve`, `counter-key-assignment-guard`, `replay-reentry-guard`.

## Verification

| Gate | Result |
|---|---|
| orchestrator-inject-counterkey / autospawn-inject / macro-cycle / command-prompts | 10 / 13 / 23 / 26 pass |
| orchestrator-runlog-token / run-log / merge-command / waves / controller / tick-reinject | 14 / 1 / 13 / 15 / 11 / 9 pass |
| scheduler-counter-keys / scheduler-dispatch / triage-routing / sched-failures / once-tasks / teab-sender / teab-e2e | 8 / 10 / 4 / 5 / 5 / 4 / 2 pass |
| dispatch-reserve / counter-key-assignment-guard / replay-reentry-guard | 9 / 3 / 3 pass |
| `bun run check-baseline` | pass=2502 skip=259 fail=0 (baseline pass=2379 skip=259) |
| `tsc --noEmit` (hub) | 427 errors, equal to the pre-edit baseline |
| `bun run docs:sync` | not run (no routes / OpenAPI touched) |
| schema | untouched in this plan |

## Deviations from Plan

**1. [Rule 3 - Blocking] Existing tests had no DB for the autospawn-path resolver**
`orchestrator-autospawn-inject.test.ts` `makeDeps` gained `resolveCounterKey: async () => 'task:T1'` (same fix 04-02 applied on the online path). No assertion weakened.

**2. [Rule 3 - Blocking] scheduler-dispatch.test.ts mocks `dispatch/gates.ts` and stubs `sql`**
The sender's new import of automation-controls made the real lifetime gate fail closed (`lifetime_counter_error`) in 3 tests. Added a leaf mock via a shared factory `hub/test/fixtures/automation-controls-leaf.ts` (pass-through gates, not-halted, reservation succeeds, constant resolver). Only file that broke; the other candidate test files in `files_modified` (once-tasks, dispatcher-disabled-guard, scheduler-bounds-autodisable, teab-*, orchestrator-metrics, orchestrator-controller, orchestrator-tick-reinject, orchestrator-command-prompts) passed unchanged and were not touched. Repaired test files: `orchestrator-autospawn-inject.test.ts`, `scheduler-dispatch.test.ts`.

**3. [Scope note] Run-log token only where an inject-derived append exists**
`verify-tail.ts` has no run-log append derived from an inject result (its `deploy-verify` rows are `verify_pass` / `verify_failed`, and the fix inject writes no row), and `controller.ts:358` (`writeRunLogFromBlocks`) records agent-reported RUNLOG blocks, not injects; both left unchanged and the static scan asserts that. `merge_dispatched` is not a rate-union outcome, so its token is an audit link only (no double count either way).

**4. [Scope addition] New fixture file** `hub/test/fixtures/automation-controls-leaf.ts` (not a test file, not listed in `files_modified`).

**5. [Info] reason-string contract** (`automation_halted:<scope>`, `lifetime_inject_exhausted:<n>>=<cap>`): dispatch-reserve leaf-mocks the controls module, so it pins the format by scanning the controls source for the template strings; the exact runtime strings are asserted in the existing `automation-controls-core.test.ts`.

## Issues Encountered

None blocking. The `transcript-adapter-codex` flake did not occur.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (T-04-10, -11, -12, -13 mitigated as listed; T-04-14 accepted).

## Next Phase Readiness

Plans 04-04+ can rely on every D-05 path being keyed and haltable. The CI-only real-Postgres helper from 04-02 still awaits Woodpecker on the draft PR.

## Self-Check: PASSED

All created files exist; commits 768e460, d9ab019, b5dcf37, a207a5b present on the branch; `plan_head_before..HEAD` = 4 commits.

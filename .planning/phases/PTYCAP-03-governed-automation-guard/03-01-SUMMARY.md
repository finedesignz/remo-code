---
phase: PTYCAP-03-governed-automation-guard
plan: 01
subsystem: dispatch
tags: [pty, governance, gates, feature-flag, telegram, ask, work]
requires:
  - phase: PTYCAP-02-pty-preflight-gate
    provides: PTY pre-flight gate chain and the shared humanOnlyRejectsActor decision
provides:
  - hub/src/dispatch/governed-pty.ts governance primitives (flag reader, eligible-actor rule, four governors, test-only DI, governedAutomationPtyGate)
  - isDailyTokenCapEnforced() export in gates.ts
  - hard rename of the dispatch gate at ask, work and telegram call sites (gate name governed_automation_pty)
  - OFF==legacy differential test against a frozen oracle
affects: [PTYCAP-03 plans 02-04, PTYCAP-04 (replaces the two fail-closed slots), PTYCAP-07, PTYCAP-08, PTYCAP-09]
actuals:
  tokens: 10000
  tasks: 3
  commits: 3
  plan_head_before: daf10d60627243f775801e3f6b58867e794f9fd5
plan_head_before: daf10d60627243f775801e3f6b58867e794f9fd5
commits: 3
tech-stack:
  added: []
  patterns:
    - "Call-time env flag reader (1|true|yes|on), default OFF"
    - "Frozen-copy differential oracle for byte-identical no-op proof"
    - "Test-only DI setter (_setGovernorsForTests); no public bypass parameter"
key-files:
  created:
    - hub/src/dispatch/governed-pty.ts
    - hub/test/governed-pty-gate.test.ts
  modified:
    - hub/src/dispatch/gates.ts
    - hub/src/telegram/dispatch.ts
    - hub/src/ask/dispatch.ts
    - hub/src/work/dispatch.ts
    - hub/test/telegram-human-only-guard.test.ts
    - hub/test/ext-ask-gates.test.ts
    - hub/test/ext-work-containment.test.ts
    - hub/test/human-only-guard.test.ts
key-decisions:
  - "Gate decision order: resolver once -> non-PTY or exact 'human' ok -> flag OFF legacy block -> ineligible actor legacy block -> governors in fixed order"
  - "A thrown governor yields automation_blocked_on_pty:<actor>:governor_error:<name>, never a pass"
  - "The old gate was deleted from gates.ts only after all three call sites moved (no alias at any commit boundary of the final state)"
requirements-completed: [SC-1, SC-3]
coverage:
  - id: D1
    description: "With the flag OFF (11 off values) the new gate equals a frozen legacy oracle over the full 13-actor x 6-runner matrix, resolver called once, zero governors invoked"
    requirement: SC-3
    verification:
      - kind: unit
        ref: "hub/test/governed-pty-gate.test.ts#flag <off value> differential (11 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Flag ON with production governors blocks every automation actor on a PTY (kill_switch fail-closed slot); external-ask, external-work, empty and unknown actors keep the legacy deny even with every governor passing"
    requirement: SC-1
    verification:
      - kind: unit
        ref: "hub/test/governed-pty-gate.test.ts#PTYCAP Phase 3 -- production governors with the flag ON"
        status: pass
      - kind: unit
        ref: "hub/test/ext-ask-gates.test.ts#PTYCAP Phase 3 (D-06)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Governor order, first-block-wins, enabled rule (token_cap / inject_rate unconfigured), fail-closed slots, throw -> typed denial, non-PTY ok, DI-only setter, no alias"
    requirement: SC-1
    verification:
      - kind: unit
        ref: "hub/test/governed-pty-gate.test.ts (28 pass)"
        status: pass
    human_judgment: false
  - id: D4
    description: "End-to-end through the real Telegram dispatch pipeline: flag ON scheduler source refused by kill_switch slot, human source dispatched"
    requirement: SC-1
    verification:
      - kind: integration
        ref: "hub/test/telegram-human-only-guard.test.ts#governed-automation flag ON (PTYCAP Phase 3)"
        status: pass
    human_judgment: false
duration: 25min
completed: 2026-10-07
status: complete
---

# Phase PTYCAP-03 Plan 01: Governed-automation gate (tracer) Summary

**Flag-gated `governedAutomationPtyGate` (REMO_GOVERNED_AUTOMATION_PTY, default OFF) with four ordered governors (two fail-closed Phase-4 slots), hard-renamed at the ask, work and telegram call sites and proven byte-identical to the legacy human-only gate when OFF by a frozen-oracle differential.**

## Performance

- **Duration:** ~25 min
- **Completed:** 2026-10-07T23:31:14Z
- **Tasks:** 3 (1 tracer, 2 auto)
- **Files modified:** 10 (2 created, 8 modified)

## Accomplishments

- New `hub/src/dispatch/governed-pty.ts`: `governedAutomationEnabled()` (call-time, strict 1|true|yes|on), `GovernorName`/`GOVERNOR_ORDER`, `killSwitchGovernor` and `lifetimeCounterGovernor` (fail closed, `governor_not_implemented:<name>`), `tokenCapGovernor` and `injectRateGovernor` (`governor_unconfigured:<name>` unless enabled), `PRODUCTION_GOVERNORS`, `_setGovernorsForTests`/`_resetGovernorsForTests`, `isGovernedEligibleActor`, `automationBlockedReason`, and `governedAutomationPtyGate` (name `governed_automation_pty`, exactly one parameter).
- SC-3: with the flag unset or any of 10 other off values, decision and reason string equal the frozen legacy oracle for all 78 (actor x runnerType) pairs, the resolver is called exactly once per check and zero governors run.
- SC-1 (structural): every `AUTOMATION_ACTORS` member is admitted only when all four governors pass (provable under DI); in production with the flag ON nothing is admitted (kill_switch slot). external-ask / external-work / '' / unknown actors are denied with the legacy reason even with the flag ON and all governors passing.
- Hard rename done: the old gate is deleted from `gates.ts` (no alias, no re-export; runtime `Object.keys` test), ask, work and telegram compose `governedAutomationPtyGate`.

## Task Commits

1. **Task 1: Tracer - governed-pty module wired through Telegram dispatch with the OFF==legacy differential** - `1d55def` (feat)
2. **Task 2: Rename ask and work call sites and their composition tests** - `e98d271` (feat)
3. **Task 3: Delete the old gate and pin full governor semantics** - `a745ab9` (feat)

**Plan metadata:** committed with this SUMMARY (docs).

## Verify results (real counts)

| File | pass / fail |
|------|-------------|
| hub/test/governed-pty-gate.test.ts | 28 / 0 (floor 15) |
| hub/test/telegram-human-only-guard.test.ts | 6 / 0 (floor 6) |
| hub/test/token-cap-coverage.test.ts | 3 / 0 |
| hub/test/ext-ask-gates.test.ts | 12 / 0 (floor 12) |
| hub/test/ext-work-containment.test.ts | 18 / 0 |
| hub/test/human-only-guard.test.ts | 8 / 0 (floor 8) |
| hub/test/programmatic-hard-halt.test.ts | 10 / 0 |

Tracer gate: `<verify>` for Task 1 re-run end to end and green before expansion. `grep -c -E "gates:[[:space:]]*\["` on governed-pty.ts prints 0; no `humanInteractive` in it; the env literal appears once in `hub/src`. `bun run typecheck` shows no errors in any file this plan changed except one pre-existing `WorkSite` fixture error at `hub/test/ext-work-containment.test.ts(24,7)` (untouched line).

## Files Created/Modified

- `hub/src/dispatch/governed-pty.ts` - governance primitives and the renamed gate
- `hub/src/dispatch/gates.ts` - adds `isDailyTokenCapEnforced()`, deletes the old gate, doc comment updated
- `hub/src/telegram/dispatch.ts`, `hub/src/ask/dispatch.ts`, `hub/src/work/dispatch.ts` - compose `governedAutomationPtyGate`, comments updated
- `hub/test/governed-pty-gate.test.ts` - differential + flag + eligibility + governor tests (28)
- `hub/test/telegram-human-only-guard.test.ts`, `ext-ask-gates.test.ts`, `ext-work-containment.test.ts`, `human-only-guard.test.ts` - renamed assertions plus new cases

## Decisions Made

- Followed the plan's locked decision order and reason contract; a thrown governor is caught inside the gate form and returned as `governor_error:<name>`.
- The differential is split into one test per OFF flag value (11 tests) so the pass count is meaningful and a failure names the offending value.
- `human-only-guard.test.ts` deletes `REMO_GOVERNED_AUTOMATION_PTY` in a `beforeEach` so it always runs flag-OFF (it does not restore a pre-existing ambient value; ambient value is unset in this repo's test runs).

## Deviations from Plan

### Plan inconsistency (not auto-fixed, handed to plan 03-02)

**1. [Scope] One remaining `humanOnlyPtyGate` mention in `hub/src/dispatch/pty-preflight.ts:20` (comment only)**
- **Found during:** Task 3 acceptance check
- **Issue:** Task 3's acceptance command `git grep -n -e humanOnlyPtyGate -e human_only_pty -- hub/src/dispatch ...` is not empty because of a header comment in `pty-preflight.ts` ("Phase 3 will call this seam"). The same task text states that comment mentions in `pty-preflight.ts` are renamed by plans 03-02/03-04, and `pty-preflight.ts` is not in this plan's `files_modified`; plan 03-02 acceptance (`git grep -n humanOnlyPtyGate -- hub/src/dispatch/pty-preflight.ts hub/test/pty-preflight.test.ts` prints nothing) owns it.
- **Fix:** none here; left for 03-02. All code symbols and every file owned by this plan are clean (`git grep` over hub/src/ask, hub/src/work, hub/src/telegram/dispatch.ts and the rest of hub/src/dispatch prints only that one comment line).
- **Files modified:** none

**Total deviations:** 0 auto-fixed, 1 scoped hand-off. **Impact:** none on behavior.

## Issues Encountered

None. RED was confirmed before implementation (module not found), then GREEN. No test-infrastructure errors; no AgentAutofix tickets filed. The agent-branch-namespace commit assertion (`agent-*`) was not applied because this run commits on the designated phase branch `phase-ptycap-03-governed-automation-guard` in the phase worktree per the orchestrator's run rules; the protected-branch check (not main/master/etc.) holds.

## Known Stubs

The `kill_switch` and `lifetime_counter` governors are intentional fail-closed slots (`governor_not_implemented:*`), not data stubs. Phase 4 replaces their bodies; with the flag ON nothing is admitted in production until then. This is the plan's design (D-02).

## Honest scope (carry into VERIFICATION)

The three call-site gates are NOT the door onto a PTY: every automation dispatch adapter sends `user_message`, which the supervisor routes to the stream-json runner. SC-1 is met structurally (admit path under test DI, production slots fail closed, door pinned by plan 03-03). ROADMAP SC-1 text was not edited.

## Threat Flags

None. No new endpoints, auth paths, file access or schema changes. No DDL, no prod env changes, no packages installed.

## User Setup Required

None - no external service configuration required. The new flag `REMO_GOVERNED_AUTOMATION_PTY` defaults OFF and was not set anywhere.

## Next Phase Readiness (for plans 03-02..04)

- 03-02 can import `PRODUCTION_GOVERNORS`/`activeGovernors()` and the reason helpers from `governed-pty.ts`; it must also rename the `humanOnlyPtyGate` comment at `pty-preflight.ts:20`.
- `governed-pty.ts` is the ONLY `hub/src` file containing the env literal (via `GOVERNED_AUTOMATION_PTY_ENV`); its comments deliberately avoid the preflight function name followed by a paren, an automation-actor property assignment, a second env literal, `humanInteractive`, and any `gates: [` pattern, so 03-03's raw-text pins stay green.
- Remaining `humanOnlyPtyGate`/`human_only_pty` mentions outside this plan's files: `pty-preflight.ts` comment, ext.ts, ext-api-key-middleware.ts, client.ts, docs (plans 03-02/03-04).
- Telegram `dispatchToSession` still has the `input.source ?? "human"` default (plan 03-03 owns it).

---
*Phase: PTYCAP-03-governed-automation-guard*
*Completed: 2026-10-07*

## Self-Check: PASSED

- Created files present: hub/src/dispatch/governed-pty.ts, hub/test/governed-pty-gate.test.ts
- Commits present: 1d55def, e98d271, a745ab9 (3 measured via rev-list from the ledger base daf10d6)
- All task acceptance criteria re-run and green except the documented pty-preflight.ts comment hand-off

---
phase: PTYCAP-03-governed-automation-guard
plan: 02
subsystem: dispatch
tags: [pty, preflight, governance, feature-flag, crlf]
requires:
  - phase: PTYCAP-03-governed-automation-guard
    provides: "governed-pty.ts primitives (flag reader, activeGovernors, automationBlockedReason, PRODUCTION_GOVERNORS, test DI)"
provides:
  - "automation-only governed branch in runChain (flag first, spend gates, then governors)"
  - "pinned proof that the human chain never runs a governor"
  - "CRLF-safe humanInteractive guard test"
affects: [PTYCAP-03 plans 03-03, 03-04, PTYCAP-04]
actuals:
  tokens: 9000
  tasks: 2
  commits: 2
  plan_head_before: 3ffb7f2a0d7fabed867cab734a4273883e9f9acb
plan_head_before: 3ffb7f2a0d7fabed867cab734a4273883e9f9acb
commits: 2
tech-stack:
  added: []
  patterns:
    - "Flag-first refusal ahead of any DB-backed gate"
    - "Governors iterated from activeGovernors(), never placed in a chain constant or gates literal"
key-files:
  created: []
  modified:
    - hub/src/dispatch/pty-preflight.ts
    - hub/test/pty-preflight.test.ts
    - hub/test/human-interactive-flag-guard.test.ts
key-decisions:
  - "No try/catch around governors in runChain: a throw reaches checkPtyTurnPreflight's catch (pty_preflight_error), a hang its timeout (pty_preflight_timeout)"
  - "runChain does not re-run the eligible-actor rule; reasons use the actor string 'automation' (door pin is plan 03-03)"
requirements-completed: [SC-1, SC-3]
coverage:
  - id: D1
    description: "Flag OFF: automation refused with automation_blocked_on_pty:automation before any DB gate (a throwing threshold gate does not change the result)"
    requirement: SC-3
    verification:
      - kind: unit
        ref: "hub/test/pty-preflight.test.ts#PTYCAP Phase 3 -- governed automation branch"
        status: pass
    human_judgment: false
  - id: D2
    description: "Flag ON: spend chain then governors in fixed order; production governors refuse via kill_switch slot; governor_unconfigured for cap 0 and disabled token cap; throw -> pty_preflight_error; hang -> pty_preflight_timeout"
    requirement: SC-1
    verification:
      - kind: unit
        ref: "hub/test/pty-preflight.test.ts#PTYCAP Phase 3 -- governed automation branch (9 tests)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Human chain contains no governor; human turn passes with fail-closed production governors and the flag ON; zero governor calls"
    requirement: SC-3
    verification:
      - kind: unit
        ref: "hub/test/pty-preflight.test.ts#PTYCAP Phase 3 -- the human chain never runs a governor (D-07) (4 tests)"
        status: pass
    human_judgment: false
duration: 10min
completed: 2026-10-07
status: complete
---

# Phase PTYCAP-03 Plan 02: Governed automation branch in the PTY preflight Summary

**The PTY preflight now refuses every automation turn unless the governed-automation flag is ON (checked before any DB gate), and with it ON requires the spend chain then all four governors, while the human chain stays provably governor-free.**

## Accomplishments

- `runChain` in `hub/src/dispatch/pty-preflight.ts`: flag check first for non-human actors (`automation_blocked_on_pty:automation`), the existing for-loop unchanged, then `activeGovernors()` iterated for automation only with prefixed reasons (`automation_blocked_on_pty:automation:<governor_reason>`). No try/catch, so governor throw/hang fail closed through the existing error/timeout path.
- The scanned `ptyPreflightDispatchConfig.gates` literal, `PTY_AUTOMATION_TURN_GATES`, the `PTY_HUMAN_TURN_GATES` filter and the `humanInteractive` line are byte-unchanged.
- Header comment rewritten (no legacy gate identifier, no env literal, no actor-assignment call syntax); this closes 03-01's hand-off (the stale `humanOnlyPtyGate` mention).
- `human-interactive-flag-guard.test.ts` now splits on `/\r?\n/` (Phase-2 MINOR-1): 2 pass on this CRLF worktree (1 of 2 failed before).

## Task Commits

1. **Task 1: Flag-first governed automation branch in runChain** - `b7c9ac5` (feat)
2. **Task 2: Human chain governor-free proof + CRLF-safe guard** - `4c06cc9` (test)

## Verify results (real counts)

| File | pass / fail |
|------|-------------|
| hub/test/pty-preflight.test.ts | 46 / 0 (floor 46; 42 after Task 1, floor 42) |
| hub/test/human-interactive-flag-guard.test.ts | 2 / 0 (floor 2) |
| hub/test/token-cap-coverage.test.ts | 3 / 0 |
| hub/test/ws-client-pty-preflight.test.ts | 22 / 0 |

`git grep -n humanOnlyPtyGate -- hub/src/dispatch/pty-preflight.ts hub/test/pty-preflight.test.ts` prints nothing.

## Deviations from Plan

None - plan executed as written. TDD note: Task 1 RED confirmed (8 fail before implementation, 34 pass); Task 2's four human-chain tests pass immediately by design because they pin untouched behavior (they are regression guards, not drivers of new code).

## Issues Encountered

None. No test-infrastructure errors; no AgentAutofix tickets filed.

## Known Stubs

None added. The two fail-closed governor slots (`kill_switch`, `lifetime_counter`) remain 03-01's intentional Phase-4 placeholders.

## Threat Flags

None. No new endpoints, auth paths, file access or schema changes; no DDL, no env set, no packages installed.

## Next (plans 03-03, 03-04)

- The env-var literal is still only in `governed-pty.ts`; `pty-preflight.ts` contains no `humanOnlyPtyGate`, no env literal, no automation-actor property assignment in call syntax, and exactly one `humanInteractive :` line.
- The 'automation' actor is still accepted by `checkPtyTurnPreflight`'s type from any caller; the caller pin (only `hub/src/orchestrator/`) is plan 03-03's.
- Remaining `humanOnlyPtyGate` / `human_only_pty` mentions: ext.ts, ext-api-key-middleware.ts, client.ts, docs (plans 03-03/03-04).

## Self-Check: PASSED

- Modified files present; commits b7c9ac5 and 4c06cc9 present (2 measured via rev-list from ledger base 3ffb7f2).
- All verify commands re-run and green.

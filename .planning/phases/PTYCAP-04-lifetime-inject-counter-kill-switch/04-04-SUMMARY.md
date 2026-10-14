---
phase: PTYCAP-04-lifetime-inject-counter-kill-switch
plan: 04
subsystem: hub-dispatch
tags: [governors, kill-switch, lifetime-counter, pty-door, reserve, static-pins]

requires:
  - phase: PTYCAP-04-02
    provides: killSwitchCheck, lifetimeCounterCheck, countRateUnion, reserveInject (atomic, token-idempotent, enforceRate)
  - phase: PTYCAP-03-governed-automation-guard
    provides: governor slots, flag-first automation branch of the PTY preflight
provides:
  - kill_switch and lifetime_counter governors are the same function references the dispatcher-list gates run (no wrapper)
  - inject_rate governor COUNTS the de-duplicated union (over_session_inject_rate:<n>>=<cap>)
  - the PTY door reserves (one atomic lifetime + rate reservation, per-turn token, counter key) after the governors; missing token or key refuses
  - reserve-caller-guard pins (reserveInject callers, counterKey/turnToken suppliers)
affects: [PTYCAP-04-07 (adds the self-heal route to the reserve-caller pin), PTYCAP-05 (producer supplies counterKey + per-turn token)]

plan_head_before: a679e23
actuals:
  tokens: 9500
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Governor check IS the shared controls function reference (identity asserted in tests)"
    - "Door-owned consumption: reservation after all non-consuming checks, no try/catch (throw -> pty_preflight_error, hang -> pty_preflight_timeout)"
    - "Balanced-paren call-argument scanner in a static pin, with helper self-check"

key-files:
  created:
    - hub/test/reserve-caller-guard.test.ts
  modified:
    - hub/src/dispatch/governed-pty.ts
    - hub/src/dispatch/pty-preflight.ts
    - hub/test/governed-pty-gate.test.ts
    - hub/test/pty-preflight.test.ts
    - hub/test/telegram-human-only-guard.test.ts

key-decisions:
  - "inject_rate governor reads its ceiling from gates.ts maxInjectsPerHour() (unchanged unconfigured semantics) and counts with countRateUnion(sessionId, 60); the in-lock reserve re-checks the same union, so a governor pass is advisory and the reservation is the authority"
  - "Door ignores counterKey/turnToken on the human actor (never added to the request, never reserved)"
  - "Order when both are missing: pty_turn_token_missing before lifetime_counter_key_missing (with production governors the lifetime governor already refuses a missing key first, same reason)"
  - "Telegram end-to-end test engages the kill switch via the env break-glass (real controls module, mocked sql), so no controls mock was needed there"

requirements-completed: [SC-1, SC-2]

coverage:
  - id: D1
    description: "Real governor slots, shared function identity, counting inject_rate governor"
    requirement: "SC-1"
    verification:
      - kind: unit
        ref: "hub/test/governed-pty-gate.test.ts (34), telegram-human-only-guard.test.ts (7)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Door counts the turn: one reserve after the last governor with per-turn token + key + enforceRate; refusals; error/timeout; idempotent token; human/flag-OFF never reserve"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/pty-preflight.test.ts (58)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Caller pins for reserveInject and for counterKey/turnToken suppliers"
    requirement: "SC-2"
    verification:
      - kind: unit
        ref: "hub/test/reserve-caller-guard.test.ts (6)"
        status: pass
    human_judgment: false

duration: 35min
completed: 2026-10-13
status: complete
---

# Phase PTYCAP-04 Plan 04: Real governors and the counting PTY door

**With the flag ON an admitted automation PTY turn is now always counted: kill switch and lifetime counter are real shared checks, the rate governor counts the de-duplicated union, and the door makes one atomic lifetime-plus-rate reservation with a per-turn token before returning ok.**

## Accomplishments

- **Task 1 (292787d):** `governed-pty.ts` imports `killSwitchCheck`, `lifetimeCounterCheck`, `countRateUnion` from the controls module. `killSwitchGovernor.check` and `lifetimeCounterGovernor.check` are the same function objects as `automationKillSwitchGate.check` / `automationLifetimeCounterGate.check`. `injectRateGovernor` keeps the unconfigured refusal and refuses `over_session_inject_rate:<n>>=<cap>` when the union count is at or over the ceiling; a count error propagates (gate maps to `governor_error:inject_rate`). `governor_not_implemented` is gone from `hub/src`. Header comment rewritten. `tokenCapGovernor`, `GOVERNOR_ORDER`, the flag literal and the DI setters are byte-identical; the file does not mention `humanInteractive`.
- **Task 2 (b5dff53):** `pty-preflight.ts` takes optional `counterKey` / `turnToken` (automation only). The request token is the per-turn token when supplied (constant per-session token otherwise, for the spend gates, never for a reserve). After the governor loop: missing token -> `pty_turn_token_missing`, missing key -> `lifetime_counter_key_missing`, then `reserveInject({..., enforceRate: true})`; a blocked result is composed as `automation_blocked_on_pty:<actor>:<reason>`. The `gates` literal, chain constants, human filter and the `humanInteractive` line are unchanged.
- **Pins:** `reserve-caller-guard.test.ts` (6 tests): `reserveInject(` only in the controls module and the door; the door reserves with `input.turnToken` and never the `pty-preflight:` token; `checkPtyTurnPreflight(` arguments may mention `counterKey`/`turnToken` only under `hub/src/orchestrator/` (ws/client.ts call found and clean); scanner and helper self-checks.

## Verification

| Gate | Result |
|---|---|
| governed-pty-gate / telegram-human-only-guard / human-only-guard / token-cap-coverage | 34 / 7 / 8 / 3 pass |
| pty-preflight (Phase 3 baseline 46) | 58 pass |
| reserve-caller-guard / human-interactive-flag-guard / pty-door-guard / ws-client-pty-preflight | 6 / 2 / 22 / 24 pass |
| `bun run check-baseline` | run 1: pass=2526 skip=259 fail=1 (unidentified flake); reruns: pass=2527 skip=259 fail=0 (baseline pass=2379 skip=259) |
| `tsc --noEmit` (hub) | 427 errors, equal to baseline, none in touched files |
| `bun run docs:sync` | not run (no routes / OpenAPI touched) |

## Deviations from Plan

**1. [Info] check-baseline first run had one failing test**
The first full run reported fail=1; the immediate rerun and a second rerun were clean (fail=0, skip=259). I did not capture which test failed on the first run (output was truncated by my tail); it is not in a file this plan touched and every touched file passes individually. Consistent with the known transcript-adapter-codex flake but not confirmed.

**2. [Scope note] Tests rewritten, two removed**
In `governed-pty-gate.test.ts` the two tests that asserted `governor_not_implemented` (the lifetime-slot-fails-closed test and the "production bodies always block" test) were replaced by the identity, real-reason and rate tests; no flag-OFF differential assertion was touched. `human-only-guard.test.ts`, `ws-client-pty-preflight.test.ts` and `pty-door-guard.test.ts` needed no edits.

**3. [Scope note] Controls module leaf-mocked in two test files**
`governed-pty-gate.test.ts` and `pty-preflight.test.ts` use `mock.module` on `automation-controls.ts` (spreading the shared `automationControlsLeaf()` fixture plus controllable fakes), not edits to the fixture.

## Issues Encountered

None blocking.

## Known Stubs

None.

## Threat Flags

None beyond the plan's threat model (T-04-15 through T-04-19 mitigated as listed; T-04-20 accepted and documented in the door header).

## Next Phase Readiness

04-07 adds `api/sessions.ts` to the `reserveInject(` allowlist in `reserve-caller-guard.test.ts` with its reason. The Phase 5 producer must supply `counterKey` and a per-turn `turnToken` from `hub/src/orchestrator/`; until then the flag-ON path refuses `lifetime_counter_key_missing` (fail closed, flag default OFF).

## Self-Check: PASSED

Created/modified files exist; commits 292787d and b5dff53 present on the branch; `plan_head_before..HEAD` = 2 commits.

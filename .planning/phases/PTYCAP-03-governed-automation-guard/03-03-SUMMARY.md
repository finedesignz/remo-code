---
phase: PTYCAP-03-governed-automation-guard
plan: 03
subsystem: testing
tags: [pty, telegram, ws-client, door-guard, spoofing, structural-test]
status: complete

requires:
  - phase: PTYCAP-03-governed-automation-guard
    provides: 03-01 governed preflight chain + flag/DI module (dispatch/governed-pty.ts); 03-02 human chain pinned governor-free
provides:
  - Telegram DispatchInput.source is a required compile-time field; the webhook asserts the literal "human"; a missing source fails closed on a pty-interactive session
  - Executed proof that /ws/client strips client-asserted source/actor keys and preflights as the server-inferred human
  - hub/test/pty-door-guard.test.ts (21 tests): emitter allowlist, supervisor routing canary, privileged-caller pins, flag/DI pins, actor-inference pins, Telegram pins, exemption pins
affects: [PTYCAP-03-04, orchestrator automation lane, any future term.* producer]

actuals:
  tokens: 5100
  tasks: 3
  commits: 3
plan_head_before: 627cbe9e9257ac8e595a09087a10dd83bef931db

tech-stack:
  added: []
  patterns:
    - "DB-free structural source-scan tests with non-vacuous scanner self-checks (human-interactive-flag-guard / token-cap-coverage precedent)"
    - "Required-at-compile-time actor/source param asserted at the authenticated boundary; no nullish default"

key-files:
  created:
    - hub/test/pty-door-guard.test.ts
  modified:
    - hub/src/telegram/dispatch.ts
    - hub/src/api/telegram-webhook.ts
    - hub/src/telegram/doctor.ts
    - hub/test/telegram-human-only-guard.test.ts
    - hub/test/telegram-dispatch.test.ts
    - hub/test/ws-client-pty-preflight.test.ts

key-decisions:
  - "Telegram source has no default: missing source is refused on a pty-interactive session (D-09 iv)"
  - "attach_file and injectPtyKeystroke stay preflight-exempt, pinned with written justifications (D-10)"
  - "No allowlist widening: dispatchToSession( pin needed no doctor.ts entry because doctor.ts only references the symbol (import / typeof / default), never calls it textually"

requirements-completed: [SC-2, SC-1]
completed: 2026-10-13
---

# Phase PTYCAP-03 Plan 03: Pin the PTY door and close the spoofing surface Summary

Telegram dispatch source is now required with no human default, /ws/client actor-key stripping is an executed fact, and one DB-free test file pins every hub->agent term.* emitter, the supervisor routing, every privileged caller, the flag/DI literals and the two preflight exemptions.

## Tasks and commits

| Task | Name | Commit | Files |
| ---- | ---- | ------ | ----- |
| 1 | Telegram source required, fail closed when missing | 87d92c8 `feat(PTYCAP-03-03): make Telegram dispatch source required, fail closed when missing` | hub/src/telegram/dispatch.ts, hub/src/api/telegram-webhook.ts, hub/src/telegram/doctor.ts, hub/test/telegram-human-only-guard.test.ts, hub/test/telegram-dispatch.test.ts |
| 2 | /ws/client strips client-asserted actor keys | 8f5cfad `test(PTYCAP-03-03): prove /ws/client strips client-asserted actor keys and preflights as human` | hub/test/ws-client-pty-preflight.test.ts |
| 3 | Door pins | 9e7d93e `test(PTYCAP-03-03): pin the PTY door -- term.* emitters, supervisor routing, privileged callers, flag/DI, exemptions` | hub/test/pty-door-guard.test.ts |

Task 1 was executed in an earlier session (replay in `telegram/doctor.ts` passes `source: 'human'` through its injected `dispatch` param for the buffered authenticated-webhook message). Tasks 2 and 3 in this session.

## Verification (one bun process per file)

| File | Result |
| ---- | ------ |
| test/telegram-human-only-guard.test.ts | 6 pass, 0 fail |
| test/telegram-dispatch.test.ts | 6 pass, 0 fail |
| test/ws-client-pty-preflight.test.ts | 24 pass, 0 fail (22 existing + 2 new) |
| test/term-relay-human-guard.test.ts | 3 pass, 0 fail; file byte-unchanged (D-09 iii agent-socket spoof case intact) |
| test/pty-door-guard.test.ts | 21 pass, 0 fail (plan floor 14) |

`git diff --name-only $(merge-base HEAD origin/main) -- supervisor/` prints nothing (SC-4 holds; the canary only READS supervisor/src/runners/session-bridge.ts).

`bunx tsc --noEmit -p tsconfig.json`: 427 errors, ALL pre-existing and unrelated to this plan (src/api/_openapi.ts zod-openapi overloads, src/telegram/doctor.ts L100/L206 bigint/RowList casts, `unknown` body typings across hub/test). None in telegram/dispatch.ts, api/telegram-webhook.ts, or any test file this plan touched; no missing-`source` error anywhere, i.e. the required field type-checks at every call site. The tsc gate is not green repo-wide independent of this plan; flagged for the orchestrator.

## Negative proof (temporary, reverted)

Created scratch `hub/src/zz-scratch-emitter.ts` containing a quoted `'term.input'` and a `getChannel("s")` call. `bun test test/pty-door-guard.test.ts` -> 20 pass, 1 FAIL: "no emitter outside the allowlist" listing `zz-scratch-emitter.ts`. Deleted the scratch file -> 21 pass, 0 fail. `git status` clean of the scratch file; nothing of it committed.

## Deviations from Plan

None - plan executed as written.

Notes (not deviations):
- Door-pin detection re-run at implementation time found no comment-only hits from plans 03-01/03-02; no comment rewording was needed and no allowlist was widened.
- The executor brief anticipated that `telegram/doctor.ts` might need adding to the `dispatchToSession(` caller pin. It does not: doctor.ts references `dispatchToSession` only as an import, a `typeof` type and a default value (no textual `dispatchToSession(`), so the pin stays at exactly {telegram/dispatch.ts, api/telegram-webhook.ts}. If doctor.ts ever gains a literal call, add it with the justification "buffered replay of an authenticated-webhook message".
- Commit-count ledger: the on-disk ledger `gsd-plan-head-before-PTYCAP-03-03` holds a pre-rebase SHA (b492904, not an ancestor of HEAD; `rev-list` yields a meaningless 18). `commits: 3` and `plan_head_before` are measured against the true pre-task-1 parent 627cbe9 (`git rev-list --count 627cbe9..HEAD` = 3).

## Known Stubs

None.

## Threat Flags

None - no new network endpoints, auth paths or schema changes. Threats mitigated: T-03-12 (key strip proven, no dispatch code reads request source/actor), T-03-13 (Telegram default-human removed), T-03-14 (emitter + caller pins), T-03-15 (supervisor canary), T-03-16 (EXT constants pinned), T-03-17 (flag/DI literals confined), T-03-18 (EXEMPTIONS pinned at exactly two). T-03-19 accepted per D-15 (legacy JWT stays human; residual documented in 03-04).

## Self-Check: PASSED

- hub/test/pty-door-guard.test.ts: FOUND
- Commits 87d92c8, 8f5cfad, 9e7d93e: FOUND on branch phase-ptycap-03-governed-automation-guard
- STATE.md / ROADMAP.md intentionally not touched (orchestrator-owned)

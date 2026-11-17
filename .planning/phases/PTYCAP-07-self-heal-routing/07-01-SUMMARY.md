---
phase: PTYCAP-07-self-heal-routing
plan: 01
subsystem: hub/heal
tags: [heal, flags, zod, repo-ident, budget-key]
status: complete
requires: []
provides:
  - healUnifiedEnabled / healAutospawnArmed / REMO_HEAL_* knob readers
  - HealEvent closed union, parseHealEvent, HealOutcome, outcomeToString
  - canonicalRepoIdent, canonicalRepoIdentFromGit, isCanonicalRepoIdent
  - buildHealKey, HealKeyError
affects: [07-02..07-11]
key-files:
  created:
    - hub/src/heal/config.ts
    - hub/src/heal/types.ts
    - hub/src/heal/repo-ident.ts
    - hub/src/heal/counter-key.ts
    - hub/test/heal-config.test.ts
    - hub/test/heal-types.test.ts
    - hub/test/heal-repo-ident.test.ts
    - hub/test/heal-counter-key.test.ts
  modified: []
decisions:
  - "parseHealEvent throws ZodError on invalid input (consistent failure mode)"
  - "HealEvent per-source fields live under a ctx object; schemas are .strict() so bound_session_id on coolify_deploy is rejected"
  - "isCanonicalRepoIdent requires lowercase github idents; path idents keep case"
requirements: [SH-02, SH-07]
completed: 2026-10-13
plan_head_before: b25f07c2ccc8fa16a76e4197a9cebb7e56662186
commits: 2
actuals:
  tokens: 6500
  tasks: 2
  commits: 2
---

# Phase PTYCAP-07 Plan 01: Heal seam foundation Summary

Pure, DB-free foundation for unified self-heal: default-OFF flag and safe-default knobs, closed HealEvent/HealOutcome types, canonical repo identity, and a single user-scoped heal key builder that refuses null idents.

## Commits

- 6cdc405 feat(PTYCAP-07-01): flag/knob readers + HealEvent/HealOutcome types (Task 1)
- d29c6b9 feat(PTYCAP-07-01): canonical repo ident + shared heal key builder (Task 2)

## Verification

- `bun test hub/test/heal-config.test.ts hub/test/heal-types.test.ts`: 52 pass, 0 fail
- `bun test hub/test/heal-repo-ident.test.ts hub/test/heal-counter-key.test.ts`: 18 pass, 0 fail
- `counter-key-assignment-guard.test.ts` 3 pass; `token-cap-coverage.test.ts` 3 pass; `heal-flag-off.test.ts` 89 pass (all 0 fail)
- No `REMO_ORCHESTRATOR_ENABLED`/`isOrchestratorEnabled` or `counterKey` under hub/src/heal; `REMO_HEAL*` env referenced only in hub/src/heal/config.ts; `git diff PLAN_BASE..HEAD -- hub/src/api` empty.

## Deviations from Plan

None - plan executed as written. TDD red was confirmed for Task 1 (modules missing); Task 2 tests were written before modules and run only after (modules absent, so red by construction).

Note: `healAutospawnArmed` imports `isAutospawnEnabled` from orchestrator/controller.ts as the plan specifies; the import is DB-free at test time (tests pass without a database).

## Known Stubs

None.

## Threat Flags

None.

## Self-Check: PASSED

All 8 created files exist; commits 6cdc405 and d29c6b9 exist on phase-ptycap-07-self-heal-routing.

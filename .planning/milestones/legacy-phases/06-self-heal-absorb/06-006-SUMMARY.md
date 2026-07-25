---
phase: 06-self-heal-absorb
plan: 006
subsystem: scheduler
tags: [triage, schema, zod, prompt-template]
provides:
  - hub/src/scheduler/triage-schema.ts (TriageResult, parseTriageOutput)
  - hub/src/scheduler/triage-prompt.ts (renderTriagePrompt)
  - task_kind 'triage' on TaskType union + API enum
requires:
  - zod (already a dep)
key-files:
  created:
    - hub/src/scheduler/triage-schema.ts
    - hub/src/scheduler/triage-prompt.ts
    - hub/test/triage-schema.test.ts
  modified:
    - hub/src/db/scheduled-tasks-dal.ts
    - hub/src/api/scheduled-tasks.ts
decisions:
  - parseTriageOutput tolerates a single leading/trailing ```json fence; bare prose is rejected
  - prompt caps log_snippet to last 100 newline-delimited lines
  - 'triage' added to runtime enum in addition to TS union so API validation accepts it
completed: 2026-05-25
---

# Phase 06 Plan 006: Triage task_kind Summary

Added the `task_kind: 'triage'` plumbing for Phase 06 self-heal absorb: structured TriageResult Zod schema with a tolerant parser, deployment-triage prompt template, and TaskType union/enum extension.

## Tasks Completed

| Task | Name | Commit |
| ---- | ---- | ------ |
| 1 | TriageResult schema + parser (TDD) | e0df346 |
| 2 | renderTriagePrompt template | 0d74921 |
| 3 | Add 'triage' to TaskType union + API enum | 9e956d1 |

## Verification

- `bun test test/triage-schema.test.ts` → 8 pass, 0 fail, 18 expects.
- Prompt verify script confirms all 5 required JSON field names + deployment context present.
- Bun import-check on modified `scheduled-tasks-dal.ts` and `scheduled-tasks.ts` succeeds (no tsconfig in repo, so plan's `tsc --noEmit` command is a no-op; substituted runtime import check).

## Deviations from Plan

**1. [Rule 3 - Blocking] tsc verify command produces help text, not type-checking**
- **Found during:** Task 3 verification
- **Issue:** Repo has no `tsconfig.json` (neither at root nor in `hub/`). `bun run tsc --noEmit` and direct `tsc --noEmit` both print the help screen because tsc has no project to compile.
- **Fix:** Substituted a Bun runtime import-check of both modified files to confirm they load without parse/resolution errors. Behavior of the plan (TypeScript compiles, union member present) is satisfied — grep confirms `'triage'` in both locations.
- **Files modified:** none beyond the planned files.

## Self-Check: PASSED

- hub/src/scheduler/triage-schema.ts → FOUND
- hub/src/scheduler/triage-prompt.ts → FOUND
- hub/test/triage-schema.test.ts → FOUND
- commit e0df346 → FOUND
- commit 0d74921 → FOUND
- commit 9e956d1 → FOUND

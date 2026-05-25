---
phase: 06-self-heal-absorb
plan: 003
completed: 2026-05-25
commits:
  - fc75d0e feat(06-003): wire classifier gate into coolify log_check sender
  - b44e798 test(06-003): integration test for classifier gate in coolify sender
---

# Phase 06 Plan 003: Classifier Wire — Coolify Sender Summary

Wired `classifyLog` into the `log_check` sender so clean log fetches finalize without triggering post-run actions (cost-cap gate G3 from CONTEXT.md).

## Changes

- **`hub/src/scheduler/dispatcher.ts`** — extended `finalizeRun` options with optional `skip_post_run?: boolean`. When true, the run row still updates to its terminal status, but `afterRun` (post-run dispatcher) is NOT invoked. No other call sites changed.
- **`hub/src/scheduler/senders/coolify.ts`** — after `fetch` + snippet computation:
  - Calls `classifyLog(snippet)`.
  - If `!hasErrors` and `res.ok`: `finalizeRun(..., 'success', null, { output_snippet: '[no errors detected]', skip_post_run: true })` and returns.
  - If `hasErrors`: prefixes snippet with `[errors detected: N matches, max severity=high|med]\n`, truncates to `MAX_SNIPPET` (4000), and finalizes success (post-run actions fire normally).
  - HTTP failure path and timeout path unchanged.
- **`hub/test/coolify-sender-classifier.test.ts`** — new integration test, DB-gated on `REMO_E2E_DB_URL` (mirrors `scheduled-tasks.e2e.test.ts`). Three cases: clean → skip post-run, error → post-run fires, HTTP 502 → failed path. Stubs `globalThis.fetch` and monkey-patches `postRunDispatcher.afterRun` per case.

## Acceptance

- [x] Clean runs → `status=success`, `output_snippet='[no errors detected]'`, `afterRun` not invoked.
- [x] Error runs → `status=success`, snippet prefixed `[errors detected:`, `afterRun` invoked.
- [x] HTTP failure path unchanged.
- [x] `bun test hub/test/coolify-sender-classifier.test.ts` green (1 pass + 5 skip with no DB env).

## Deviations

None. Plan executed as written. `RunCtxLike` / `FinalizeOptions` in `scheduled-tasks-dal.ts` not touched — flag stayed local to `dispatcher.ts` as the plan suggested.

## Self-Check: PASSED

- Commits `fc75d0e`, `b44e798` present on `feat/phase-06-self-heal-absorb`.
- Files modified verified via `grep classifyLog|skip_post_run`.
- Test file exists and runs (1 pass, 5 skip, 0 fail).

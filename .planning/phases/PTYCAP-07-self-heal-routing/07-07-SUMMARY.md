---
phase: PTYCAP-07-self-heal-routing
plan: 07
subsystem: hub/heal
tags: [self-heal, sinks, run-store, idempotent-finalize]
requires: [07-05]
provides: [sinkFor, makeHealSink, buildCoolifySink, buildScheduledTaskSink, buildErrorCaptureSink, buildFeedbackSink, buildErrorCaptureRunStore, sendUserMessage]
affects: [07-08, 07-09, 07-10]
key-files:
  created:
    - hub/src/heal/sinks/shared.ts
    - hub/src/heal/sinks/coolify.ts
    - hub/src/heal/sinks/scheduled-task.ts
    - hub/src/heal/sinks/error-capture.ts
    - hub/src/heal/sinks/feedback.ts
    - hub/src/heal/sinks/index.ts
    - hub/test/heal-sinks-coolify-scheduled.test.ts
    - hub/test/heal-sinks-error-feedback.test.ts
  modified:
    - hub/src/error-capture/dispatcher.ts
status: complete
commits: 2
plan_head_before: 4850eca426b2b9b6f3508af73f669c729942e9b6
actuals:
  tokens: 40000
  tasks: 2
  commits: 2
---

# Phase PTYCAP-07 Plan 07: Per-source heal sinks Summary

The four self-heal sources now persist through one static sink map (`sinkFor` / `makeHealSink`), with idempotent terminalization; the error-capture run store is shared between the legacy path and the heal sink via a pure-move extraction.

## Commits (task commits; the summary commit follows)
- 607f81a Task 1: shared send helper, coolify sink, scheduled-task sink, sink map
- 7166a95 Task 2: extract buildErrorCaptureRunStore, error-capture and feedback sinks, complete map

## What was built
- `shared.ts`: `sendUserMessage` (persist, optional subscriber broadcast, user_message frame; `images` and `run_id` only when supplied; throws `session_offline` or a supplied code) and `buildLedgerOnlySink` (no run table; dispatch token is `heal:{eventId}`).
- `coolify.ts`: opens a child run under the internal triage task with `triggered_by_run_id` = metadata run, registers the same run context and started broadcast as legacy `fireTask`, finalizes via the legacy triage parse (`success` / `triage_parse_error`, 4000-char snippet), `skipped_quota` vs `skipped`, `agent_send_failed:` prefix, and mirrors terminal status onto the metadata run. Every write is `only_if_active` and each run is written at most once per sink (first writer wins; second `finalizeTerminal` is a no-op).
- `scheduled-task.ts` / `feedback.ts`: thin wrappers over the ledger-only sink (zero run-row writes; feedback send carries images).
- `error-capture.ts`: wraps the extracted legacy store; `markDispatched` writes `dispatched` + `error_dispatched` broadcast; `finalizeTerminal` maps unroutable/refused/deduped to `skipped` (+ `error_skipped` broadcast) and failed to `failed`, idempotent via a settled flag shared with `markSkipped` / `markFailed` / `onParkExpire`; no ensure-online hook (AM-F1-5).
- `error-capture/dispatcher.ts`: `buildErrorCaptureRunStore` lifted verbatim out of `dispatchPendingError` (pure move).
- `index.ts`: static source map, lazy sink modules (importing it never loads the DB); unknown source throws `unknown_heal_source`; `makeHealSink` is the factory `route.ts` resolves at call time.

## Verification
- `heal-sinks-coolify-scheduled.test.ts` 12 pass / 0 fail
- `heal-sinks-error-feedback.test.ts` 10 pass / 0 fail
- `error-capture-dispatch.test.ts` 1 pass (file unchanged), `heal-flag-off.test.ts` 89 pass (file unchanged)
- `token-cap-coverage.test.ts` 3 pass, `counter-key-assignment-guard.test.ts` 3 pass, `heal-route-live.test.ts` 9 pass, `heal-route-guards.test.ts` 14 pass
- `tsc --noEmit` reports no errors in the touched files
- `route.ts` and `sinks/types.ts` untouched; no `ensureOnline` / `ensureSessionOnline` in `hub/src/heal`; sinks import `dispatch/pipeline` as types only.
- Postgres e2e skipped locally (no local Postgres), as expected.

## Deviations from Plan
1. **[Design] Ledger detail hook has no default writer.** The plan says scheduled-task/feedback callbacks "record to the ledger outcome detail via the injected hook". `heal_events` has no detail column (schema change out of scope; outcome string is owned by `route.ts`), so `recordDetail` is an optional injected observer with no default; the route-persisted outcome is the record.
2. **[Design] dispatch_run_id hook not added to the coolify sink.** `route.ts` already persists `dispatchRunId` from the `open()` return value on a `dispatched` result, so the child id reaches the ledger without extending the contract.
3. **[Design] `error_capture` session id** comes from `event.bound_session_id` (equal to `project.session_id`); the sink refuses a project whose `user_id` differs from the event's (`error_project_owner_mismatch`).
4. **Legacy parity gap, recorded:** the legacy error-capture `parked_offline` path sent a throttled `session_offline` notification; under the heal flag the owner notification is `notify.ts`'s single-attempt notice (07-06), so the sink does not duplicate it. `markDispatched` fires before the send in the pipeline (legacy wrote `dispatched` after the send); a send failure then overwrites it with `failed` through `markFailed`.
5. Per-commit worktree branch check: this branch is `phase-ptycap-07-self-heal-routing` (orchestrator-assigned, same as prior plans), not an `agent-*` name; not protected, so commits proceeded.

## Known Stubs
None.

## Threat Flags
None (no new endpoints or trust boundaries; T-07-25..28 mitigated as planned).

## Self-Check: PASSED
All created files exist; commits 607f81a and 7166a95 present on the branch.

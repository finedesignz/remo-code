---
phase: PTYCAP-07-self-heal-routing
plan: 03
subsystem: hub-tests
tags: [self-heal, characterization, flag-off, SC5]
requires: []
provides:
  - hub/test/heal-flag-off.test.ts (legacy effect-trace baseline, flag-value parameterised)
affects: [07-04..07-10 (re-run unchanged as flag-OFF proof)]
key-files:
  created: [hub/test/heal-flag-off.test.ts]
  modified: []
status: complete
plan_head_before: f8671fb105b326d1cdc4811dc749c9e0b27fcbeb
commits: 1
actuals:
  tokens: 6500
  tasks: 2
  commits: 1
---

# Phase PTYCAP-07 Plan 03: flag-OFF legacy baseline Summary

Effect-trace characterization of Coolify dispatchTriage, error-capture, feedback and scheduled-task failure email, recorded green on unmodified hub/src, looped over REMO_HEAL_UNIFIED = unset, "", 0, false, maybe, garbage.

## What was pinned
- Coolify: fresh+repo-keyed (claim, resolve, fetchAppLogs, ensureInternalTriageTask, runNow with exact opts/payloadOverride, no finalizeRun); online-agent fallback; duplicate claim (only claim called, run NOT finalized - legacy orphan recorded as-is); unroutable (finalizeRun skipped/no_routable_session once, no runNow); claim error and probe error both fail open and dispatch.
- error-capture and feedback: gate names [automation_kill_switch, threshold, daily_cost_cap, daily_token_cap, session_inject_rate], ensureOnline is a function, exact request key set, no counterKey; error-capture 'dispatched' status update and error_dispatched broadcast.
- buildDefaultEmailActions: failed root run -> 1 notify_email; failed __internal_triage -> 1; successful __internal_ -> 0; email_summary=false -> 0; existing notify_email -> 0.
- Static check: coolify-webhook.ts, error-capture/dispatcher.ts, feedback/dispatcher.ts, scheduler/dispatcher.ts have no static import of heal/route or heal/sinks (detector has a positive control).

## Verification
- `bun test hub/test/heal-flag-off.test.ts`: 89 pass, 0 fail (run green before any other plan touched code).
- Siblings, run per file: error-capture-dispatch 1/0, feedback-webhook 13/0, coolify-webhook 29/0 (pass/fail).
- `git diff --name-only f8671fb..HEAD -- hub/src`: empty.

## Deviations from Plan
- Tasks 1 and 2 share one file and were written together, so one commit (cda3b86) covers both rather than one per task.
- Commit made on branch `phase-ptycap-07-self-heal-routing` as directed by the orchestrator (not the agent-* namespace the generic worktree allow-list expects); branch is not protected.
- Trace fingerprints asserted as non-empty strings that differ between buckets (time-bucketed, cannot be literal).

## Known Stubs
None.

## Self-Check: PASSED
- hub/test/heal-flag-off.test.ts exists; commit cda3b86 exists.

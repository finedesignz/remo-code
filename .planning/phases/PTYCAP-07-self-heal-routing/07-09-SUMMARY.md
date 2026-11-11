---
phase: PTYCAP-07-self-heal-routing
plan: 09
subsystem: hub/heal
tags: [self-heal, error-capture, feedback, flag-switch, tenancy]
requires: [07-06, 07-07]
provides: [buildErrorCaptureHealEvent, healOutcomeToErrorOutcome, buildFeedbackHealEvent, healOutcomeToFeedbackOutcome, dispatchPendingError-flag-switch, dispatchFeedback-flag-switch, heal/flag.ts]
affects: [07-10, 07-11]
key-files:
  created:
    - hub/src/heal/sources/error-capture.ts
    - hub/src/heal/sources/feedback.ts
    - hub/src/heal/flag.ts
    - hub/test/heal-source-error-feedback.test.ts
  modified:
    - hub/src/error-capture/dispatcher.ts
    - hub/src/feedback/dispatcher.ts
    - hub/src/heal/config.ts
status: complete
commits: 2
plan_head_before: 479c97b98f35168fb88305604e494262d8040bea
actuals:
  tokens: 40000
  tasks: 2
  commits: 2
---

# Phase PTYCAP-07 Plan 09: Error-capture and feedback heal sources Summary

Error capture and feedback intake now feed `routeHeal` behind `REMO_HEAL_UNIFIED` with a revalidated, owner-scoped bound session and no ensure-online hook; flag OFF is unchanged. All four sources are now wired (SC1).

## Commits
- 134830a Task 1: error-capture source, `dispatchPendingError` flag switch, `flag.ts` leaf
- aedea47 Task 2: feedback source, `dispatchFeedback` flag switch, feedback tests

## What was built
- `sources/error-capture.ts`: `buildErrorCaptureHealEvent` (repo_ident null so the seam derives it from the owned session; dedupe key `err:<project>:<fingerprint>`; already-fenced prompt; legacy stored string) and `healOutcomeToErrorOutcome`.
- `sources/feedback.ts`: `buildFeedbackHealEvent` (`fb:<submissionId>`, screenshot as `images`, user/session ids passed through unchanged so tenancy is enforced by the seam's owner-scoped lookup) and `healOutcomeToFeedbackOutcome`.
- Both dispatchers: `dispatchX` checks the flag; OFF calls the verbatim legacy function (`dispatchPendingErrorLegacy` / `dispatchFeedbackLegacy`, between `heal-legacy-path:begin/end` markers); ON lazily imports the builder and `routeHeal` and maps the outcome back to the legacy return shape. No `PipelineDeps`, no ensure-online hook, no fall back to legacy on error. A project with no bound session id (hub self-capture) still takes the legacy path. Optional trailing `healOpts` arg forwards `routeDeps` for tests only.

## Verification (one test file per process)
- heal-source-error-feedback 41 pass (RED/GREEN: see deviation 1)
- heal-flag-off 89 (unmodified); error-capture-dispatch 1 (unmodified); heal-config 36
- feedback-webhook 13; feedback-prompt 3; feedback-key-ownership 5 skip (needs Postgres, expected locally)
- spawn-on-error 20; token-cap-coverage 3; counter-key-assignment-guard 3; session-start-senders-guard 7
- Diffs vs plan base are empty for `hub/src/{dispatch,ask,revanote,api,scheduler,db}`, `heal/route.ts`, `heal/sinks`, and both protected test files; `git grep -c gates:` unchanged (1 + 1). `tsc --noEmit`: no errors in touched files.

## Deviations from Plan
1. **[Order] RED not committed separately.** Sources and tests were written together against the behavior list; the test file passed on first run. No standalone red run was recorded.
2. **[Rule 3 - Blocking] `healUnifiedEnabled` moved to a leaf `heal/flag.ts`.** A static `heal/config.ts` import pulled the orchestrator controller graph into the dispatchers, and the unmodified `error-capture-dispatch.test.ts` (partial ws-registry mock) failed with `Export named 'broadcastToUser' not found`. `config.ts` now re-exports the function, so there is still one definition and `heal-config` passes unchanged. The dispatchers statically import `flag.ts` only.
3. **[Design] `run_id` is `''` on heal-path `dispatched`.** `HealOutcome` carries no run id; the only callers (`record.ts`, `feedback-webhook.ts`) fire-and-forget, and the ledger records the run.
4. **[Design] Dedupe key includes the project id** (`err:<project>:<fingerprint>`): the fingerprint is shared with prod `/api/sentry`, so fingerprint alone would collapse identical errors from two different apps.

## Residual / notes
- The error-capture sink writes the routing reason (e.g. `bound_session_unavailable`, `not_allowlisted`) as the error row `skip_reason`, not the literal string `no_routable_session`; the ledger outcome string is `no_routable_session`.
- Feedback deduped maps to `skipped/deduped` (the legacy feedback outcome type has no `noop`).
- `feedback-key-ownership` (DB) skipped locally; e2e needs Postgres.

## Known Stubs
None.

## Threat Flags
None. T-07-34..37 mitigated: foreign-tenant, deleted, rootless, PTY and identity-less bound sessions never receive a dispatch (tests for both sources); six-gate chain with lifetime key through the seam; no ensure-online hook on the ON path; existing fences retained.

## Self-Check: PASSED
All created files exist; commits 134830a and aedea47 present on the branch.

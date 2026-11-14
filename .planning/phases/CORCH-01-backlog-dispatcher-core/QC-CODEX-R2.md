# QC-CODEX-R2 (round 2 re-QC, Codex seat)

- Seat: Codex CLI v0.157.0, read-only by instruction (bypass-sandbox flag used for bun test; git HEAD ad5c461594961654ef13a7f77c474b2a74746c7f unchanged before/after, git status unchanged: only pre-existing untracked .planning files).
- Model line: model: gpt-6-astra, provider openai, reasoning effort medium
- Range reviewed: 87ee8ec..ad5c461
- VERDICT: CONTENT BLOCK
- END-OF-REVIEW present: yes

## Per-finding status (round 1)
| Finding | Status |
|---|---|
| Codex 1 (HIGH) | NOT FIXED (partial) |
| Codex 2 (HIGH) | FIXED |
| Codex 3 (MED) | FIXED |
| Codex 4 (MED) | FIXED |
| Codex 5 (MED) | FIXED |
| Codex 6 (MED) | FIXED |
| Claude 1 (MED) | FIXED |
| Claude 2 (MED) | FIXED |
| Claude 3 (LOW) | FIXED |
| Claude 4 (LOW) | NOT FIXED, documented deferral |
| Claude 5 (LOW) | NOT FIXED, accepted deferral (CORCH-09) |
| Claude 6 (LOW) | NOT FIXED, documented deferral |
| Claude 7 (LOW) | NOT FIXED, documented deferral |

Fixed: 7 of 9 non-deferred (Codex 2-6, Claude 1-3 = 8 FIXED; Codex 1 remains open). Count: 8 FIXED, 1 NOT FIXED (HIGH), 4 deferrals.

## Codex verdict verbatim

VERDICT: CONTENT BLOCK

Reviewed `87ee8ec..ad5c461`. One HIGH finding remains incompletely fixed.

1. **HIGH - Codex 1: NOT FIXED.** `hub/src/corch/dispatcher.ts:350`, `hub/src/dispatch/pipeline.ts:438`.
   The new conditional `markRunRunning` blocks previously ended runs, but does not serialize reclaim with sending. After it succeeds, the pipeline awaits `finalHaltCheck` at line 444. During that await, `reclaimRun` can end the run and remove its active hook; execution then resumes and sends at line 457 without checking cancellation. The actual sender also awaits channel lookup and message insertion before `ws.send` (`hub/src/heal/sinks/shared.ts:41`). This still permits an ended run to send an untracked prompt and overlap a retry.
   **Fix:** coordinate reclaim and sending with a per-run cancellation/serialization mechanism checked at the actual socket-write boundary. Add a real-pipeline regression that pauses after `markDispatched`, reclaims the run, resumes, and asserts zero sends. Current tests only check reclamation *before* the liveness check.

(Findings 2-9 FIXED, 10-13 deferrals as in table above; no further fix required.)

Validation: 209 tests passed, zero failed, across six CORCH suites and eight guard/auth suites, each run separately. Diff whitespace checks passed. No DDL changes, guard-test weakening, or additional security/flag-OFF regressions found in the fix delta. Database E2E tests were not run. No files changed.

New findings in fix delta: none beyond the residual Codex 1 (HIGH).

END-OF-REVIEW

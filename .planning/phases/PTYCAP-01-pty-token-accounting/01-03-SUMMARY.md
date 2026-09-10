---
phase: PTYCAP-01-pty-token-accounting
plan: 03
subsystem: usage-cost
tags: [postgres, security, path-traversal, testing]

requires:
  - phase: PTYCAP-01 plan 01
    provides: "PtyUsageEmitter, getTodayTokenTotal, resolveSessionDir/realPathContained reuse"
provides:
  - "hub/test/pty-usage-midflight-visibility.test.ts — SC-3 mid-flight visibility proof (DB-gated)"
  - "hub/test/no-hub-side-transcript-fs.test.ts — Pitfall-1 hub-side-fs guard canary"
  - "supervisor/test/pty-usage-path-containment.test.ts — ASVS V4 transcript path-escape negative test"
affects: [ptycap-phase-2-pty-preflight-gate]

tech-stack:
  added: []
  patterns: []

key-files:
  created:
    - hub/test/pty-usage-midflight-visibility.test.ts
    - hub/test/no-hub-side-transcript-fs.test.ts
    - supervisor/test/pty-usage-path-containment.test.ts
  modified: []

key-decisions:
  - "No production code touched — verification-only, exactly as planned."
  - "Fixed an off-by-one directory bug caught by actually running the new canary: REPO_ROOT was computed as one level too shallow (join(import.meta.dir, '..') instead of '..', '..'), which silently made the whole hub/src walk resolve to a non-existent directory and the matcher find zero offenders — including its own non-vacuous-ness proof. Caught immediately because the test was run, not just written."
  - "grep-based acceptance criteria are read literally: an early draft of pty-usage-midflight-visibility.test.ts's own comments contained the substring \"dispatch/gates\" (in prose explaining what it does NOT do), which would have made the plan's own 'grep -n dispatch/gates returns nothing' acceptance check fail. Reworded the comments to convey the same meaning without the literal substring."

patterns-established: []

requirements-completed: [SC-1, SC-3]

coverage:
  - id: D1
    description: "getTodayTokenTotal() climbs strictly monotonically across incremental pty-interactive writes with no session-close event, the final reading equals the exact cumulative sum, and an illustrative ceiling crossing is observable at the expected index."
    requirement: SC-3
    verification:
      - kind: integration
        ref: "hub/test/pty-usage-midflight-visibility.test.ts#the total climbs strictly monotonically with each incremental PTY write..."
        status: unknown
    human_judgment: true
    rationale: "REMO_E2E_DB_URL-gated; no disposable Postgres reachable in this local session (skips cleanly, 6 skip / 0 fail). Written to the same proven harness/sequencing pattern as hub/test/e2e/orchestrator-tokencap.e2e.test.ts; runs for real in Woodpecker's postgres:16 service."
  - id: D2
    description: "A cache-read-only record still increases getTodayTokenTotal() (the 2026-07 incident shape); a stream-json row shares the same aggregation path as pty-interactive."
    requirement: SC-3
    verification:
      - kind: integration
        ref: "hub/test/pty-usage-midflight-visibility.test.ts (same file/describe as D1)"
        status: unknown
    human_judgment: true
    rationale: "Same DB-gated caveat as D1."
  - id: D3
    description: "No NEW hub/src module reads a home-directory-derived transcript path; the pre-existing telegram/transcript allowlist is the only exception and its size is asserted."
    requirement: SC-1
    verification:
      - kind: unit
        ref: "hub/test/no-hub-side-transcript-fs.test.ts (4/4 pass)"
        status: pass
    human_judgment: false
  - id: D4
    description: "PtyUsageEmitter.start() refuses a relative/traversal/NUL-byte projectDir and a path-escaping located transcript, before any read, while still tailing a legitimate path normally."
    requirement: SC-1
    verification:
      - kind: unit
        ref: "supervisor/test/pty-usage-path-containment.test.ts (6/6 pass)"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-07-28
status: complete
---

# Phase 1, Plan 3: SC-3 Mid-Flight Visibility + the Two Security Guard Canaries

**The live token total is proven to climb mid-turn with no session-close event, and the
phase's two real risk surfaces — a hub-side home-directory read and a transcript
path-escape — are each closed by a dedicated negative test.**

## Performance
- **Started / Completed:** 2026-07-28
- **Tasks:** 3 of 3 completed
- **Files modified:** 3 (all new)

## Accomplishments
- `hub/test/pty-usage-midflight-visibility.test.ts`: proves `getTodayTokenTotal()` climbs
  strictly monotonically across incremental `pty-interactive` writes, with the exact
  cumulative sum as the final reading and an illustrative ceiling crossing observable at
  the expected index — all without any session-close/exit/kill event. Also proves
  `stream-json` rows share the same aggregation path and a cache-read-only record still
  counts (the 2026-07 incident shape). REMO_E2E_DB_URL-gated.
- `hub/test/no-hub-side-transcript-fs.test.ts`: a grep-based static canary (mirroring
  `supervisor/test/no-legacy-agent-spawn.test.ts`'s style) proving no new `hub/src/**` module
  reads a home-directory-derived path, with the single pre-existing allowlisted exception
  (`hub/src/telegram/transcript/`) asserted by size.
- `supervisor/test/pty-usage-path-containment.test.ts`: proves `PtyUsageEmitter.start()`
  fails closed on relative, traversal, and NUL-byte `projectDir` values, and on a located
  transcript whose real path escapes the projects base (simulated via the `projectsBase`
  seam rather than a Windows symlink) — while a legitimate path still tails normally.

## Task Commits
1. **Task 1: SC-3 — prove the live token total climbs mid-flight** — `4f665a3` (test)
2. **Task 2: Pitfall-1 guard canary** — `13edf22` (test)
3. **Task 3: ASVS V4 negative test** — `0a7054c` (test)

**Plan metadata:** tracking commit follows this SUMMARY.md.

## Files Created/Modified
- `hub/test/pty-usage-midflight-visibility.test.ts` — new, 6 tests, DB-gated.
- `hub/test/no-hub-side-transcript-fs.test.ts` — new, 4 tests, dependency-free.
- `supervisor/test/pty-usage-path-containment.test.ts` — new, 6 tests.

## Decisions Made
See `key-decisions` above — the REPO_ROOT off-by-one fix and the literal-grep comment reword.

## Deviations from Plan

### Auto-fixed Issues

**1. [Correctness] `no-hub-side-transcript-fs.test.ts`'s REPO_ROOT resolved one directory too shallow**
- **Found during:** Task 2, first test run (not written-then-assumed-correct).
- **Issue:** `join(import.meta.dir, '..')` from `hub/test` resolves to `hub`, not the repo
  root; `HUB_SRC` then pointed at a non-existent `hub/hub/src`, so the walk silently found
  zero files and even the "matcher is non-vacuous" proof failed with `0` offenders instead
  of the expected 2.
- **Fix:** `join(import.meta.dir, '..', '..')`.
- **Verification:** re-ran; 4/4 pass, including the two known-adapter assertions.
- **Committed in:** `13edf22` (fixed before the first commit of this task).

**2. [Correctness] A draft comment in `pty-usage-midflight-visibility.test.ts` contained the literal substring the plan's own acceptance grep checks for absence of**
- **Found during:** Task 1, while running the plan's own acceptance-criteria grep before committing.
- **Issue:** Explanatory prose said "not hub/src/dispatch/gates.ts's real cap", which
  literally matches `grep -n "dispatch/gates"` — the exact string the acceptance criterion
  requires to return NOTHING (proving no gate is imported or invoked). A comment mentioning
  the concept in passing would have failed a check meant to catch code, not prose.
- **Fix:** reworded to "not the real production cap" — same meaning, no literal match.
- **Verification:** `grep -n "dispatch/gates" hub/test/pty-usage-midflight-visibility.test.ts` now returns nothing.
- **Committed in:** `4f665a3` (fixed before the first commit of this task).

---

**Total deviations:** 2 auto-fixed (both correctness, both caught by actually running the
plan's own verification commands rather than trusting the first draft). **Impact on plan:**
necessary corrections, no scope creep.

## Issues Encountered
Same DB-gated caveat as plan 01-02: the mid-flight visibility suite's DB-gated cases are
written and reviewed against the established harness pattern but not executed against a
live Postgres in this session — recorded as `human_judgment: true` rather than silently
claimed verified.

## User Setup Required
None.

## Next Phase Readiness
Plan 01-04 (wire the SC-1 proof into CI, re-measure the baseline, write docs) depends on
this plan (and 01-01/01-02) and is ready to proceed — it is the last plan in this phase.

---
*Phase: PTYCAP-01-pty-token-accounting*
*Completed: 2026-07-28*

# Phase 7 (PTYCAP) Plan Check

Verdict: PASS (0 BLOCKER, 4 WARN). Checked 07-01..07-11 against 07-SPEC, 07-VALIDATION, GATES/verdict.md (LOCKED), ROADMAP Phase 7 SC1-5.

## Checks
- Waves/deps: W1 = 01,02,03,04 (files disjoint; 04 owns inject.ts/launch.ts, 02 owns schema/dal files, 03 test-only). W2 = 05. W3 = 06,07 (route/notify/sweep/index vs sinks/error-capture dispatcher: disjoint). W4 = 08,09 (coolify/scheduler vs error-capture/feedback: disjoint). W5 = 10. W6 = 11. Cross-wave re-edits (route.ts 05->06, error-capture/dispatcher.ts 07->09, counter-key guard 05->10, heal-flag-off 03->10) are all dependency-ordered.
- Symbols/paths: all referenced existing files exist (inject.ts maybeAutospawnOffline, telegram/launch.ts, dispatch/pipeline.ts ensureOnline, scheduler/dispatcher.ts onRunFinalized/only_if_active, post-run/dispatcher.ts, repo-key.ts, the four guard tests, schema-double-apply e2e, baseline json). hub/src/heal does not exist yet (created by the plans, as intended).
- SC1-5 and AM-F1..F5 each map to a task plus a concrete `bun test` command (07-VALIDATION tables verified against plan bodies).
- Flag-OFF true no-op: 07-03 records literal legacy traces on unmodified code across unset/empty/0/false/maybe/garbage plus a static-import ban; 07-08/09 use lazy dynamic import inside the flag-ON branch; 07-10 re-runs unchanged.
- schema.sql: 07-02 is additive only (IF NOT EXISTS); lint + double-apply e2e + diff pin forbid any data-modifying or destructive statement.
- token-cap-coverage and counter-key guard updates: 07-05 (route.ts allowlist) and 07-10 (coverage, session-start, launch-callers).
- Prod: nothing touches prod; no push/deploy/flag-arming steps; flag stays OFF, allowlist EMPTY; 07-11 pins no hub/src, supervisor, or web diff.

## Issues
1. WARN - 07-06 T3: the "flag-OFF boot is a no-op" check for the sweep in index.ts is a source-text pin only (guarded branch), not behavioral. 07-10 flag-OFF suite should also assert sweepStaleHealLaunches is never invoked when OFF, if cheap.
2. WARN - 07-04 intentionally leaves orchestrator ordering (gates after spawn) unchanged; recorded residual, within the verdict (reorder scoped to heal).
3. WARN - 07-03 mocks many collaborators in one file; Bun mock.module pollution risk (feedback_bun_mock_pollution). check-baseline runs per-file so safe, but use cache-bust + afterAll(mock.restore).
4. WARN - 07-11 re-measures regression-baseline.json; must not lower fail_max or counts to hide skips (plan already states this; executor discipline).

## Fixes applied
None required (no BLOCKERs).

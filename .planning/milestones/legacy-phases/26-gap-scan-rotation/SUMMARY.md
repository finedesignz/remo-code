# Phase 26 — gap-scan-rotation · SUMMARY

**Status:** Complete (PASS) · commit `199e7f1` on `feat/auto-dev-orchestrator`

LRU dimension wheel for the `gap-scan` command so coverage rotates across all aspects over successive runs, tracked in the run log.

## Delivered
- `hub/src/orchestrator/gap-rotation.ts` — 8-dimension wheel (security, performance, accessibility, test-coverage, dependency-hygiene, error-handling, docs-drift, type-safety); `nextGapDimensions(recentRunLog, count=1)` LRU pick (empty→security; staler-first, wheel-order tie-break; full cycle before repeat); `DIMENSION_AGENTS` dimension→specialist map.
- `command-prompts.ts` — gap-scan prompt branch embeds the chosen dimension + mapped specialist + `gap_dimension:` in the `<<UNIT>>` report.
- `wave-runner.ts` — live seam picks the dimension via `recentRunLog` and persists it (existing `runUnit`→`appendRunLog`→`routine_run_log.gap_dimension`).

## Safety
Pure logic + prompt composition; flag-OFF; no hub-side gh/git; reuses run-log.

## Verification
36 pass / 0 fail; baseline 1397 / 0 fail.

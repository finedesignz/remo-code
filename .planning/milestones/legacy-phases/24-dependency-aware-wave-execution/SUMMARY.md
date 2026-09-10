# Phase 24 — dependency-aware-wave-execution · SUMMARY

**Status:** Complete (PASS, 3/3) · commits `d9070da`, `3314df1` on `feat/auto-dev-orchestrator`

Wave orchestration logic + per-unit finish→PR→reviewer protocol. Execution seams stubbed (Phases 25/28/29); behavior flag-OFF.

## Delivered
- `hub/src/orchestrator/waves.ts` — pure `planWaves(commands)`: Kahn levelization over `COMMAND_DEPS` (plan→execute→ship; audit-fix/gap-scan/code-review independent; merge-to-main excluded; ship/complete-milestone/tag = propose). Intra-wave priority DESC + stable order (reuses P22 `CyclePriority`). Caps `MAX_WAVES=16`, `MAX_UNITS_PER_WAVE=32`, cycle-guarded.
- `hub/src/orchestrator/wave-runner.ts` — `runWavePlan(plan, ctx, seams=STUB_SEAMS)`: waves sequential, units parallel via `Promise.allSettled`. Per-unit: executeCommand→createPrForUnit→dispatchReviewer→one `appendRunLog`. Propose units → `proposeToChat` + outcome=proposed (no execute/PR/merge). Seam throw → outcome=failed, isolated.
- `controller.ts` — `runWaves` now calls the real planner+runner (was no-op).

## Seam → phase map (all inert stubs now)
`executeCommand` + `createPrForUnit` → Phase 25 · `dispatchReviewer` → reviewer dispatch · `proposeToChat` → Phase 28 · `merge-to-main` → Phase 29 (excluded from planner).

## Safety
`REMO_ORCHESTRATOR_ENABLED` default OFF + `STUB_SEAMS` inert (no gh/network/git/merge) ⇒ zero prod behavior. Grep-confirmed no real shell/network calls.

## Verification
15 pass / 0 fail; baseline 1361 / 0 fail. DB e2e deferred (no PG host).

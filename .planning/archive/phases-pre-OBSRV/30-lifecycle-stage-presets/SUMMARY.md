# Phase 30 — lifecycle-stage-presets · SUMMARY

**Status:** Complete (PASS) · commits `aa2be26`, `7f6f6de` on `feat/auto-dev-orchestrator`

Per-stage default row-frequency presets so cadence/command-mix adapts to the app's maturity.

## Delivered
- `hub/src/orchestrator/stage-presets.ts` — `STAGE_PRESETS` table (development / beta / production-maintenance), each a list of `{command, enabled, frequency_label, schedule_rule}` with valid ScheduleRules; Never rows = disabled+null cadence. Pure `presetRowsForStage(stage)` + `normalizeStage` (unknown→development). `applyStagePreset(taskId, stage, {overwrite})`: default inserts only missing preset commands (never clobbers user customizations); overwrite updates preset rows + inserts missing; extra user rows untouched.
- `orchestrator-rows-dal.ts` — `updateOrchestratorRowFields(id, patch)`.

## Presets (cadences)
- **development** (build): plan 6h · execute 3h · audit-fix 12h · gap daily · code-review daily · verify 2d · milestone/ship/merge Never.
- **beta** (QC): plan 2d · execute daily · audit-fix 6h · gap 8h · code-review 8h · verify 6h · ship weekly · milestone/merge Never.
- **production-maintenance** (maintain): plan/execute Never · audit-fix weekly · gap weekly (security-weighted) · code-review 2wk · verify 3d · merge 2wk · milestone/ship Never.

## Verification
20 pass / 5 skip (e2e) / 0 fail; baseline 1457 / 0 fail. Pure config + DB helper; no live behavior.

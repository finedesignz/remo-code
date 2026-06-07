# Phase 30 — lifecycle-stage-presets — PLAN

Reqs: R-ADO-26 (per-stage frequency presets, data not hardcoded behavior),
R-ADO-27 (apply preset, overridable; overrides persist). Locked decision D10.
Depends on: Phase 23 (controller + due-rows + DAL). SPEC §1.10, §3, §5.

## Assumptions (stated up front)
- `lifecycle_stage ∈ {development, beta, production-maintenance}` already exists
  (`scheduled_tasks.lifecycle_stage`, P21). `orchestrator_rows` + DAL exist (P21).
- Preset rows are pure DATA: a `stage → OrchestratorRow-ish[]` map. No controller
  behavior changes; the controller's due-row logic (P23) already interprets
  `frequency_label` (`Never`/`Once`) + `schedule_rule`. This phase only seeds rows.
- "Never" row = `{ enabled:false, frequency_label:'Never', schedule_rule:null }`
  (matches P23 `FREQ_NEVER` → not-due + disabled).
- All non-Never rows carry a VALID `ScheduleRule` (validated by `validateRule`).
  `start_at` is a fixed past anchor so cadence is satisfied; the controller gates
  fires by cadence/window/bounds. We use a stable anchor constant.
- The implicit `status-check/decide` (first) + `deploy+log-verify` (terminal) rows
  are ALWAYS-ON implicit (SPEC §3) — NOT user rows — so they are NOT in the preset
  table. (prod-maintenance "mostly deploy+log-verify" = the implicit terminal row
  is always on; the preset just makes build/plan Never and keeps a security gap-scan.)

## Default command set (SPEC §3 user-configurable rows)
gsd-plan-phase · gsd-execute-phase · gsd-audit-fix · gap-scan · gsd-code-review ·
gsd-verify-work · gsd-complete-milestone · gsd-ship · merge-to-main

## Cadences (documented; all valid ScheduleRule shapes)

### development — bias to building
| command | label | rule |
|---|---|---|
| gsd-plan-phase | Every 6h | interval 6, hours |
| gsd-execute-phase | Every 3h | interval 3, hours |
| gsd-audit-fix | Every 12h | interval 12, hours |
| gap-scan | Daily | interval 1, days |
| gsd-code-review | Daily | interval 1, days |
| gsd-verify-work | Every 2 days | interval 2, days |
| gsd-complete-milestone | Never | disabled |
| gsd-ship | Never | disabled |
| merge-to-main | Never | disabled |

### beta — bias to QC
| command | label | rule |
|---|---|---|
| gsd-plan-phase | Every 2 days | interval 2, days |
| gsd-execute-phase | Daily | interval 1, days |
| gsd-audit-fix | Every 6h | interval 6, hours |
| gap-scan | Every 8h | interval 8, hours |
| gsd-code-review | Every 8h | interval 8, hours |
| gsd-verify-work | Every 6h | interval 6, hours |
| gsd-complete-milestone | Never | disabled |
| gsd-ship | Weekly | interval 1, weeks (propose-tier; rare) |
| merge-to-main | Never | disabled |

### production-maintenance — bias to maintenance
| command | label | rule |
|---|---|---|
| gsd-plan-phase | Never | disabled (on-demand) |
| gsd-execute-phase | Never | disabled (on-demand) |
| gsd-audit-fix | Weekly | interval 1, weeks |
| gap-scan | Weekly | interval 1, weeks (security-weighted, micro_prompt) |
| gsd-code-review | Every 2 weeks | interval 2, weeks |
| gsd-verify-work | Every 3 days | interval 3, days |
| gsd-complete-milestone | Never | disabled |
| gsd-ship | Never | disabled |
| merge-to-main | Every 2 weeks | interval 2, weeks (rare) |

(deploy+log-verify implicit terminal row is always-on, not a preset row.)

## Deliverables
1. `hub/src/orchestrator/stage-presets.ts`
   - `STAGE_PRESET_ANCHOR` past ISO start_at constant.
   - `PRESET_ROWS: Record<LifecycleStage, PresetRow[]>` data table.
   - `presetRowsForStage(stage): PresetRow[]` — pure, deterministic; unknown →
     development. `PresetRow = { command, enabled, frequency_label, schedule_rule, micro_prompt?, sort_order }`.
   - `applyStagePreset(taskId, stage, { overwrite }): Promise<...>` — DB apply.
     Merge policy:
       - overwrite=false (DEFAULT): insert ONLY preset commands not already present
         for this task (never clobbers user customizations). Returns {inserted,updated,skipped}.
       - overwrite=true: for each preset command, UPDATE the existing row's
         enabled/frequency_label/schedule_rule/micro_prompt/sort_order, else INSERT.
         User-added EXTRA rows (commands not in preset) are left untouched.
2. DAL additions (`hub/src/db/orchestrator-rows-dal.ts`):
   - `updateOrchestratorRowFields(id, patch)` — thin typed UPDATE (enabled,
     schedule_rule, frequency_label, micro_prompt, sort_order).
3. `hub/test/orchestrator-stage-presets.test.ts`
   - pure: each stage returns documented row set; valid ScheduleRules
     (`validateRule`); Never rows disabled+label; determinism; unknown→development.
   - env-gated (REMO_E2E_DB_URL) e2e: applyStagePreset insert vs overwrite policy.

## Karpathy / constraints
- Smallest diff: data table + 1 apply helper + 1 tiny DAL update fn. No controller
  edits, no flag, no gh/git, no wiring. Reuse ScheduleRule + DAL. Exactly 3 stages.
- Inert w.r.t. live path: nothing registers/fires. Pure config + apply helper.

## Success criteria (verifiable)
- `bun test hub/test/orchestrator-stage-presets.test.ts` green (pure layer).
- `JWT_SECRET=test_secret_at_least_32_chars_long_xx bun run check-baseline`
  fail=0, within tolerance.

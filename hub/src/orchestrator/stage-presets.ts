// hub/src/orchestrator/stage-presets.ts
// Phase 30 (auto-dev-orchestrator) — per-lifecycle-stage default row-frequency
// PRESETS (locked decision D10; SPEC §1.10, §3, §5).
//
// Reqs:
//   R-ADO-26 — each lifecycle_stage ships a default row-frequency preset; presets
//              are DATA (a stage → row-frequency map), NOT hardcoded controller
//              behavior.
//   R-ADO-27 — applying a preset fills default row frequencies; the user can
//              override any row afterward and overrides persist.
//
// SCOPE: the preset table + `presetRowsForStage` are PURE (no DB, no clock, no
// network) so the UI (Phase 31) and tests can consume them directly.
// `applyStagePreset` is the only DB-touching export. NOTHING here is wired into
// the live controller path — it only seeds `orchestrator_rows`. The controller
// (Phase 23 `due-rows.ts`) already interprets `frequency_label` (`Never`/`Once`)
// and `schedule_rule` cadence; this phase just supplies the default rows.
//
// Stage biases (SPEC §1.10):
//   development            — bias to BUILDING: frequent plan/execute + gap-scan;
//                            audit-fix regular; review/verify lighter;
//                            milestone/ship/merge = Never (manual).
//   beta                   — bias to QC: heavy audit-fix/code-review/verify/gap;
//                            plan/execute lighter; ship rare (propose-tier).
//   production-maintenance — bias to MAINTENANCE: security-weighted gap-scan +
//                            occasional audit-fix; plan/execute = Never
//                            (on-demand); ship/merge rare. (The always-on
//                            implicit deploy+log-verify terminal row — SPEC §3 —
//                            is NOT a preset row; it fires every tick regardless.)

import type { LifecycleStage } from '../db/orchestrator-rows-dal.ts';
import {
  insertOrchestratorRow,
  listOrchestratorRows,
  updateOrchestratorRowFields,
} from '../db/orchestrator-rows-dal.ts';
import type { ScheduleRule, ScheduleUnit } from '../scheduler/schedule-rules.ts';

export type { LifecycleStage } from '../db/orchestrator-rows-dal.ts';

/**
 * Fixed past anchor for every preset `schedule_rule.start_at`. Cadence/window/
 * bounds are evaluated by the scheduler at run time relative to `now`; a past
 * anchor simply means "already started, fire on cadence". Stable so presets are
 * deterministic (no `Date.now()` in the data layer).
 */
export const STAGE_PRESET_ANCHOR = '2026-01-01T00:00:00.000Z';

/** A preset row — the user-overridable subset of an `orchestrator_rows` row. */
export interface PresetRow {
  command: string;
  enabled: boolean;
  /** Human label; `'Never'` ⇒ parked/disabled (P23 `FREQ_NEVER`). */
  frequency_label: string;
  /** null ⇒ no cadence (only valid together with the `'Never'` label). */
  schedule_rule: ScheduleRule | null;
  /** Optional free text appended to the command's prompt (e.g. security focus). */
  micro_prompt?: string | null;
  sort_order: number;
}

/** Build a valid cron-equivalent ScheduleRule anchored at STAGE_PRESET_ANCHOR. */
function every(interval: number, unit: ScheduleUnit): ScheduleRule {
  return { interval, unit, start_at: STAGE_PRESET_ANCHOR };
}

/** A parked (Never) row: disabled, no cadence. */
function never(command: string, sort_order: number): PresetRow {
  return { command, enabled: false, frequency_label: 'Never', schedule_rule: null, sort_order };
}

/** An active row with a cadence label + rule. */
function on(
  command: string,
  frequency_label: string,
  rule: ScheduleRule,
  sort_order: number,
  micro_prompt?: string,
): PresetRow {
  return { command, enabled: true, frequency_label, schedule_rule: rule, sort_order, micro_prompt };
}

// The SPEC §3 user-configurable command set (implicit status-check/deploy-verify
// rows are NOT here — they are always-on, not preset rows). Sort order follows
// the lifecycle order so the UI table reads top-to-bottom.
const SECURITY_GAP_PROMPT =
  'Weight this gap-scan toward security: dependency CVEs, auth/permission regressions, ' +
  'secret exposure, and input-validation gaps for a production app in maintenance.';

const DEVELOPMENT: PresetRow[] = [
  on('gsd-plan-phase', 'Every 6h', every(6, 'hours'), 0),
  on('gsd-execute-phase', 'Every 3h', every(3, 'hours'), 1),
  on('gsd-audit-fix', 'Every 12h', every(12, 'hours'), 2),
  on('gap-scan', 'Daily', every(1, 'days'), 3),
  on('gsd-code-review', 'Daily', every(1, 'days'), 4),
  on('gsd-verify-work', 'Every 2 days', every(2, 'days'), 5),
  never('gsd-complete-milestone', 6),
  never('gsd-ship', 7),
  never('merge-to-main', 8),
];

const BETA: PresetRow[] = [
  on('gsd-plan-phase', 'Every 2 days', every(2, 'days'), 0),
  on('gsd-execute-phase', 'Daily', every(1, 'days'), 1),
  on('gsd-audit-fix', 'Every 6h', every(6, 'hours'), 2),
  on('gap-scan', 'Every 8h', every(8, 'hours'), 3),
  on('gsd-code-review', 'Every 8h', every(8, 'hours'), 4),
  on('gsd-verify-work', 'Every 6h', every(6, 'hours'), 5),
  never('gsd-complete-milestone', 6),
  // ship is propose-tier (D5) — rare cadence makes the controller SURFACE a
  // proposal, it does not auto-ship.
  on('gsd-ship', 'Weekly', every(1, 'weeks'), 7),
  never('merge-to-main', 8),
];

const PRODUCTION_MAINTENANCE: PresetRow[] = [
  // build is on-demand only in maintenance.
  never('gsd-plan-phase', 0),
  never('gsd-execute-phase', 1),
  on('gsd-audit-fix', 'Weekly', every(1, 'weeks'), 2),
  on('gap-scan', 'Weekly', every(1, 'weeks'), 3, SECURITY_GAP_PROMPT),
  on('gsd-code-review', 'Every 2 weeks', every(2, 'weeks'), 4),
  on('gsd-verify-work', 'Every 3 days', every(3, 'days'), 5),
  never('gsd-complete-milestone', 6),
  never('gsd-ship', 7),
  on('merge-to-main', 'Every 2 weeks', every(2, 'weeks'), 8),
];

/** The authoritative stage → preset-rows table (R-ADO-26 — data, not behavior). */
export const PRESET_ROWS: Readonly<Record<LifecycleStage, readonly PresetRow[]>> = Object.freeze({
  development: DEVELOPMENT,
  beta: BETA,
  'production-maintenance': PRODUCTION_MAINTENANCE,
});

const VALID_STAGES: ReadonlySet<string> = new Set<LifecycleStage>([
  'development',
  'beta',
  'production-maintenance',
]);

/** Normalize an arbitrary input to a known stage; unknown ⇒ `development`. */
export function normalizeStage(stage: unknown): LifecycleStage {
  const s = typeof stage === 'string' ? stage.trim() : '';
  return (VALID_STAGES.has(s) ? s : 'development') as LifecycleStage;
}

/**
 * PURE: the default preset rows for a stage. Unknown/invalid stage falls back to
 * `development`. Returns fresh shallow copies so callers may safely mutate them
 * (e.g. set `task_id`) without touching the frozen table.
 */
export function presetRowsForStage(stage: unknown): PresetRow[] {
  const s = normalizeStage(stage);
  return PRESET_ROWS[s].map((r) => ({ ...r }));
}

export interface ApplyPresetResult {
  stage: LifecycleStage;
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Apply a stage preset to a task's `orchestrator_rows` (R-ADO-27).
 *
 * Merge policy (overrides MUST persist):
 *   - overwrite = false (DEFAULT): insert ONLY preset commands that don't already
 *     have a row for this task. Existing rows — including user customizations —
 *     are left exactly as-is (skipped). This is the "fill defaults, never clobber"
 *     behavior.
 *   - overwrite = true: for each preset command, if a row already exists, UPDATE
 *     its enabled / frequency_label / schedule_rule / micro_prompt / sort_order to
 *     the preset value; otherwise INSERT it. User-added EXTRA rows whose command
 *     is NOT in the preset are left untouched in both modes.
 *
 * Reuses the Phase-21 DAL only; no behavior is fired.
 */
export async function applyStagePreset(
  taskId: string,
  stage: unknown,
  opts: { overwrite?: boolean } = {},
): Promise<ApplyPresetResult> {
  const normalized = normalizeStage(stage);
  const overwrite = opts.overwrite === true;
  const rows = presetRowsForStage(normalized);

  const existing = await listOrchestratorRows(taskId);
  const byCommand = new Map(existing.map((r) => [r.command, r]));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of rows) {
    const current = byCommand.get(r.command);
    if (current) {
      if (overwrite) {
        await updateOrchestratorRowFields(current.id, {
          enabled: r.enabled,
          schedule_rule: r.schedule_rule,
          frequency_label: r.frequency_label,
          micro_prompt: r.micro_prompt ?? null,
          sort_order: r.sort_order,
        });
        updated++;
      } else {
        skipped++;
      }
      continue;
    }
    await insertOrchestratorRow({
      task_id: taskId,
      command: r.command,
      enabled: r.enabled,
      schedule_rule: r.schedule_rule,
      frequency_label: r.frequency_label,
      micro_prompt: r.micro_prompt ?? null,
      sort_order: r.sort_order,
    });
    inserted++;
  }

  return { stage: normalized, inserted, updated, skipped };
}

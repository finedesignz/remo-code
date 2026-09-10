# Phase 31 — web-orchestrator-editor — PLAN

Goal: web UI + hub REST to CONFIGURE (not run) the one-per-session orchestrator task + its
`orchestrator_rows`. Flag-OFF data path. Reuse existing task UI components + `ScheduleRulesBuilder`.

## Assumptions (verified)
- P21 shipped: `scheduled_tasks.task_type` includes `orchestrator`, partial unique index
  `idx_scheduled_tasks_orchestrator_unique (session_id) WHERE task_type='orchestrator'`,
  `lifecycle_stage` col (development|beta|production-maintenance). `orchestrator_rows` table
  (id, task_id FK CASCADE, command, enabled, schedule_rule JSONB, frequency_label, micro_prompt, sort_order).
- P21 DAL `hub/src/db/orchestrator-rows-dal.ts`: `insertOrchestratorRow`, `listOrchestratorRows`,
  `updateOrchestratorRowFields`. MISSING: delete-row, get/create the orchestrator task. Add them.
- P30 `hub/src/orchestrator/stage-presets.ts`: `presetRowsForStage`, `applyStagePreset(taskId, stage, {overwrite})`,
  `normalizeStage`, `PresetRow`. Reuse directly.
- Known command set (SPEC §3): gsd-plan-phase, gsd-execute-phase, gsd-audit-fix, gap-scan,
  gsd-code-review, gsd-verify-work, gsd-complete-milestone, gsd-ship, merge-to-main. Plus `micro_prompt` rows.
- `ScheduleRulesBuilder` (web/src/components/ScheduleRulesBuilder.tsx) takes {rules, timezone, onChange};
  blue accent; NO Never/Once. Never/Once is a frequency-MODE wrapper ABOVE it (my code), not an edit to it.
- Existing `orchestrator.ts` route = the orchestrator-SESSION feature (different). New router lives at
  `/api/orchestrator-tasks` to avoid overloading it + avoid the scheduled-tasks Zod enum (no `orchestrator`).

## Hub (smallest diff)
1. `orchestrator-rows-dal.ts`: add `deleteOrchestratorRow(id)`,
   `getOrchestratorTaskForSession(userId, sessionId)`, `createOrchestratorTaskForSession(userId, sessionId, stage?)`,
   `updateOrchestratorTaskStage(taskId, userId, stage)`, `getOrchestratorRowById(id)` (ownership join).
   All scoped by user_id via join to scheduled_tasks.
2. NEW route `hub/src/api/orchestrator-tasks.ts` (Hono), Zod-validated:
   - `GET  /api/orchestrator-tasks/:sessionId` → { task, rows } (task null if none).
   - `POST /api/orchestrator-tasks/:sessionId` → create (one-per-session; 409 on dup, catch unique-violation).
   - `PATCH /api/orchestrator-tasks/:taskId` → { lifecycle_stage }.
   - `POST /api/orchestrator-tasks/:taskId/apply-preset` → { stage, overwrite? } → applyStagePreset.
   - `GET  /api/orchestrator-tasks/:taskId/rows` (covered by GET above; rows CRUD below)
   - `POST /api/orchestrator-tasks/:taskId/rows` → add command|micro_prompt row (validate command in known set OR micro_prompt present).
   - `PATCH /api/orchestrator-tasks/rows/:rowId` → enabled|schedule_rule|frequency_label|micro_prompt|sort_order.
   - `DELETE /api/orchestrator-tasks/rows/:rowId`.
   - `POST /api/orchestrator-tasks/:taskId/rows/reorder` → ordered [rowId...] → bulk sort_order.
   frequency_label allows Never|Once|<cadence>. Mount in index.ts BEFORE the `/api/*` catch-all? No —
   it is an authed user route, so mount it alongside other authed routes (after auth, like scheduled-tasks),
   NOT a public webhook. "Mount before auth catch-all" in the brief = standard authed mount position (post-auth,
   pre-SPA-fallthrough), same as `/api/scheduled-tasks`. Confirmed by reading index.ts: scheduled-tasks etc.
   mount after the `/api/*` auth middleware. We do the same.
3. OpenAPI: register paths in `_openapi.ts`; run `bun run docs:sync`.

## Web (reuse)
- `web/src/hooks/useOrchestrator.ts` mirroring `useSchedules` (fetch task+rows, create, setStage, applyPreset,
  addRow, updateRow, deleteRow, reorder).
- `web/src/pages/tasks/OrchestratorTab.tsx`: session picker (reuse sessions list) OR taskless empty-state +
  "Enable orchestrator" → create. Stage selector + Apply preset. Expandable standard-prompt panel (explanatory
  text from SPEC §4). Row table: command name · FrequencyControl · enabled toggle · up/down reorder · delete.
  "+ Add command" (select from known set), "+ Add micro-prompt" (free text).
- `web/src/components/orchestrator/FrequencyControl.tsx`: mode select {Never, Once, Custom}.
  Never → frequency_label='Never', schedule_rule=null. Once → 'Once', schedule_rule=null. Custom →
  wraps `ScheduleRuleRow` (single rule) → frequency_label=humanizeRule, schedule_rule=rule.
- Mount OrchestratorTab into TasksPage (a small in-page toggle/section, NOT new top-nav — keep diff small).
- Blue accent only. No indigo.

## Tests
- `hub/test/orchestrator-tasks.route.test.ts`: boot real app, assert routes mounted + authed (401 unauth),
  one-per-session 409 path (unit-test the create catching unique violation via DAL mock), Never/Once accepted,
  apply-preset shape. Run in isolation (mock.module pollution note).
- `web/test/no-indigo.test.ts` must still pass (no new indigo).
- Reuse stage-presets pure functions in a small assertion if useful.

## QC
`bun run build:web` · `bun test <new files>` · `bun run check-baseline` (JWT_SECRET set) · `bun run docs:sync` (commit regen).

## Karpathy
Smallest diff. Reuse ScheduleRuleRow + stage-presets + DAL. No fork of ScheduleRulesBuilder. No speculative
fields. Never/Once is a thin wrapper. No live/controller wiring (flag-off — config only).

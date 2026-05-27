# Phase 11 — Structured Task Workflows + Runtime Context Injection

Status: planning only. No implementation in this commit.
Owner: TBD. Branch: `feat/phase-11-structured-task-workflows` (off `origin/main`, dedicated worktree per project CLAUDE.md).

## 1. Goals

1. Collapse the scheduled-task type enum from six options to **three**: `dev`, `security`, `log_check`. Remove `prompt` and `skill`. Rename `continue_dev` → `dev`. Keep `triage` as an internal kind (not user-pickable; it is synthesized by the Coolify webhook and the new `log-classify` chain step).
2. Reshape each user-pickable type into a **3-step chained workflow** glued together via the existing `chain_task` post-run action (`hub/src/scheduler/post-run/chain.ts`). Each step has its own prompt template, its own run row, its own cost, and its own next-step chain edge.
3. Add a **runtime context injection** pass to the agent sender so every scheduled run is prepended with a `## RUNTIME CONTEXT` block built from hub-side data — never user-edited.
4. Persist the exact context that was sent on each run in a new `runtime_context_snapshot` JSONB column on `scheduled_task_runs` for audit + repro.
5. Migrate existing user-owned `prompt` and `skill` rows to `dev` with their current prompt preserved verbatim (no data loss).
6. Compact the type picker UX to a single `<select>` dropdown.

## 2. Non-goals

- No change to cron grammar, croner integration, target resolution (`targets.ts`), session-queue (`session-queue.ts`), grace replay (`grace.ts`), catchup (`catchup.ts`), or fan-out semantics.
- No change to the `triage` task contract (`triage-schema.ts`, `triage-prompt.ts`) or to the Coolify webhook ingress.
- No removal of the daily cost cap or any other dispatcher gate (`enforceCostCap` in `dispatcher.ts`).
- No change to the supervisor wire protocol or agent socket framing.
- No multi-agent orchestration. Each chain step is a single-session scheduled run; chaining is purely the existing `chain_task` edge.
- No editable templates in DB for v1 — templates ship as repo `.md` files. Per-task override slots are noted as an open question (§9).

## 3. Affected files

### 3.1 Hub — enum + types

- `hub/src/api/scheduled-tasks.ts` — line 42, replace `TaskTypeEnum`.
- `hub/src/db/scheduled-tasks-dal.ts` — line 14, narrow `TaskType` to `'dev' | 'security' | 'log_check' | 'triage'`.
- `hub/src/db/schema.sql` — line 170, replace `CHECK (task_type IN ...)` constraint; add migration to rewrite legacy rows (§4).
- `hub/src/scheduler/auto-name.ts` — line 17 + 50, drop `prompt`/`skill`/`continue_dev` cases, add `dev`/`security`. Auto-name still locked-prefix per `feedback`/`project_handoff_scheduler_autoname.md`.
- `hub/src/scheduler/types.ts` — narrow any task-kind union.
- `hub/src/scheduler/dispatcher.ts` — line 363, replace the `continue_dev` switch arm with `dev`, add `security` arm. Each arm still routes through `agent.send` (no new sender; the workflow IS three scheduled tasks chained, not three behaviors of one).

### 3.2 Hub — new workflow scaffolding

- `hub/src/scheduler/prompts/dev/plan.md` — step 1 template.
- `hub/src/scheduler/prompts/dev/execute.md` — step 2.
- `hub/src/scheduler/prompts/dev/ship.md` — step 3.
- `hub/src/scheduler/prompts/security/scan.md`
- `hub/src/scheduler/prompts/security/triage.md`
- `hub/src/scheduler/prompts/security/fix-or-issue.md`
- `hub/src/scheduler/prompts/log_check/pull.md`
- `hub/src/scheduler/prompts/log_check/classify.md` — wraps the 16-pattern regex gate; calls `log-classifier.ts` BEFORE LLM spend.
- `hub/src/scheduler/prompts/log_check/triage.md` — only fires if classify flags errors.
- `hub/src/scheduler/prompts/loader.ts` — sync FS read at boot (templates are static repo files); exports `loadStepPrompt(workflow, step)`. Templates are interpolated with the runtime-context vars from §3.4 plus a `{{user_prompt}}` slot (user free-form text).

### 3.3 Hub — chain wiring

- `hub/src/scheduler/workflow.ts` (NEW) — declares the canonical step ordering per workflow as a constant table, e.g. `WORKFLOWS = { dev: ['plan','execute','ship'], security: ['scan','triage','fix-or-issue'], log_check: ['pull','classify','triage'] }`. The dispatcher does NOT auto-chain on this table; chain edges are still stored in `scheduled_tasks.post_run_actions` (see §9 open question — auto-create the three rows on workflow creation vs require the user to declare each step).
- `hub/src/scheduler/log-classifier.ts` (NEW per CLAUDE.md "Pending" note — it is still unshipped on this branch) — 16-pattern regex gate. Called from the `log_check.classify` step. If no patterns match, the chain emits the existing `'cost_exceeded'`-style skip path (we add a new `on: 'classifier_clean'` discriminant — see §9, may collapse into `'success'` with a payload flag).

### 3.4 Hub — runtime context

- `hub/src/scheduler/context/project-type.ts` (NEW) — detects `project_type` from session repo contents. Heuristics in priority order:
  1. `tauri.conf.json` exists → `tauri`.
  2. `next.config.{ts,js}` exists → `next-fullstack`.
  3. `package.json` has `vite` in deps + `index.html` at root → `vite-spa`.
  4. `Cargo.toml` exists + no `tauri.conf.json` → `rust-service`.
  5. `Dockerfile` only → `dockerized-service`.
  6. `pyproject.toml` or `requirements.txt` → `python-service`.
  7. Else → `unknown`.
- `hub/src/scheduler/context/deploy-target.ts` (NEW) — `coolify` if a Coolify app is linked to the session/user (lookup table TBD — see §9); `tauri-multi-platform` if the repo has any `supervisor-v*` tags via supervisor inventory; else `none`.
- `hub/src/scheduler/context/version.ts` (NEW) — `current_version`, `latest_tag`, `mode` (`pre-v1` if no `v*` tag with major ≥ 1, else `post-v1`). Reads via supervisor inventory cache.
- `hub/src/scheduler/context/global-rules-digest.ts` (NEW) — static module exporting a short digest string (Titanium auth, Postgres on Coolify, emails4agents, gateway pair, rule #13a verifier gate). Hand-maintained; not parsed from `~/.claude/CLAUDE.md` (security: we never read host home dirs from hub).
- `hub/src/scheduler/context/design-preferences.ts` (NEW) — reads a repo-vendored copy at `docs/design-preferences.md` if present, else returns empty string. NOT `~/.claude/design-preferences.md` (same reason).
- `hub/src/scheduler/context/build.ts` (NEW) — single entry point `buildRuntimeContext(task, target): Promise<RuntimeContext>`. Returns the JSON object persisted to `scheduled_task_runs.runtime_context_snapshot`.

### 3.5 Hub — agent sender

- `hub/src/scheduler/senders/agent.ts` — extend `buildContent(task)` into `buildContent(task, runtimeCtx)` (or wrap `sentContent` assembly). Order is: `## RUNTIME CONTEXT\n<rendered block>\n\n## TASK\n<template-rendered prompt>\n\n<summaryDirective>`. The **stored** content (`storedContent`) stays `[scheduled: <name>]\n\n<template-rendered prompt>` — runtime context is NOT persisted to `messages` (per the existing invariant on line ~75 of `agent.ts` that the runtime-only directive never enters chat history). It IS persisted to `runtime_context_snapshot` for audit.

### 3.6 Hub — runs

- `hub/src/db/schema.sql` — add `runtime_context_snapshot JSONB` to `scheduled_task_runs`, nullable, default `NULL` (so historical rows stay valid).
- `hub/src/db/scheduled-tasks-dal.ts` — `insertRunV2` accepts `runtime_context_snapshot`. Read-side queries include it in the run-detail endpoint only (not the list endpoint — payload size).

### 3.7 Web — picker simplification + compact desktop layout

- `web/src/components/ScheduleEditor.tsx` — lines 32 (option list), 166 / 236 / 338 (the three target-required branches): replace the card-grid task-type picker with a single `<select>` of three options (Dev / Security scan / Log check). Keep the existing free-form prompt textarea below it (works for all three types — the template's `{{user_prompt}}` slot is exactly that text).
- **Target picker dropdown.** In the same file region, convert the **target picker** (currently cards: One session / One supervisor / All sessions / All supervisors) into a sibling `<select>` wired to the existing `target_kind` enum. **No schema changes.** Dropdown option order: `One session` → `One supervisor` → `All sessions` → `All supervisors`. The downstream target_id selector (specific session/supervisor) remains, surfaced only when `target_kind` is `One session`/`One supervisor` per the existing branches at lines 166/236/338.
- **Compact desktop layout (md and up).** Restructure the editor body into a responsive grid using Tailwind `grid grid-cols-1 md:grid-cols-2` / `md:grid-cols-3` with `gap-3`/`gap-4`. Mobile (below `md:`) stays single-column stacked — no behavior change there. No new borders; keep `bg-[var(--bg-secondary)]/60` card with `p-5` padding per the global design tokens. Suggested groupings (refine during implementation):
  - **Row 1 (`md:grid-cols-2`):** Task type dropdown + Target dropdown — side-by-side.
  - **Row 2 (`md:grid-cols-2`, conditional):** Target session/supervisor selector + Timezone — rendered when `target_kind` is `One session` / `One supervisor`.
  - **Row 3 (`md:grid-cols-2`):** Cron preset/mode picker + Next-run-preview chip on the same line.
  - **Row 4 (`md:grid-cols-3`):** Daily cost cap + Max runtime + Enabled toggle — compact triple.
  - **Full-width rows (unchanged):** Name (auto-prefix + editable suffix), Prompt textarea, Post-run actions list.
  This is a layout-only change — no field semantics or validation rules move. Existing per-field components stay; only their wrapping containers change.
- `web/src/components/SchedulesPage.tsx` — line 137 (filter dropdown), line 396 (label map): drop `prompt`/`skill`/`continue_dev`, add `dev`/`security`.
- `web/src/hooks/useSchedules.ts` — line 4, narrow `TaskType`.
- `web/src/lib/task-name.ts` — line 27, swap label entries.
- `web/src/lib/task-templates.ts` — line 233 and the const above it: collapse to three templates, mirroring `hub/src/scheduler/prompts/*/*.md`. Source-of-truth for prompts is the hub `.md` files; the web copies are previews only (consider fetching from a new `GET /api/scheduled-tasks/templates` endpoint — see §9).
- `web/src/components/CronBuilder.tsx` — no behavior change; mentioned because the task-name auto-prefix continues to read `task_type` through it.

### 3.8 Tests + docs

- `hub/test/scheduler.test.ts` — update enum vectors, name-prefix assertions, runtime-context-injection assertions. Per CLAUDE.md "Scheduled Tasks" section, this file is the contract — must stay green.
- `hub/test/scheduler-runtime-context.test.ts` (NEW) — unit tests for `buildRuntimeContext` against fixture repos.
- `hub/test/scheduled-tasks.e2e.test.ts` — exercise one chain end-to-end (dev-plan → dev-execute via stubbed `runNow`).
- `docs/scheduled-tasks.md` — add a "Workflows" section + new task-kind table + the `runtime_context_snapshot` shape. Per CLAUDE.md the doc updates land in the same commit as scheduler changes.

## 4. DB migration SQL sketch

Additive + rewriting. Idempotent. Lives inline in `hub/src/db/schema.sql` (the project pattern is `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS`).

```sql
-- 1. Rewrite legacy task_type values to the new triad before tightening the constraint.
UPDATE scheduled_tasks SET task_type = 'dev' WHERE task_type IN ('prompt', 'skill', 'continue_dev');
UPDATE scheduled_tasks SET task_type = 'security' WHERE task_type = 'security_scan';
-- task_type = 'log_check' unchanged.
-- task_type = 'triage' unchanged (internal, never user-set).

-- 2. Drop the old check constraint and add the new one.
ALTER TABLE scheduled_tasks DROP CONSTRAINT IF EXISTS scheduled_tasks_task_type_check;
ALTER TABLE scheduled_tasks ADD CONSTRAINT scheduled_tasks_task_type_check
  CHECK (task_type IN ('dev', 'security', 'log_check', 'triage'));

-- 3. Audit snapshot of the runtime context that was sent.
ALTER TABLE scheduled_task_runs
  ADD COLUMN IF NOT EXISTS runtime_context_snapshot JSONB;
```

The constraint-drop name above is a guess; check the actual name with `\d scheduled_tasks` and adjust. Also confirm no FK from `scheduled_task_runs.task_kind` (string column, not FK).

A separate JS migration script under `hub/scripts/migrate-phase-11-prompts.ts` is NOT needed — preserving the existing `prompt` column verbatim covers prompt content. The script IS needed only if we decide to auto-explode each legacy row into three chained step rows on migration; recommended default is **no auto-explosion** (legacy rows stay single-step `dev` until the user re-saves). Decision deferred — see §9.

## 5. Task breakdown (8–12 fine-grained phases per global GSD defaults)

Each phase is sized to land as its own commit on the phase branch.

1. **11.01 — Enum surface narrowing (hub).** Update `TaskTypeEnum` in `scheduled-tasks.ts:42`, `TaskType` in `scheduled-tasks-dal.ts:14`, the switch arms in `dispatcher.ts:363` and `senders/agent.ts:41`, `auto-name.ts:17/50`. Tests: keep `scheduler.test.ts` green.
2. **11.02 — DB migration.** Apply §4 SQL on a Coolify Postgres snapshot in staging, then in prod. Confirm row counts: pre vs post `SELECT task_type, count(*) FROM scheduled_tasks GROUP BY 1`.
3. **11.03 — Web enum surface.** `useSchedules.ts`, `task-name.ts`, `SchedulesPage.tsx`, the filter dropdown. Type-narrow + UI labels only. No picker change yet.
4. **11.04 — Picker collapse.** Replace card grid in `ScheduleEditor.tsx` with `<select>`. Keep the free-form prompt textarea. Visual QA: ensure existing rows render correctly post-migration.
5. **11.05 — Prompt template scaffolding.** Land `hub/src/scheduler/prompts/**` directories + `loader.ts` + minimal hand-authored templates for each step. Templates are syntactic only at this stage — not wired into the sender.
6. **11.06 — Runtime context builders.** Land all of `hub/src/scheduler/context/*.ts`. Pure functions, no IO except `project-type.ts` (which uses supervisor inventory cache, not direct fs). Unit-tested in isolation.
7. **11.07 — Agent sender integration.** Wire `buildRuntimeContext` into `senders/agent.ts`; render the `## RUNTIME CONTEXT` block; persist to `runtime_context_snapshot`. Storage shape: full JSON object, not the rendered string.
8. **11.08 — Workflow chain glue.** Add `workflow.ts` and a "Create workflow" action in `ScheduleEditor.tsx` that, when saving a new dev/security/log_check schedule, creates THREE `scheduled_tasks` rows pre-wired with `chain_task` post-run actions (step 1 → step 2 → step 3). Existing single-step rows remain legal — the workflow path is opt-in. (Alternative single-row design is in §9.)
9. **11.09 — `log-classifier.ts`.** Ship the 16-pattern regex gate referenced in CLAUDE.md "Pending" + wire it into the `log_check.classify` step prompt as a pre-LLM short-circuit. Skip path increments NO cost.
10. **11.10 — Tests + docs.** `scheduler.test.ts` updates, new `scheduler-runtime-context.test.ts`, `docs/scheduled-tasks.md` section "Workflows" + "Runtime context injection" + the new task-kind table.
11. **11.11 — Verifier gate (per global rule #13a).** Dispatch `gsd-verifier` (or equivalent) against the merged PR; produce `VERIFICATION.md` with PASS/PARTIAL/MISSING per goal. Block phase close until green.
12. **11.12 — Release + docs sweep.** Bump version (feat → minor), regenerate `docs/openapi.json` + `docs/api.md` via `bun run docs:sync` if any new endpoint landed (the templates endpoint per §9 may add one), tag, push, verify Coolify deploy at `app.remo-code.com`.

## 6. Risks

1. **Chain explosion of run rows.** Three workflow types × three steps = 3× the run count per scheduled fire. The list endpoint's LATERAL JOIN on `scheduled_task_runs` may slow down — verify with `EXPLAIN ANALYZE` on a 10k-row fixture before shipping.
2. **Cost-cap accounting per workflow.** `enforceCostCap` is per-user-per-day, not per-workflow. A 3-step chain can blow through the cap mid-workflow, leaving an orphaned half-finished workflow. Mitigation options noted in §9.
3. **Template drift between hub `.md` files and web preview.** If web ships its own copy in `task-templates.ts`, they will diverge. Mitigation: a `GET /api/scheduled-tasks/templates` endpoint so the web fetches from the canonical hub source. Adds one OpenAPI route.
4. **Runtime-context staleness.** `current_version`, `latest_tag`, `last_commit_sha` are read at dispatch time from the supervisor inventory cache. If the cache is stale (supervisor offline > grace window), we either skip those fields or fall back to a "(unknown)" sentinel. Recommended: sentinel, with a `_stale: true` flag in the snapshot for audit.
5. **Removing `prompt`/`skill` from the enum without auto-explosion** leaves migrated rows on the new `dev` enum but with their original prompt — fine — yet the chain edges are absent, so they remain single-step. Users who previously had a "skill" run get a `dev` run that ignores the dev-step-1 template entirely. Acceptable: the template-loader checks `user_prompt` presence and prefers user-supplied prompt text when non-empty.
6. **`agent.ts` Summary directive interaction.** The Summary directive is appended AFTER the rendered template. Order in §3.5 puts runtime context BEFORE the template; the directive stays at the very end. Tests must assert ordering.
7. **Project-type detection misclassifies polyglot repos.** A Tauri repo also has a `package.json` and may have a `Dockerfile`. Priority order in §3.4 puts `tauri.conf.json` first to handle this. Spec the priority in `docs/scheduled-tasks.md`.
8. **`design-preferences.md` source.** Global rule says `~/.claude/design-preferences.md`, but the hub MUST NOT read user home dirs (multi-tenant SaaS posture). The plan ships a repo-vendored copy at `docs/design-preferences.md`. Confirm acceptable to user.
9. **`global_rules_digest` becomes stale** as `~/.claude/CLAUDE.md` evolves. Hand-maintained module is a known liability; mitigated by a TODO marker in the file referencing the source rule numbers (#16, #17, #7, etc.).
10. **Triage kind not user-pickable but still listed** — the API enum keeps `triage` (synthesized by Coolify webhook), but the web `<select>` MUST omit it. Two enums in TS (`UserPickableTaskType` + `TaskType`).

## 7. Cost-cap accounting decisions (provisional)

Provisional default: one cap counter per user per day, applied at each step's dispatch (status quo from `dispatcher.ts`). A workflow may be cut off mid-chain. Step 1's post-run dispatcher already checks `enforceCostCap` before chaining to step 2. Document this explicitly so users understand the failure mode. Alternative (workflow-level cap) is in §9.

## 8. Prompt template shape (informative)

Each `.md` template, ~60 lines max, follows this skeleton (used in §3.2):

```
## ROLE
<one sentence>

## RUNTIME CONTEXT
(injected by hub — do not edit)
{{runtime_context}}

## INPUTS
- user_prompt: {{user_prompt}}
- prior_step_output: {{prior_step_output}}   <!-- empty on step 1 -->

## TASK
<step-specific instructions, 10–20 lines>

## DELIVERABLES
- <bulleted list, file paths preferred>

## STOP CONDITIONS
- <when to halt and emit Summary:>
```

The `Summary:` directive in `senders/agent.ts` is appended OUTSIDE this skeleton.

## 9. Open questions (do not answer in this plan)

1. **Editable templates.** Repo `.md` files only (v1), or `users.workflow_template_overrides JSONB` so users can override per-step prompts per-task? Migration story if the user edits a template and we later ship a hub-side improvement?
2. **Per-task per-step prompt slot.** Should the ScheduleEditor expose three textareas (one per step) so the user can append extra instructions to each step's template, or one shared textarea injected at the same `{{user_prompt}}` slot in all three? Guess: three slots.
3. **Workflow creation model.** When the user saves a `dev` schedule, do we (a) auto-create THREE `scheduled_tasks` rows pre-chained, hiding the chain edges in the UI, or (b) require the user to create three rows manually and pick chains? Guess: (a), with an unobtrusive "Steps: Plan → Execute → Ship" disclosure.
4. **Cost-cap scope.** Per-step (current behavior, can cut a workflow in half) vs per-workflow (reserve estimated workflow cost up-front) vs per-day-per-user (status quo). User direction needed.
5. **Templates endpoint.** Ship `GET /api/scheduled-tasks/templates` so the web fetches the canonical hub `.md` files? Or duplicate into `web/src/lib/task-templates.ts` and accept drift?
6. **`triage` task_kind visibility.** Hide entirely from the web UI, or show in run history with a "(internal)" label? Currently shows as "triage" in the filter dropdown.
7. **Auto-explosion on migration.** Should `11.02` create three pre-chained rows for every legacy `continue_dev`/`prompt`/`skill` row, or leave them as single-step `dev` rows until the user re-saves? Risk of duplicating runs if we auto-explode without user awareness.
8. **`log_check.classify` skip discriminant.** Add `on: 'classifier_clean'` to the post-run schema discriminated union (`post-run/schema.ts`), or piggyback on `'success'` with a payload flag the chain executor checks?
9. **`design-preferences.md` source of truth.** Vendor into `docs/design-preferences.md` (hub-readable) or fetch from a new global config service? The global rule expects `~/.claude/design-preferences.md` — does the user want the hub to ALSO read it via the supervisor (since the supervisor IS on the host that owns that file)?
10. **`coolify_app_name`/`coolify_app_uuid` linkage.** Is there an existing `sessions.coolify_app_uuid` column or do we add one? Phase 06 webhook persisted application_uuid only on runs, not on sessions. Confirm before §3.4 `deploy-target.ts` can resolve it.

## 10. Citations (existing files referenced)

- `hub/src/api/scheduled-tasks.ts:42` — current `TaskTypeEnum`.
- `hub/src/db/scheduled-tasks-dal.ts:14` — current `TaskType` TS union.
- `hub/src/db/schema.sql:169-180` — current `task_type` `CHECK` + related columns.
- `hub/src/scheduler/auto-name.ts:17,50` — name-prefix map.
- `hub/src/scheduler/dispatcher.ts:363` — `continue_dev` switch arm + `enforceCostCap`.
- `hub/src/scheduler/senders/agent.ts:41` — current `task_type === 'continue_dev'` branch + Summary directive (visible verbatim in section "agent sender" of the gather pass).
- `hub/src/scheduler/post-run/chain.ts` — full file; `executeChain` re-dispatches via `runNow` with `chainDepth + 1`.
- `hub/src/scheduler/post-run/schema.ts` — `PostRunAction` discriminated union; `ChainTaskAction` already supports a `delay_seconds` knob.
- `hub/src/scheduler/triage-prompt.ts` + `triage-schema.ts` — existing inline-string template + Zod schema; the new prompt templates follow the same "pure function, no IO" pattern.
- `web/src/components/ScheduleEditor.tsx:32,166,236,338` — current card-grid picker + target-required branches keyed on the legacy enum.
- `web/src/components/SchedulesPage.tsx:137,396` — filter dropdown + label map.
- `web/src/hooks/useSchedules.ts:4` — web-side `TaskType` union.
- `web/src/lib/task-templates.ts:233` — legacy `CONTINUE_DEV_TEMPLATE` reference.

## Decisions (orchestrator, autonomous per global rule #9)

Resolutions for §9 open questions:

1. **Editable templates** → Repo `.md` files only in v1. No DB override.
2. **Per-task prompt slot** → ONE shared `{{user_prompt}}` slot injected into all three step templates.
3. **Workflow creation model** → (a) Auto-create three pre-chained `scheduled_tasks` rows on save with disclosure ("Steps: Plan → Execute → Ship"). Single-row legacy stays legal.
4. **Cost-cap scope** → Status quo per-user-per-day. Workflows can be cut mid-chain; documented.
5. **Templates endpoint** → Defer. Web ships preview copy; hub `.md` is source-of-truth (doc-commented).
6. **`triage` visibility** → Show in run history with "(internal)" label; OMIT from create-task `<select>`.
7. **Auto-explosion on migration** → NO. Legacy rows stay single-step `dev` with prompt preserved verbatim.
8. **`log_check.classify` discriminant** → Piggyback on `'success'` with payload flag. No new schema variant.
9. **`design-preferences.md` source** → Repo-vendored at `docs/design-preferences.md` (optional). Hub never reads home dirs.
10. **`coolify_app_uuid` linkage** → Add NULLable `sessions.coolify_app_uuid`. `deploy-target.ts` returns `'none'` until populated.

## 11. Exit criteria for the phase

- All 12 phase steps merged into `main` via per-step PR + the cumulative phase PR.
- `hub/test/scheduler.test.ts` green.
- `docs/scheduled-tasks.md` updated in same commits per project rule.
- `gsd-verifier` PASS verdict in `VERIFICATION.md`.
- Version bump (feat → minor) + tag + Coolify redeploy of `app.remo-code.com` verified `/healthz` 200.
- DB migration applied to prod Postgres on Coolify; pre/post `task_type` counts logged in the phase PR body.
- One end-to-end smoke: schedule a `dev` workflow with cron `*/5 * * * *`, observe three run rows with `chain_task` edges firing in order, with `runtime_context_snapshot` populated on each.

## Completion log

- `8f61547` phase-11: plan + autonomous decisions for open questions
- `b9edb82` phase-11(db): migrate task_type to dev/security/log_check + add runtime_context_snapshot
- `9451fc1` phase-11(types): narrow TaskType to dev/security/log_check + chain step kinds
- `3106e3f` phase-11 WIP (early type narrowing)
- `a9d74c3` phase-11(types): complete task_kind narrowing across hub+web
- `9ca4421` phase-11(prompts): scaffold prompt template loader + dirs
- `b1af0f0` phase-11(prompts): loader + 9 workflow step templates
- `22218f2` phase-11(ui): task-type + target dropdowns, compact md:grid layout
- `f3b1d11` phase-11(context): runtime context injector + project-type detector
- _next_ phase-11(workflows): WORKFLOWS table + chain audit + migration script + docs

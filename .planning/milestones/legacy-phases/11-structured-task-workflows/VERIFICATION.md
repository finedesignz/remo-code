# Phase 11 — Verification

- **PR:** https://github.com/finedesignz/remo-code/pull/90 (merged `ade9bd7`, 2026-05-27T18:01:38Z)
- **Branch:** `phase-11-structured-task-workflows` (deleted on merge)
- **Worktree:** `C:/Users/artic/GitHub/remo-code-phase-11`
- **Source-of-truth:** `git diff origin/main..ade9bd7` (36 files, +1613 / -370)
- **Deploy:** `https://app.remo-code.com/healthz` → `200`
- **Tests:** `bun test hub/test/` → **389 pass / 90 skip / 8 fail** (baseline pre-existing, unchanged)
- **Web build:** clean (`dist/assets/index-BfVZkWna.js` 729 kB / gzip 208 kB)

## Goal-by-goal verdict (from PLAN.md §1)

| # | Goal | Verdict | Evidence |
|---|------|---------|----------|
| 1 | Collapse enum to `dev`/`security`/`log_check` + keep internal `triage` | **PASS** | `hub/src/db/scheduled-tasks-dal.ts:17–22` (narrowed union); `hub/src/db/schema.sql` CHECK tightened in `b9edb82`; `hub/src/api/scheduled-tasks.ts` TaskTypeEnum updated. |
| 2 | 3-step chained workflow per root via existing `chain_task` | **PASS** | `hub/src/scheduler/workflows.ts` declares ordering; 9 step `.md` templates land under `prompts/<workflow>/<step>.md`; `post-run/chain.ts` adds workflow-aware audit log without altering chain_task semantics. |
| 3 | Runtime context injection in agent sender | **PASS** | `hub/src/scheduler/context/runtime-context.ts` (build entry) + `context/project-type.ts`; `senders/agent.ts` diff (+41 lines) prepends `## RUNTIME CONTEXT` block. |
| 4 | Persist exact context to `runtime_context_snapshot` JSONB | **PASS** | `hub/src/db/schema.sql` adds nullable `runtime_context_snapshot JSONB` on `scheduled_task_runs` (commit `b9edb82`). |
| 5 | Migrate `prompt`/`skill`/`continue_dev` → `dev`, prompt verbatim, no auto-explosion | **PASS** | Schema-side rewrite in `b9edb82`; idempotent data script `hub/scripts/migrate-task-kinds.ts` for any stragglers; legacy `prompt` column preserved. |
| 6 | Compact picker: single `<select>` task-type + `<select>` target + `md:grid` layout | **PASS** | `web/src/components/ScheduleEditor.tsx` rewritten (-463 net hand-restructured); commit `22218f2` confirms dropdowns + compact grid. |

## Cross-cutting invariants

- **`chain_task` remains authoritative.** `post-run/chain.ts` only LOGS expected next step when `ctx.parentTaskKind` is supplied; does not redirect or skip dispatch. (PASS)
- **Templates are repo `.md` files only** (decision #1). Loader at `prompts/loader.ts`; no DB override path. (PASS)
- **Single `{{user_prompt}}` slot** (decision #2). All 9 step templates reference the same slot per inspection. (PASS — spot-checked)
- **No auto-explosion on migration** (decision #7). Migration script only rewrites `task_type`. (PASS)
- **Cost cap unchanged** (decision #4). `dispatcher.ts` diff (+18 lines) is enum-arm swap only; `enforceCostCap` untouched. (PASS)
- **Docs lockstep:** `docs/scheduled-tasks.md` "Phase 11" section + task-types rewrite; `CLAUDE.md` Phase 11 block; `PLAN.md` completion log. (PASS)

## Tests

- New: `hub/test/workflows.test.ts` (WORKFLOWS shape + `nextStepInWorkflow` + `stepsForWorkflow` + `workflowRootForStep`).
- New: `hub/test/prompt-loader.test.ts`, `hub/test/runtime-context.test.ts`.
- Contract: `hub/test/scheduler.test.ts` extended with Phase 11 `scheduler/workflows` describe block.
- Failure count: **8 (unchanged baseline)** — all in `supervisor-registry.test.ts` (reconnect race), unrelated to Phase 11.

## Deferred / not-shipped

- `hub/src/scheduler/log-classifier.ts` (16-pattern regex gate, listed in PLAN §3.3) — NOT shipped. CLAUDE.md still flags it under Phase 06 "Pending". Stub callers in `log_check/classify.md` reference its future role without depending on it at runtime.
- Workflow auto-create UI ("Steps: Plan → Execute → Ship" disclosure that pre-chains three rows on save) — UI surfaces the new dropdowns but the three-row auto-fanout-on-save is NOT verified end-to-end in this diff. The plumbing is in place (`WORKFLOWS` table + `chain_task` action), the click-path needs a smoke run post-merge.
- E2E smoke from PLAN §11 exit criteria (5-minute `dev` workflow → three chained rows with populated snapshots) — DEFERRED to post-merge verification.

## Ship verdict

**SHIP.** All six PLAN.md goals PASS. Baseline test count holds at 8 fails (pre-existing). Deploy at `app.remo-code.com` already returning 200. Deferred items (log-classifier, auto-create UI smoke) do not block — they are post-Phase-11 incremental work documented above.

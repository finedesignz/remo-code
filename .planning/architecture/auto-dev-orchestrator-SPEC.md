# Auto-Dev Orchestrator — Milestone Spec

**Status:** DESIGN — locked via Q&A 2026-06-06. Supersedes the row-level pieces of
`auto-dev-system-SPEC.md` (P1–P5, shipped) by adding a **session-level orchestration
layer** on top of the existing dispatch/cost-cap/deploy-verify machinery.
**Owner:** Michael (smithlabsllc@gmail.com)
**Scope:** hub + web only. No supervisor changes. gsd commands execute *inside the bound
session agent* (Claude Code), which has the gsd skills.

---

## 0. Vision

One **orchestrator routine** per session that, on each run, (1) reads the current
stage/status of the project + sessions, (2) decides the next steps, (3) runs **all due
commands** that tick as dependency-aware parallel waves, (4) finishes each unit → opens a
PR → dispatches a reviewer agent, and (5) **always** ends by verifying the app is deployed,
live, and error-free in logs — looping to fix (bounded) until green. It covers the whole
lifecycle: plan → build → audit/gap-find → review → verify → milestone → ship → merge →
maintain. A per-session **run log** records what each run did so the next run knows where it
left off. Cadence and command mix adapt to the app's **lifecycle stage**.

---

## 1. Locked decisions (authoritative)

1. **Decision model — schedule = eligibility, controller arbitrates, runs ALL due.**
   One master routine per session. Each command row's frequency makes it *eligible/due*.
   When the routine fires, a **controller** reads project state + the run log and runs
   **every due command this tick** (not just the highest-priority one), delegating to
   parallel subagents. Always appends the deploy/log-verify tail.
2. **Dependency-aware waves.** Due commands are grouped into dependency waves: independent
   ones (audit-fix, gap-scan, code-review on different areas) run as parallel subagents;
   dependent ones (execute after plan, ship after execute) run in order across waves within
   the same tick. Each unit **finishes → creates a PR → dispatches a reviewer agent** to
   check that PR.
3. **Task model — REPLACE entirely.** A new **orchestrator** task type is THE scheduled-task
   model per session (max **one per session**). The legacy many-tasks-per-session model and
   the standalone dev/qc tasks are deprecated/migrated into orchestrator rows. **Clean
   rebuild:** port the useful substrate (shared `dispatch/`, non-bypassable
   `dailyCostCapGate`, `MAX_CHAIN_DEPTH`, deploy-verify P5, idempotency tables, notify
   channels) but do NOT treat the old `WORKFLOWS.dev/qc` chains as the engine.
4. **Run log — DB table, per session.** New table (`routine_run_log`) keyed by session/repo:
   timestamp, command, decision rationale, outcome, gap-dimension/agent used, PR url,
   reviewer verdict, deploy-verify result. Fed into the controller's runtime context each
   tick. Survives repo resets/worktrees.
5. **Tiered autonomy.** Plan, execute, audit-fix, gap-find, code-review, deploy-verify run
   autonomously. **gsd-ship / gsd-complete-milestone / version-tag / production-merge**
   surface a **propose-to-chat** (Telegram/email, reusing P3 `surfaceProposal`) for one-tap
   approval — EXCEPT the dedicated off-hours merge command (decision 8).
6. **Execution seam — hub injects a templated prompt → the session agent runs the gsd skill
   and itself spawns parallel Task subagents.** Parallelism lives inside the agent turn.
   Reuses the entire existing dispatch/cost-cap stack. The hub does NOT re-implement
   orchestration.
7. **Gap-scan — fixed rotation by dimension, tracked in the run log.** Dimensions:
   security · performance · accessibility · test-coverage · dead-code/dependency-hygiene ·
   error-handling · docs-drift · type-safety. Each gap-scan picks the least-recently-run
   dimension(s) from the log and maps to the right specialist agent (Security Engineer,
   Performance Benchmarker, Accessibility Auditor, Test Results Analyzer, etc.).
8. **Off-hours merge-to-main — its own command; auto-merge in window IF reviewer PASS.**
   Runs only inside a configurable off-hours window (e.g. 01:00–05:00 local). Auto-merges
   PRs the dispatched reviewer marked PASS; FAIL/uncertain held + surfaced to chat. Keeps
   production undisturbed during the day.
9. **Verify-loop tail — reuse P5 deploy-verify + add Coolify log error-scan, bounded.**
   Every cycle ends by: forced redeploy → `/health` → probe real routes (P5
   `deploy-verify-probe`) AND a Coolify runtime-log fetch grepped for
   error/exception/stack patterns. On failure → dispatch fix agent → re-verify, capped at
   **N=3** iterations, then surface to chat (no cost runaway / infinite loop).
10. **Queue + lifecycle stage.**
    - **Global host concurrency queue + per-session lock.** A hub-wide queue caps concurrent
      routine cycles across ALL sessions (configurable, default 2–3). Overlapping due-cycles
      enqueue FIFO with priority (deploy-fix > build). A per-session lock guarantees one
      cycle per session at a time.
    - **Manual lifecycle stage with per-stage presets.** Per-session field
      `lifecycle_stage ∈ {development, beta, production-maintenance}` (default `development`).
      Each stage ships a default row-frequency PRESET; user can override any row after apply:
      - **development** — frequent decide/plan/execute/gap; lighter review cadence.
      - **beta** — heavy QC/audit/code-review/verify; lighter build; ship rare (propose).
      - **production-maintenance** — mostly deploy+log-verify + security gap-scan; ship/merge
        rare; build only on demand.

---

## 2. Data model (additive DDL — schema.sql is idempotent, backfills → hub/scripts/)

- **`scheduled_tasks`** — extend `task_type` CHECK to include `orchestrator`. Enforce one
  `orchestrator` row per session (partial unique index on `(session_id) WHERE task_type =
  'orchestrator'`). Add `lifecycle_stage` column (default `development`).
- **`orchestrator_rows`** — the per-command rows of an orchestrator task:
  `id, task_id, command (enum/text), enabled, schedule_rule (JSONB — reuse ScheduleRule:
  cron + active_window + bounds), frequency_label (Never|Once|cron), micro_prompt (nullable
  free text for custom rows), sort_order`. `Never` ⇒ disabled. `Once` ⇒ max_runs=1 auto-disable.
- **`routine_run_log`** — decision 4 fields. Indexed by `(session_id, created_at)`.
- **`routine_queue`** — global FIFO queue rows for cycle scheduling: `id, session_id,
  priority, enqueued_at, started_at, status`. Per-session advisory lock via a unique partial
  index on `(session_id) WHERE status='running'`.
- Reuse existing idempotency tables (`coolify_deploy_idempotency`, `qc_finding_idempotency`,
  `github_issue_idempotency`) and `notifications_sent` (propose throttle).

---

## 3. Default command rows (full lifecycle set)

Always-on implicit (not user rows): **status-check/decide** (first), **deploy+log-verify**
(terminal). User-configurable rows, each with its own frequency/Never/Once:

`gsd-plan-phase` · `gsd-execute-phase` · `gsd-audit-fix` · `gap-scan` (rotating specialist) ·
`gsd-code-review` · `gsd-verify-work` · `gsd-complete-milestone` · `gsd-ship` ·
`merge-to-main` (off-hours) . Users may add extra command rows or **micro-prompt** rows with
the same frequency UI.

---

## 4. The standard controller prompt (drafted — refined in implementation)

Injected by the hub when the orchestrator routine fires. Skeleton:

> You are the auto-dev orchestrator for **{repo}** (lifecycle stage: **{stage}**). Read the
> RUN LOG below (last N entries) and the current project state (open roadmap phases, last
> commits, open PRs, deploy status). The following command rows are **DUE** this tick:
> {due_rows}. Plan a **dependency-aware wave schedule**: run independent commands as parallel
> Task subagents; sequence dependent ones (plan→execute→ship). For each command, run the
> corresponding gsd skill. Every unit of work MUST finish, create a PR, and dispatch a
> reviewer subagent to verify the PR. Do NOT merge to main here (that is the off-hours
> command). For ship/complete-milestone/tag, PROPOSE to chat and stop that branch. Finally,
> ALWAYS run the deploy+log-verify tail: redeploy, probe real routes, scan Coolify logs for
> errors; if broken, dispatch a fix agent and re-verify up to 3×, then surface. Append a RUN
> LOG entry per command with outcome + PR + reviewer verdict + gap dimension used. Respect
> the daily cost cap and chain-depth — they are non-bypassable.

---

## 5. UI (web — Settings → one orchestrator task per session)

- One orchestrator task per session. A **lifecycle-stage** selector (dev/beta/prod-maint)
  with "apply preset" → fills default row frequencies (overridable).
- A drafted standard prompt (read-only/expandable) explaining the structure to the agent.
- A table: **one command per row** — command name · frequency control (reuse
  `ScheduleRulesBuilder`: cron + day/time + active_window + bounds) with **Never** and
  **Once** options · enabled toggle · drag sort. "+ Add command" and "+ Add micro-prompt"
  rows with the same frequency UI.
- Accent = BLUE (no indigo — CI-guarded).

## 6. Cross-cutting invariants (inherit, do not violate)

- Cost cap non-bypassable (`dailyCostCapGate`). Webhooks raw-body-before-parse. schema.sql
  idempotent-only. No provider API key on the human PTY path. Single dispatch pipeline.

---

## 7. Proposed phase breakdown (8–12, for the milestone roadmap)

1. **Data model + migrations** — `orchestrator` task_type, one-per-session index,
   `lifecycle_stage`, `orchestrator_rows`, `routine_run_log`, `routine_queue`. Idempotent DDL.
2. **Global queue + per-session lock** — hub-wide concurrency cap, FIFO+priority, drain worker.
3. **Controller + decision/run-log** — status-check, due-row gathering, run-log read/write,
   controller prompt + decision parser (mirror existing `parseControllerDecision`).
4. **Dependency-aware wave execution** — group due commands, parallel Task fan-out, per-unit
   finish→PR→reviewer-dispatch.
5. **gsd-command row execution seam** — templated prompt injection per command into the
   bound session; map each row → gsd skill invocation.
6. **Gap-scan rotation** — dimension wheel + specialist-agent mapping + log-driven rotation.
7. **Verify-loop tail** — reuse P5 deploy-verify + Coolify log error-scan + bounded fix loop.
8. **Tiered autonomy + propose-to-chat** — ship/milestone/tag gating via P3 surfaceProposal.
9. **Off-hours merge-to-main command** — window gate + auto-merge on reviewer PASS + hold/notify.
10. **Lifecycle-stage presets** — per-stage default row frequencies + apply/override.
11. **Web UI** — one-task-per-session orchestrator editor, row table, stage selector, prompt.
12. **Migration/deprecation** — fold legacy tasks + dev/qc routines into the orchestrator model.

(Granularity Fine per GSD defaults; planner may split/merge.)

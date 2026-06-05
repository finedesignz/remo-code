# Scheduled Tasks Redesign + Predefined GSD Task Templates — Design Plan

**Status:** DESIGN ONLY (no feature code). **Branch:** `plan/scheduled-tasks-redesign`.
**Author:** planning agent · 2026-06-04.

---

## 1. Goal & Scope

### Goals
1. **Collapse the Tasks page to a SINGLE page** — remove its sub-tab structure
   (today: `Upcoming | Activity | Schedule`). One scannable task page: list +
   create/edit + status + next-run + last-run + cost, no sub-pages.
2. **Predefined GSD task templates** — ready-made templates that schedule GSD
   slash-commands (`/gsd-run`, `/gsd-audit-fix`, `/gsd-review` / `/gsd-code-review`)
   against a target repo/session on a cadence. User picks a template → points it at
   a repo/session + picks a cadence → done.

### Non-goals (explicit)
- **NOT deleting the Activity page/route/component.** Activity is *removed from the
  Tasks sub-tab structure* but its component + endpoint are **preserved/parked** for
  the user's future repurpose: a global "running log of ALL activity" page (not just
  tasks). See §3.3.
- **NOT building a new/parallel scheduler engine.** We EXTEND `hub/src/scheduler/`
  (dispatcher, post-run actions, dev controller). Templates are sugar over the
  EXISTING `scheduled_tasks` row + payload.
- **NOT duplicating the auto-dev dev chain / dev_controller.** GSD templates ride the
  existing dev chain + its gating (see §6). No new gate logic.
- **NOT a new `task_templates` DB table** (the existing schema suffices — see §5).

---

## 2. Current-State Map

### 2.1 Tasks page + sub-tabs (web)
`web/src/pages/TasksPage.tsx` — shell with **three** sub-tabs (the brief said two;
reality is three), driven by `?tab=` in the hash:
- `TasksPage.tsx:20` `type TasksTab = "upcoming" | "activity" | "schedule"`.
- `:22-26` `readTasksTab()` reads `?tab=` via `readTabParam()`, defaults `upcoming`.
- `:46-50` `handleTabChange()` writes `?tab=` via `writeTabParam()`.
- `:52-61` `buildTopNav(...)` attaches the three sub-tabs as a **dropdown off the
  Tasks nav item** (post-PR #252 mobile top icon-bar; the dropdown is the sub-tab
  switcher).
- `:70-84` conditionally renders one of:
  - **`UpcomingTab`** (`web/src/pages/tasks/UpcomingTab.tsx`) — `GET /api/tasks/upcoming`;
    cards: name + next-run + humanized cron + target; row click → `ScheduleRunsDrawer`.
  - **`ActivityTab`** (`web/src/pages/tasks/ActivityTab.tsx`) — user-wide run feed across
    ALL tasks; `GET /api/tasks/activity?status=&before=&limit=` (keyset paging,
    `{ runs, next_cursor }`); filter chips `All | In Progress | Completed | Failed`;
    row → `<Drawer>` with `output_snippet` + `error` + metadata. **This is the run-log
    surface the user wants to later generalize into "all activity."**
  - **`ScheduleTab`** (`web/src/pages/tasks/ScheduleTab.tsx`) — the actual CRUD list of
    scheduled tasks, **grouped by repo** (target session `project_dir`); uses
    `ScheduleEditor` (`web/src/components/ScheduleEditor.tsx`) for create/edit, the
    `CronBuilder`, and per-row last-run metrics.

Nav helpers: `web/src/lib/ui/nav.ts` — `buildTopNav()`, `activeTopRoute()`,
`readTabParam()`/`writeTabParam()`. `SubTabConfig` attaches `subTabs` to a nav item;
`AppShell` renders them as a dropdown.

### 2.2 REST API (hub)
`hub/src/api/scheduled-tasks.ts` — V2 user-scoped CRUD + `run-now`, all Zod-validated.
- DAL: `hub/src/db/scheduled-tasks-dal.ts` (`listTasksForUser`, `getTask`,
  `createTaskV2`, `updateTaskV2`, `deleteTask`).
- Cron: `scheduler/cron.ts` (`validate`, `nextRuns`, `isValidTimezone`).
- Schedule rules (windows/bounds): `scheduler/schedule-rules.ts`.
- Post-run actions: validated via discriminated union `scheduler/post-run/schema.ts`;
  chain-cycle detection across the user's full task graph at write time.
- Auto-name: `scheduler/auto-name.ts` `buildTaskName(task_type, target_kind, ...)` —
  server-computed locked `name_prefix`; user free-form `name_suffix`.
- Related list endpoints: `GET /api/tasks/upcoming`, `GET /api/tasks/activity`.

### 2.3 Task model (source: `docs/scheduled-tasks.md`)
```ts
type ScheduledTask = {
  id, user_id, name, name_prefix, name_suffix,
  task_type: 'prompt' | 'skill' | 'security_scan' | 'log_check' | 'continue_dev',
  target_kind: 'session' | 'supervisor' | 'all_agents' | 'all_supervisors',
  target_id: string | null,
  payload: { prompt?: string, command?: string, args?: any },
  prompt: string,                 // top-level column = source of truth, mirrors payload.prompt
  cron_expr, timezone, catchup_policy, max_concurrent, enabled,
  post_run_actions: PostRunAction[],
}
```
- **Prompt storage:** `prompt` column is source of truth; `payload.prompt` is the
  field the editor reads/writes; CREATE + PATCH keep them in lockstep
  (`hub/src/scheduler/senders/agent.ts` `buildContent`:
  `payload.prompt || prompt || 'Continue where you left off.'`).
- **`payload.args`** is a free-form `any` — our template params ride here additively
  (see §5) with **no schema migration**.

### 2.4 Scheduler engine + post-run + dev chain
`hub/src/scheduler/` — dispatcher fires on cron, runs gates (incl. the
**non-bypassable `dailyCostCapGate`** in `hub/src/dispatch/gates.ts`), sends to the
agent, finalizes a run row, then iterates `post_run_actions`:

| `type`          | `config`                                  |
|-----------------|-------------------------------------------|
| `chain_task`    | `{ task_id }` → `dispatcher.runNow`       |
| `notify_email`  | `{ to?, subject, body }`                  |
| `notify_telegram` / `notify_web_push` / `webhook` | …          |
| `github_issue`  | `{ repo_full_name, labels?, assignees? }` (from a `triage` run) |

`on` ∈ `success | failure | always`.

**Auto-dev dev controller** (`.planning/architecture/auto-dev-system-SPEC.md`): a `dev`
**controller** step reads repo state (`.planning/` plans, `git log`, open PRs via `gh`,
TODO markers, last run `output_snippet`), emits a structured decision the hub parses
(reuse `parseTriageOutput` / `Summary:` convention), and chains the next step via
`post_run_actions` — exactly like triage routes to `github_issue`. **Locked decisions:**
plan-first ALWAYS, QC → PR / `dev_ship` auto-merge. Directive: **gate the existing dev
chain, don't fork it.** P1 (schedule windows/bounds) shipped (#216); P2 (`dev_controller`
state-gate) in flight.

---

## 3. Single-Page Tasks Design

### 3.1 New one-page layout (`TasksPage.tsx`)
One page, no `?tab=` switching for product tabs. Per design-preferences (density,
"one table beats N sections", icon-only row actions, status column, no desktop
accordions):

```
┌ Tasks ───────────────────────────────[ + New Task ▾ ]─┐   ← New Task is a split/dropdown:
│  Toolbar: [search name] [Status: All|Enabled|Disabled]│     "Blank task" + template catalog
│           [Type ▾] [Repo ▾ (worktree filter, PR #253)] │     (see §4.5)
├───────────────────────────────────────────────────────┤
│  Repo group: finedesignz/remo-code                     │   ← keep ScheduleTab's repo grouping
│   • <task name>      Every weekday 09:00 (PDT)    [▶][✎][⏸][🗑] │
│     ● success · $0.0034 · 12.3s   Next: …  Fired 4m ago│
│   • <task name> …                                      │
│  Repo group: finedesignz/zenexa …                      │
└───────────────────────────────────────────────────────┘
```
- **Core surface = today's `ScheduleTab`** (the CRUD list grouped by repo) promoted to
  be the page body. It already carries name, humanized cron, target, status, last-run
  cost/duration, next-run, "Fired Xm ago" per row (`formatCostUsd`/`formatDuration`/
  `formatRelativeAgo`). That satisfies "status, next-run, last-run, cost" with no new
  data.
- **Fold "Upcoming" INTO the list, don't keep it as a tab.** Add an optional
  **"Next run" sort** + an **"Upcoming" toggle/filter** (show only tasks with a
  `next_fire_at` in the near window) to the toolbar. `GET /api/tasks/upcoming` stays as
  a backend endpoint but the dedicated tab is removed; the list already shows next-run
  per row. (Alternative if we want to preserve the at-a-glance Upcoming view: a thin
  collapsible "Up next" strip pinned above the list — but per "no desktop accordions"
  prefer the sort/filter. **Open question Q1.**)
- **Create/Edit** stays in `ScheduleEditor` (modal/drawer), now also reachable from the
  **template catalog** (§4.5). Per-row `▶ run now / ✎ edit / ⏸ enable-disable / 🗑 delete`
  icon buttons (already the row-action pattern).
- **Run history** per task: keep `ScheduleRunsDrawer` (row click / history icon). This
  is the per-task drilldown — distinct from the parked global Activity feed.

### 3.2 Nav change (collapse sub-tabs)
- `TasksPage.tsx`: drop `TasksTab` union + `readTasksTab` + `handleTabChange` +
  the per-tab conditional render. Render the single task surface directly.
- `buildTopNav(...)` call: **omit the `subTabs` config** for the Tasks route → the
  Tasks nav item becomes a **single nav target** (no dropdown). This is the explicit
  fix the PR #252 mobile top icon-bar note calls out: "if Tasks no longer has sub-tabs,
  the Tasks dropdown collapses to a single nav target." `nav.ts` needs **no change** —
  `subTabs` is already optional; just stop passing it.
- `?tab=` handling: TasksPage stops reading/writing `?tab=`. Keep a **back-compat
  redirect**: if the hash arrives as `#/tasks?tab=activity|schedule|upcoming`, strip the
  param (replaceState to `#/tasks`) so old bookmarks/links don't 404 into a dead tab.
  `#/tasks?tab=activity` specifically → see §3.3 (route preserved separately).

### 3.3 What happens to Activity (PRESERVE — do not delete)
The user will repurpose Activity into a **global "all activity" log** later. Interim:
- **Keep `web/src/pages/tasks/ActivityTab.tsx` and `GET /api/tasks/activity` intact.**
  No deletion, no behavior change to the endpoint.
- **Remove Activity from the Tasks sub-tab dropdown** (it's no longer a Tasks tab).
- **Park it behind a hidden/standalone route** so the component stays mounted-able and
  the future global page has a home:
  - Add a parked hash route **`#/activity`** that renders `ActivityTab` standalone
    inside `AppShell` (no nav item yet, or a disabled/"coming soon" item). This is the
    seed of the future "all activity" page; the user later widens its data source
    beyond tasks.
  - **Back-compat:** `#/tasks?tab=activity` → `replaceState` redirect to `#/activity`
    (so the old deep link lands on the parked page, not a removed tab).
  - Add a one-line code comment + a `docs/scheduled-tasks.md` note: *"Activity is parked
    at `#/activity` pending the global-activity-log repurpose; do not delete."*
  - Optional minimal "Moving soon — this will become a global activity log" banner on
    the parked page. **Open question Q2** (banner vs silent park).
- **Decision:** park as a real (if unlinked) route, NOT a deleted file and NOT inlined
  into Tasks. Rationale: keeps it independently routable for the repurpose, keeps the
  Tasks page single-purpose, zero data/endpoint churn.

---

## 4. Predefined GSD Task Templates

### 4.1 What a template is
A **template = a preset that pre-fills a `scheduled_tasks` row**: the prompt (literal
GSD slash-command text), `task_type`, a default cadence (cron), required inputs (target
repo/session), and guardrails (cost cap, plan-first, auto-merge policy) + a default
post-run action. It is **pure sugar over the existing payload** — creating from a
template just opens `ScheduleEditor` pre-filled, then POSTs the normal CREATE.

**GSD slash syntax uses DASH not colon** (`/gsd-run`, not `/gsd:run`) — memory
`feedback_gsd_command_syntax`. All template prompts below use dash form.

### 4.2 Catalog (v1)

| Template | Display name | Injected prompt (`payload.prompt`) | `task_type` | Default cron | Guardrails | Default post-run |
|---|---|---|---|---|---|---|
| `gsd_run` | **Run dev on repo** | `/gsd-run` (continue the active milestone; plan-first, then execute the next phase) | `continue_dev` | `0 */4 * * *` (every 4h) | cost cap (inherit user cap), **plan-first ON**, auto-merge per dev_ship policy (default OFF → QC→PR) | `notify_telegram` on `always` (summary) |
| `gsd_audit` | **Audit repo (nightly)** | `/gsd-audit-fix` (run audit, propose+apply fixes behind QC) | `continue_dev` | `0 3 * * *` (nightly 03:00) | cost cap; plan-first ON; **auto-merge OFF** (audit fixes → PR) | `github_issue` on `failure` (file findings) + `notify_telegram` on `always` |
| `gsd_review` | **Review open PRs (weekly)** | `/gsd-code-review` (review open PRs in this repo; comment findings) | `prompt` | `0 9 * * 1` (Mon 09:00) | cost cap; read-mostly (no auto-merge) | `notify_telegram` on `always` |
| `gsd_plan` | **Plan next phase** | `/gsd-plan-phase` (draft the next phase plan, write to `.planning/`, do NOT execute) | `prompt` | manual / `0 8 * * 1` | cost cap; plan-only (no code) | `notify_telegram` on `success` |

> `/gsd-run` and `/gsd-audit-fix` set `task_type: 'continue_dev'` so they ride the
> existing dev chain + dev controller (§6). `/gsd-code-review` / `/gsd-plan-phase` are
> read/plan-only → plain `prompt`. (`/gsd-review` is the user's shorthand; the actual
> skill is `gsd-code-review` — note in UI copy. **Open question Q3.**)

Each template entry (static catalog, code) shape:
```ts
interface TaskTemplate {
  id: 'gsd_run' | 'gsd_audit' | 'gsd_review' | 'gsd_plan';
  label: string;
  description: string;              // one-liner shown in catalog card
  promptTemplate: string;          // literal GSD slash text injected to payload.prompt
  taskType: ScheduledTask['task_type'];
  defaultCron: string;
  requiredInputs: ('target_session' | 'target_repo' | 'cadence')[];
  guardrails: { planFirst: boolean; autoMerge: boolean; inheritCostCap: true };
  defaultPostRunActions: PostRunAction[];
  category: 'gsd';
}
```

### 4.3 Required inputs at create-from-template time
- **Target** — a session or supervisor (existing `target_kind` / `target_id`). For
  GSD-on-a-repo, the user picks the session bound to that repo's `project_dir`
  (the list already groups by repo; reuse the Repo/worktree picker from PR #253).
- **Cadence** — `CronBuilder`, prefilled with the template `defaultCron`.
- Everything else (name prefix via `auto-name.ts`, cost cap, post-run) is defaulted;
  user can tweak in the same editor before saving.

### 4.4 Representation — lightest design (chosen)
**Static catalog in code + a `template_id` tag on the payload. NO new table.**
- Catalog lives in **`hub/src/scheduler/task-templates.ts`** (server source of truth)
  and is exposed read-only via **`GET /api/tasks/templates`** (so web + future clients
  share one definition). Web imports a typed mirror or fetches the endpoint.
- On create-from-template, the web pre-fills `ScheduleEditor`; the POST body is the
  **normal CREATE** plus:
  - `payload.template_id: 'gsd_run' | …` — provenance tag (additive, `payload.args`
    is already `any`; we add a typed optional `template_id`).
  - `payload.args.gsd` (optional) — any template-specific knobs (e.g. `{ planFirst,
    autoMerge }`) so the dev controller can read intent without re-parsing the prompt.
- **Why not a `task_templates` table:** templates are a fixed, code-defined catalog,
  not user CRUD. A table adds migration + sync surface for zero benefit. If users ever
  want to *save their own* templates, revisit — but v1 is fixed GSD presets.

### 4.5 Create-from-template UX flow
1. Tasks page → **`+ New Task ▾`** split button → menu lists **"Blank task"** + the GSD
   template cards (`Run dev`, `Audit`, `Review PRs`, `Plan`).
2. Pick a template → `ScheduleEditor` opens **pre-filled**: prompt = template text
   (read-only-ish / editable), `task_type`, `defaultCron` in `CronBuilder`, guardrail
   defaults, default post-run actions. A small **"GSD: Run dev"** badge shows provenance.
3. User picks **target session/repo** (required) + tweaks cadence → **Save** → normal
   `POST /api/scheduled-tasks`. Auto-name composes e.g. *"Run dev on finedesignz/remo-code
   every 4h"* (extend `auto-name.ts` to recognize `template_id` for a nicer prefix —
   §5).

---

## 5. Data / API Changes (additive only)

**No DB migration required.** `payload` is JSONB free-form; `payload.args` is `any`.

1. **Payload additive fields** (Zod, in `hub/src/api/scheduled-tasks.ts` create/patch
   body + `payload` schema):
   - `payload.template_id?: enum('gsd_run','gsd_audit','gsd_review','gsd_plan')`
   - `payload.args.gsd?: { planFirst?: boolean; autoMerge?: boolean }` (optional)
   Both optional → fully back-compat; existing rows omit them.
2. **New read-only endpoint** `GET /api/tasks/templates` → `{ templates: TaskTemplate[] }`
   from `hub/src/scheduler/task-templates.ts`. User-scoped only for auth (catalog is
   static). Register in `hub/src/api/_openapi.ts`; run `bun run docs:sync`.
3. **`auto-name.ts`** — optional: when `payload.template_id` is set, compose the locked
   `name_prefix` from the template label + target repo + cadence (e.g. "Run dev on
   `<repo>` every 4h"), aligning with the existing autoname handoff
   (`project_handoff_scheduler_autoname`).
4. **No change** to the dispatcher/sender — `payload.prompt` already carries the GSD
   slash text; the agent runs it as the turn prompt. `template_id`/`args.gsd` are read
   by the dev controller (§6), not the sender.
5. **OpenAPI/docs:** update `hub/src/api/_openapi.ts` for the new endpoint + payload
   fields; `bun run docs:sync`; update `docs/scheduled-tasks.md` (templates section +
   Activity-parked note) in the same PR (docs-drift CI).

---

## 6. Integration with Auto-Dev (reuse, don't duplicate)

- `/gsd-run` and `/gsd-audit-fix` templates set `task_type: 'continue_dev'`, so they
  enter the **existing dev chain**. The **dev controller** (auto-dev SPEC §2, P2 in
  flight) reads repo state and emits a structured decision; the hub chains the next
  step via `post_run_actions`. **We add no gate logic** — templates just produce
  `continue_dev` rows with `payload.template_id` + `payload.args.gsd` so the controller
  knows the operator's intent (plan-first / auto-merge) without re-parsing prose.
- **Locked auto-dev decisions enforced via guardrails:**
  - **plan-first ALWAYS** → templates default `planFirst: true`; the GSD `/gsd-run`
    prompt itself is plan-first; the dev controller already gates execute-vs-plan.
  - **QC → PR / `dev_ship` auto-merge** → `autoMerge` default OFF for audit/review,
    operator-opt-in for `gsd_run`; the existing `dev_ship` post-run path owns the
    actual merge — templates only set the flag.
- **Cost cap** is the shared non-bypassable `dailyCostCapGate` — templates inherit the
  user cap, set nothing special. Every GSD run is capped like any other dispatch.
- **Dependency:** the richest `gsd_run`/`gsd_audit` behavior (state-aware chaining)
  lands fully when auto-dev **P2 dev_controller** ships. v1 templates work today as
  plain scheduled `continue_dev` prompts; they get smarter automatically as the
  controller lands. **No coupling that blocks shipping the UI/template work first.**

---

## 7. Phasing (incremental, one PR + QC gate each)

**P1 — Single-page Tasks collapse + park Activity.** (UI only, no API)
- Rewrite `TasksPage.tsx` to render the single task surface (promote `ScheduleTab`
  body; fold Upcoming into a sort/filter); stop passing `subTabs` to `buildTopNav`.
- Park `ActivityTab` at standalone `#/activity`; add `?tab=*` back-compat redirects
  (`activity` → `#/activity`, others → `#/tasks`).
- Update `docs/scheduled-tasks.md` (single-page + Activity-parked note).
- **QC:** web build green; `no-indigo` + nav tests; manual: Tasks shows one page, no
  dropdown; `#/tasks?tab=activity` lands on parked Activity; old links don't dead-end.

**P2 — Template catalog (backend + create-from-template UX).**
- `hub/src/scheduler/task-templates.ts` static catalog; `GET /api/tasks/templates`;
  OpenAPI + `docs:sync`.
- Web: `+ New Task ▾` split button + template cards; `ScheduleEditor` accepts a
  `template` prop to pre-fill; `payload.template_id` round-trips (additive Zod).
- **QC:** `hub/test/scheduler.test.ts` + a new templates contract test; create-from-template
  produces a valid task; mount-order/openapi-drift tests pass.

**P3 — Wire GSD templates to scheduler/auto-dev guardrails.**
- `auto-name.ts` template-aware prefix; `payload.args.gsd` (planFirst/autoMerge) read by
  the dev controller; default post-run actions per template; confirm `continue_dev`
  GSD rows enter the dev chain and respect the cost cap + plan-first.
- **QC:** end-to-end: a `gsd_run` template task fires (run-now), dispatches the GSD
  prompt to the target session, cost-capped, post-run notify fires; dev-controller
  decision parsed when P2-auto-dev present (else plain run).

**(Optional) P4 — Upcoming-view polish + global-activity seed.** Only if Q1/Q2 resolve
toward a pinned "Up next" strip or an early global-activity nav item.

Each phase: independent verifier → `VERIFICATION.md` PASS/PARTIAL/MISSING + ship verdict
before the next phase (global rule 13a).

---

## 8. Risks / Edge Cases + Open Questions

### Risks / edge cases
- **Losing the at-a-glance Upcoming view.** Folding Upcoming into a filter removes the
  dedicated "what fires next" scan. Mitigation: default "Next run" sort + an Upcoming
  filter; or a pinned strip (Q1).
- **Stale deep links / `?tab=` bookmarks.** Handled by back-compat redirects; test the
  three legacy params.
- **PR #252 mobile top-bar dropdown.** With sub-tabs gone the Tasks dropdown must
  cleanly collapse to a single tap target — verify on `< md` (icon-bar) that Tasks no
  longer renders an empty dropdown chevron.
- **Template prompt drift vs real GSD skill names.** `/gsd-review` shorthand ≠ skill
  `gsd-code-review`; pin exact slash text in the catalog and keep it in one place
  (`task-templates.ts`) so a GSD rename is a one-file edit.
- **Auto-dev P2 dependency.** Smart chaining needs the dev controller; v1 templates must
  degrade to plain scheduled prompts so this work isn't blocked on auto-dev P2.
- **Cost cap on aggressive cadences.** `/gsd-run` every 4h on several repos can hit the
  daily cap; that's by design (cap is non-bypassable) — surface the skip reason in the
  run row, which the list already shows.

### Open questions (genuine product calls for the user)
- **Q1 — Upcoming view:** fold into a sort/filter on the single list (preferred, denser),
  OR keep a pinned "Up next" strip above the list? (Brief says single page, no sub-tabs;
  both satisfy that.)
- **Q2 — Activity parking:** silent park at `#/activity`, or show a "Moving soon: global
  activity log" banner now? Any nav entry yet, or fully hidden until the repurpose?
- **Q3 — Review template command:** use `/gsd-code-review` (actual skill) or `/gsd-review`
  shorthand for the "Review open PRs" template? Confirm the exact slash text + whether
  Review should target "open PRs in repo" vs "current diff".
- **Q4 — `gsd_run` auto-merge default:** OFF (QC→PR, safest) per locked decisions, or
  operator-opt-in ON for trusted repos? Default proposed OFF.
- **Q5 — Template scope:** ship the 4 GSD templates only, or also add non-GSD presets
  (e.g. "Security scan nightly" using existing `security_scan` task_type) in the same
  catalog?
```

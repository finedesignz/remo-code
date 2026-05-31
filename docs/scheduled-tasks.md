# Scheduled Tasks

Hub-side cron scheduler that fires user-defined tasks against connected
Claude Code agents or supervisors on a recurring cadence. Tasks can target
a specific session, a specific supervisor, all of the user's online agents,
or all of the user's online supervisors. Each fire records a run row with
status, cost, duration, and output snippet, and runs stream live progress
to the web UI over WebSocket.

> **Status:** shipped in the `scheduled-tasks` phase. V2 dispatcher lives
> at `hub/src/scheduler/`. The legacy v0 scheduler (`hub/src/scheduler/index.ts`)
> is still wired during the transition and will be removed in a follow-up.

---

## Architecture

```
                ┌──────────────────────────┐
                │  Web UI (SchedulesPage)  │
                └────────────┬─────────────┘
                             │ REST + WS
                             ▼
   ┌─────────────────────────────────────────────────────┐
   │  Hub                                                │
   │  ┌───────────────┐  ┌───────────────────────────┐  │
   │  │ REST routers  │  │ scheduler/                │  │
   │  │ /api/         │──▶│  registry  (Map<id,Cron>)│  │
   │  │  scheduled-   │  │  cron       (validate)    │  │
   │  │  tasks        │  │  dispatcher (fan-out)     │  │
   │  │  /api/        │  │  targets    (resolve)     │  │
   │  │  scheduled-   │  │  session-queue (1+1 cap)  │  │
   │  │  task-runs    │  │  catchup    (boot replay) │  │
   │  └───────────────┘  │  grace      (offline)     │  │
   │                     │  senders/                 │  │
   │                     │    agent.ts   (stdin)     │  │
   │                     │    supervisor.ts          │  │
   │                     │    coolify.ts (log_check) │  │
   │                     │  post-run/                │  │
   │                     │    dispatcher.ts          │  │
   │                     │    chain, email, telegram │  │
   │                     │    webpush, webhook,      │  │
   │                     │    aggregator             │  │
   │                     └───────────────────────────┘  │
   └─────────────────────────────────────────────────────┘
```

### Module map

| Module                                    | Role                                                                   |
|-------------------------------------------|------------------------------------------------------------------------|
| `hub/src/scheduler/cron.ts`               | croner wrapper: `validate`, `nextRuns`, `compilePreset`, IANA TZ check |
| `web/src/lib/cron.ts`                     | API-compatible mirror used by the UI for the "next 3 runs" preview     |
| `hub/src/scheduler/registry.ts`           | In-memory `Map<task_id, Cron>`; load-all on boot, register/replace     |
| `hub/src/scheduler/session-queue.ts`      | **Back-compat shim** over `hub/src/dispatch/session-queue.ts` (1 in-flight + 1 waiter). Kept until the Round-2 collapse PR; the scheduler no longer enqueues on it at runtime — session sends use the shared `dispatch()` pipeline's own queue. `scheduler.test.ts` still exercises this shim's functional API as a standalone unit. |
| `hub/src/scheduler/targets.ts`            | Resolves `target_kind` → list of `{kind, sessionId?, supervisorId?}`   |
| `hub/src/scheduler/dispatcher.ts`         | Cost cap, fan-out, per-target run rows, triage routing, route to sender. SESSION targets fall through to the agent sender (which parks offline in the shared grace buffer); SUPERVISOR targets keep the dispatcher's offline pre-check + concurrency gate (park via the shared grace buffer keyed by supervisorId). |
| `hub/src/scheduler/senders/agent.ts`      | **Round-2: thin adapter over the shared `dispatch()` pipeline** for SESSION-targeted runs. Builds prompt + runtime context, a `RunStore` that finalizes the existing `scheduled_task_runs` row via `finalizeRun` (which fires the post-run pipeline), gates `[threshold, dailyCostCap]` (the promotion re-check), offline `replay`/`onParkExpire`, and the Summary directive + `## RUNTIME CONTEXT` block on the SENT string only. Finalize lands via `dispatch.onSessionReply`. |
| `hub/src/scheduler/senders/supervisor.ts` | `run_command` against a supervisor socket (`run_started/output/finished`)|
| `hub/src/scheduler/senders/triage.ts`     | LOCAL-AGENT triage runs through the shared `dispatch()` pipeline (RunStore.onFinalize parses `TriageResult`); SUPERVISOR-spawn triage stays on the legacy `pending` map + `onTriageAssistantMessage` hook (spawn-and-wait, not a queue dispatch). |
| `hub/src/scheduler/senders/coolify.ts`    | Hub-local `log_check` via Coolify deploy/logs API                      |
| `hub/src/scheduler/catchup.ts`            | On boot: walk missed fires per task (cap 100), respect `catchup_policy`|
| _(deleted)_ `hub/src/scheduler/grace.ts`  | **Removed in Round-2.** Offline parking now uses the shared `hub/src/dispatch/grace.ts` buffer (`getGraceBuffer()`): session runs park keyed by sessionId, supervisor runs by supervisorId; drained on the respective reconnect in `hub/src/ws/agent.ts`. |
| `hub/src/scheduler/post-run/dispatcher.ts`| Routes finalized runs to post-run executors per matching condition     |
| `hub/src/scheduler/post-run/schema.ts`    | Zod schema for `post_run_actions` + chain-cycle detector (DFS)         |
| `hub/src/scheduler/post-run/aggregator.ts`| Fan-out aggregator: collects child results, fires post-run actions once|
| `hub/src/scheduler/post-run/template.ts`  | `{{var}}` substitution with optional HTML escape (email variant)       |
| `web/src/components/CronBuilder.tsx`      | Dropdown-driven cron builder (8 modes + presets) used in editor        |
| `web/src/lib/cron-humanize.ts`            | `humanizeCron(expr)` plain-English renderer (builder + list row)       |
| `web/src/lib/format.ts`                   | `formatDuration`, `formatCostUsd`, `formatRelativeAgo` (list chips)    |
| `web/src/lib/scheduled-message.ts`        | `parseScheduledPrefix(text)` — extracts `[scheduled: ...]` pill        |

### REST surface

| Method | Path                                   | Notes                                                           |
|--------|----------------------------------------|-----------------------------------------------------------------|
| GET    | `/api/scheduled-tasks`                 | List user's tasks; each row includes `next_3_runs`, `last_run_cost_usd`, `last_run_duration_ms` |
| POST   | `/api/scheduled-tasks`                 | Create. Validates cron + TZ + `post_run_actions` + cycle check  |
| GET    | `/api/scheduled-tasks/:id`             | Get one (user-scoped); includes `last_run_cost_usd`, `last_run_duration_ms` |
| PATCH  | `/api/scheduled-tasks/:id`             | Partial update                                                  |
| DELETE | `/api/scheduled-tasks/:id`             | Soft remove + unregister cron                                   |
| POST   | `/api/scheduled-tasks/:id/run-now`     | Bypass cron, fire once                                          |
| GET    | `/api/scheduled-task-runs?task_id=...` | Paged run history                                               |
| GET    | `/api/scheduled-task-runs/:run_id`     | One run + in-flight events if subscribed                        |
| POST   | `/api/scheduled-task-runs/:run_id/cancel` | Best-effort cancel — sends to socket and marks `cancelled`   |
| GET    | `/api/profile/cost-today`              | User's running daily spend in USD                               |

### WebSocket events (outbound to subscribed clients)

- `scheduled_run_started { run_id, task_id, scheduled_for, target_kind, target_id }`
- `scheduled_run_progress { run_id, ... }` (optional)
- `scheduled_run_finished { run_id, task_id, status, error, cost_usd, duration_ms, output_snippet }`
- `text_delta`, `tool_use`, `tool_result` carry an optional `run_id` so the
  runs drawer can scope the live feed to a single run.

---

## Task model

```ts
type ScheduledTask = {
  id: string
  user_id: string
  name: string                        // composed as `<name_prefix> — <name_suffix>` (or just prefix)
  name_prefix: string | null          // server-computed, locked (see "Auto-name" below)
  name_suffix: string | null          // user-authored free-form note, optional
  task_type: 'prompt' | 'skill' | 'security_scan' | 'log_check' | 'continue_dev'
  target_kind: 'session' | 'supervisor' | 'all_agents' | 'all_supervisors'
  target_id: string | null            // required for session / supervisor
  payload: { prompt?: string, command?: string, args?: any }
  prompt: string                      // mirror of payload.prompt (see "Prompt storage" below)
  cron_expr: string                   // 5-field cron, validated via croner
  timezone: string                    // IANA, validated via Intl.DateTimeFormat
  catchup_policy: 'skip' | 'run_once'
  max_concurrent: number              // currently locked to per-session-queue semantics
  enabled: boolean
  post_run_actions: PostRunAction[]
}
```

### Prompt storage (column ↔ payload sync)

A `dev` task's custom prompt is persisted in **two** places that are kept in
lockstep on every write:

- the top-level **`prompt` column** — the single source of truth; the
  dispatcher's agent sender resolves the run text as
  `payload.prompt || prompt || 'Continue where you left off.'`
  (`hub/src/scheduler/senders/agent.ts` `buildContent`).
- **`payload.prompt`** — the canonical field the web editor reads/writes
  (`web/src/components/ScheduleEditor.tsx`).

Both the CREATE and PATCH handlers (`hub/src/api/scheduled-tasks.ts`) derive a
single `prompt` value (from `payload.prompt`, falling back to a top-level
`prompt` mirror in the request body) and write it to **both** the column and
`payload.prompt`, so they never drift. `updateTaskV2`
(`hub/src/db/scheduled-tasks-dal.ts`) accepts an explicit `prompt` field for the
column. The editor's load path falls back to the column
(`existing?.payload?.prompt ?? existing?.prompt`) so legacy rows that only ever
had the column populated still display.

Legacy rows (prompt in column but empty `payload.prompt`, or the reverse) are
reconciled by the idempotent one-shot
`hub/scripts/sync-task-prompt-payload.ts` (run via
`bun run hub/scripts/sync-task-prompt-payload.ts`; `--dry-run` reports only).
This is a one-shot, **not** in `schema.sql` (which re-runs every hub boot).

### Auto-name (prefix + suffix)

The `name_prefix` is **server-computed and locked** on every POST/PATCH from
`(task_type, target_kind, target_id, payload, cron_expr)` via
`hub/src/scheduler/auto-name.ts` (mirrors `web/src/lib/task-name.ts` for the
live preview in the editor). The user can append a free-form `name_suffix`
in a separate editable field; the final stored `name` is
`<prefix> — <suffix>` (or just `<prefix>` if no suffix).

Examples of what the prefix renders to:

- `Continue Dev on finedesignz/kh-hub every 4h`
- `Skill /lint on supervisor-coolify-1 daily at 09:00`
- `Log Check on app-abc123 every 15m`

API contract: new clients send `name_suffix`; the legacy `name` field is
still accepted for back-compat and is treated as a suffix when present.
Existing rows have NULL prefix/suffix and keep the legacy `name` value
until the next edit — at which point the server recomputes both columns.

### Task types (Phase 11)

User-pickable roots (three only — see Phase 11 narrowing):

- **dev** — general development run (replaces legacy `prompt`/`skill`/`continue_dev`)
- **security** — security scan workflow (replaces `security_scan`)
- **log_check** — Coolify log analysis workflow

Chained workflow step kinds (auto-created when a root is saved — PLAN.md decision #3):

- `dev_plan` → `dev_execute` → `dev_ship`
- `security_scan` → `security_triage` → `security_fix_or_issue`
- `log_pull` → `log_classify` → `log_triage`

Internal kind (NOT user-pickable; synthesized by Coolify webhook + classifier):

- **triage** — webhook-triggered Coolify deployment triage. Renders a structured
  prompt (see `hub/src/scheduler/triage-prompt.ts`), forces Claude to emit a
  `TriageResult` JSON (`error_type`, `severity`, `root_cause`, `suggested_fix`,
  `confidence`, `affected_files?`), and stores the validated JSON in
  `scheduled_task_runs.output_snippet`. On parse failure the run is marked
  `status='failed', error='triage_parse_error'`. **Wire-up status:** the
  `triage` task_kind, prompt template, schema, and parse helper are shipped
  (`hub/src/scheduler/triage-schema.ts`, `triage-prompt.ts`); the
  webhook-to-session routing (Phase 06 plan 008) is **pending Phase 04 plan
  008** (`pickSessionTarget` + `POST /api/sessions/heal`) being merged. Until
  then, triage runs from the webhook persist metadata but `dispatchTriageStub`
  is a no-op — they do not dispatch to a session.

### Target kinds

- **session** — single agent, identified by `target_id` (session id)
- **supervisor** — single supervisor by `target_id`
- **all_agents** — fan-out to every online agent for the user
- **all_supervisors** — fan-out to every online supervisor for the user

---

## Cron + timezone semantics

Cron expressions are 5-field (`m h dom mon dow`), parsed by
[croner](https://github.com/Hexagon/croner). Timezones are IANA names
validated by `Intl.DateTimeFormat`. The UI offers presets via
`compilePreset`:

| Preset                                  | Cron               |
|-----------------------------------------|--------------------|
| `{ kind: 'hourly' }`                    | `0 * * * *`        |
| `{ kind: 'daily', hh: 9, mm: 0 }`       | `0 9 * * *`        |
| `{ kind: 'every_n_minutes', n: 5 }`     | `*/5 * * * *`      |
| `{ kind: 'weekdays', hh: 8, mm: 0 }`    | `0 8 * * 1-5`      |
| `{ kind: 'custom', expr: '...' }`       | passthrough        |

The "next 3 runs" preview in the editor uses the same util as the hub —
both `hub/src/scheduler/cron.ts` and `web/src/lib/cron.ts` are kept
API-compatible.

---

## Schedule rules — active windows, end bounds, units (P1)

Structured `schedule_rules` (`hub/src/scheduler/schedule-rules.ts`, mirrored at
`web/src/lib/schedule-rules.ts`) are the user-facing schedule shape; each rule
is converted to a cron expression and registered as its own croner job. P1 adds
three additive, **backward-compatible** capabilities. A rule with only
`{interval, unit, start_at}` behaves exactly as before; no schema migration is
needed — bounds/window live inside the existing `schedule_rules` JSONB.

### Rule shape (after P1)

```ts
interface ScheduleRule {
  interval: number               // 1..999
  unit: 'minutes'|'hours'|'days'|'weeks'|'months'
  start_at: string               // ISO 8601

  active_window?: { from: "HH:MM"; to: "HH:MM" }   // 24h, task-local
  until?: string                 // ISO 8601 — stop firing at/after this instant
  max_runs?: number              // 1..100000 — stop after N TOTAL fires
  for?: { count: number; unit }  // convenience; normalized → `until` on write
}
```

### Units

| unit      | cron emitted                  | notes |
|-----------|-------------------------------|-------|
| `minutes` | `* * * * *` / `*/N * * * *`    | interval=1 → every minute; N → every N min from minute 0 |
| `hours`   | `MM * * * *` / `MM */N * * *`  | anchored on minute-of-hour of `start_at` |
| `days`    | `MM HH * * *` / `MM HH */N * *`| anchored on hh:mm |
| `weeks`   | `MM HH * * DOW`                | interval>1 registry-gated (cadence skip) |
| `months`  | `MM HH DOM * *`                | fires on `start_at` day-of-month every month; **interval>1 (every N months) is registry-gated** — `shouldSkipFire` skips off-months. DOM approximation: a `start_at` on the 29th–31st won't fire in shorter months (cron has no clamping). |

### Active window (`active_window`)

A fire is **skipped** when the current task-local wall-clock time is outside
`[from, to)` (inclusive start, exclusive end). Enforced per-rule in
`shouldSkipFire(rule, now, tz)` (the registry passes the task timezone).
**Overnight wrap** is supported: when `from > to` (e.g. `22:00`→`06:00`) the
window covers `22:00–23:59` AND `00:00–05:59`. `from === to` is rejected at
validation.

### End bounds (`until` / `max_runs` / `for`)

Bounds stop a task cleanly and **auto-disable** it:

- `until` — stop at/after an absolute instant.
- `max_runs` — stop after N **total** fires (any status: a skipped/quota-capped
  fire still consumes a slot; counted via `countFiresForTask` = `COUNT(*)` of
  `scheduled_task_runs` for the task).
- `for: {count, unit}` — convenience, **normalized to `until = start_at +
  count*unit` at save time** (`normalizeRulesForStorage` in the API create/patch
  handlers). Storage only ever carries `until`; the editor re-derives the
  toggle from `until` on load.

Bounds are **task-scoped** and enforced in `dispatcher.fire()` (the cron entry
point) — NOT in `shouldSkipFire`. When `boundReason(rules, now, totalFires)`
returns a reason, `fire()` calls `disableTaskWithReason(taskId, reason)`
(`enabled=false` + `payload.completed_reason`/`completed_at`), unregisters the
croner jobs, and skips the fire (no run row). Manual `run-now` and chained runs
go through `runNow`, which **intentionally bypasses bounds**. Reasons:
`bound_until`, `bound_max_runs`.

---

## Web UI

### Cron builder (`web/src/components/CronBuilder.tsx`)

The editor no longer exposes a raw cron text input. `CronBuilder` is a
dropdown-driven composer with 8 modes:

| Mode              | Output                                          |
|-------------------|-------------------------------------------------|
| Every N minutes   | `*/N * * * *`                                   |
| Every N hours     | `0 */N * * *`                                   |
| Every N days      | `0 H * * *` (day-step folded into daily preset) |
| Every N months    | `0 H 1 */N *`                                   |
| Daily             | `M H * * *`                                     |
| Weekly            | `M H * * DOW,DOW,...` (multi-select chips)      |
| Monthly           | `M H D * *`; **`D = "Last day"`** maps to `L`   |
| Custom (5-field)  | Passthrough; validated via `cron.ts`            |

A common-presets quick row sits above the mode picker (hourly, every 15
min, weekdays 9am, etc.). Below the controls the builder shows a
read-only cron string, a plain-English summary from
`humanizeCron(expr)`, and the next-3-runs preview rendered in the task's
selected timezone.

`humanizeCron` (`web/src/lib/cron-humanize.ts`) is shared with the list
row, so "Every week on Mon, Wed, Fri at 09:30" appears in both surfaces.
Unrecognized custom expressions fall back to the raw cron string.

### Schedules list (`web/src/components/SchedulesPage.tsx`)

Toolbar above the list:

- **Search-by-name** — substring match on `task.name`
- **Status segmented control** — `All | Enabled | Disabled`
- **Task-type dropdown** — `All | prompt | skill | security_scan | log_check | continue_dev`

Filters are client-side and AND-combined.

Each row carries last-run metrics from the list endpoint:

```
<task name>                  Every weekday at 09:00 (PDT)
<status> · $0.0034 · 12.3s   Next: May 25, 9:30 AM PDT · Fired 4m ago
```

- Cost/duration chips render with `formatCostUsd` / `formatDuration`
  from `web/src/lib/format.ts`.
- `Next:` is rendered in the task's own timezone with the short TZ
  abbreviation.
- `Fired Xm ago` appears via `formatRelativeAgo` when `last_fire_at` is
  set on the task.

### Runs drawer (`web/src/components/ScheduleRunsDrawer.tsx`)

Status filter chips with live counts:
`All | Success | Failure | Skipped | Running | Cancelled`. Filter is
client-side over the currently loaded window.

A summary stats banner sits above the run list and shows:

- Total runs (in the loaded window)
- Success rate (`success / total`, as a percentage)
- Total cost in USD
- Average duration in ms

### Scheduled-run badge in chat

When a scheduled task fires against an agent, the user message persisted
to chat history is unchanged in shape:

```
[scheduled: <task name>]

<original prompt>
```

In the web UI, `parseScheduledPrefix` (`web/src/lib/scheduled-message.ts`)
splits that prefix off and renders it as a styled indigo pill —
`Scheduled: <task name>` — above the prompt body inside the message
bubble (`web/src/components/MessageBubble.tsx`). The prefix never appears
inline as plain text.

---

## Catch-up on boot

On hub start, `scheduler/catchup.runOnce()` walks each enabled task and
collects every fire that would have happened between its `last_fire_at`
(or `created_at` if never fired) and now, capped at 100.

- **`catchup_policy = 'skip'`** — every missed slot inserts a
  `scheduled_task_runs` row with `status='skipped', error='catchup'`. No
  dispatch. Use this for log-checks or anything where late firing is noise.
- **`catchup_policy = 'run_once'`** — every missed slot except the most
  recent inserts a `skipped(catchup)` row; the most recent missed slot is
  dispatched normally via `runNow`. Use this for "I want the work done as
  soon as I'm back online."

The cap exists so a hub that was offline for weeks doesn't queue thousands
of fires.

---

## Daily cost cap

Each user has `users.daily_cost_cap_usd` (default 10.0000). On every fire,
the dispatcher delegates to the shared `isOverCostCap(userId, timezone)` in
`hub/src/dispatch/gates.ts` (single source of truth) and compares against the cap.

- **P3a (2026-05): the cap counts REAL accumulated token cost.** It now sums
  `token_usage.cost_usd` for TODAY (the user's tz) via `getTodayTokenCostUsd`,
  the SAME tz-day boundary `GET /api/usage/cost` "today" uses. That ledger
  captures EVERY turn emitting a `usage_event` over `/ws/agent` — interactive
  chat, Telegram, webhooks **and** scheduled runs. So **manual / interactive
  chat IS now capped**, not just scheduled runs (the old behaviour summed only
  `scheduled_task_runs.cost_usd`). Single source = `token_usage`; the gate does
  NOT also add `scheduled_task_runs.cost_usd`, so scheduled-run cost is **not
  double-counted** (it's already in `token_usage`).
- **Timing:** the cap is checked BEFORE a turn dispatches, but a turn's cost is
  only known AFTER it completes (`usage_event` is post-turn). The turn that
  crosses the cap is allowed to start; the NEXT dispatch is blocked once
  accumulated cost `>= cap`. We do not pre-estimate the pending turn.
- If `spent >= cap`, the dispatcher inserts ONE run row with
  `status='skipped', error='daily_cost_cap'` and emits
  `scheduled_run_finished` immediately. No agent message is sent. (Interactive /
  Telegram blocks surface `over_daily_cost_cap:$<spent>>=$<cap>` via the gate.)
- A boundary value of exactly `cap` is considered over (>=, not >).
- Cap `<= 0` disables enforcement (documented escape hatch). The
  `daily_cost_cap_usd` column is NOT NULL DEFAULT 10, so a null cap coalesces to
  the legacy $10 default (still capped).

The UI surfaces today's spend at `GET /api/profile/cost-today` and lets the
user adjust their cap on the Settings → Account tab.

---

## Per-session queue (Round-2: shared dispatch pipeline)

A single agent session admits at most one in-flight scheduled run plus one
waiter. The 3rd enqueue while a slot is still busy is **dropped** (finalized
`skipped(session_busy)`). As of the Round-2 migration, this queue lives in the
shared `hub/src/dispatch/` pipeline (`dispatch()` + `onSessionReply()`), not in
the scheduler's own module: the agent sender (`senders/agent.ts`) is a thin
adapter that calls `dispatch(req, deps)`.

**Promotion** is now driven by the agent's `assistant_message`, not the
`thinking → idle` status transition. When the in-flight run's reply lands, the
agent ws branch calls `dispatch.onSessionReply(sessionId, content)` →
`RunStore.onFinalize` (→ `finalizeRun(success)`, which fires the post-run
pipeline) → the pipeline promotes the queued waiter and **re-dispatches it
through the full gate list again** (`[thresholdGate, dailyCostCapGate]`). A user
who crossed the cost cap while queued is therefore skipped on promotion (IR-2) —
this replaces the legacy `session-queue.setOnPromote` + `onSessionIdleAndPromote`
seam (now dead; `dispatcher.init()` is a retained no-op).

This caps notification spam and prevents pile-ups when a long task overruns
its cadence.

---

## Agent sender — summary directive

`hub/src/scheduler/senders/agent.ts` sends two distinct strings:

1. **Stored** in `messages` (chat history) — unchanged shape:
   `"[scheduled: <task name>]\n\n<prompt>"`. The UI strips the prefix
   into the indigo `Scheduled:` pill.
2. **Sent to Claude's stdin** — the stored content plus a trailing
   directive:

   > When finished, end your response with a single line starting with
   > `Summary:` describing in 1-2 sentences what you accomplished or
   > any blocker.

This forces every scheduled run to end with a one-line summary that the
runs drawer, output snippet, and template variables can quote without
parsing the whole assistant turn. Only the **sent** content carries the
directive — chat history stays clean.

Round-2 note: the directive + the Phase-11 `## RUNTIME CONTEXT` block are now
applied inside the dispatch adapter's `send` thunk (`senders/agent.ts`), so they
ride only on the `user_message` frame put on the agent socket. The
`runtime_context_snapshot` persisted on `scheduled_task_runs` and the stored
`messages` content are unchanged — neither carries the directive (Phase 11
invariant: the snapshot lives on the run row, never in `messages`).

---

## Offline grace (Round-2: shared grace buffer)

Offline parking now uses the shared `hub/src/dispatch/grace.ts`
`getGraceBuffer()` (the standalone `scheduler/grace.ts` was deleted):

- **Session targets** (`session` / `all_agents`): the dispatcher no longer
  pre-checks `online` — the run falls through to the agent sender. When the
  session runner is offline the sender now **auto-launches the session** before
  parking (see *Offline-session autostart* below). On agent reconnect,
  `getGraceBuffer().drain(sessionId)` re-runs the parked `replay` thunk
  (`runNow(task.id)`) so the freshly-launched runner receives the prompt and the
  user sees the run execute live. TTL lapse (10 min) fires `onParkExpire` →
  `skipped(target_offline)`.
- **Supervisor targets** (`supervisor` / `all_supervisors`): the dispatcher
  keeps its offline pre-check + concurrency gate, but registers the offline
  replay in the same shared buffer keyed by `supervisorId` (replay = mark old
  row `replayed_on_reconnect` + `runNow`). Drained on supervisor reconnect.

The shared buffer's 60-second sweep marks any entry past its 10-minute TTL via
the registered `onExpire` side-effect (legacy parity).

### Offline-session autostart (Phase 14)

Previously an offline **session** target wasted every scheduled run: it parked in
grace and, if the runner never reconnected on its own, expired as
`skipped/target_offline`. A 4-hour task pointed at a session the user wasn't
actively running would log 0 successes.

Now `senders/agent.ts` proactively **launches** the session when its host
(supervisor) is online, via the shared, gate-respecting
`launchSessionForUser({ userId, sessionId })` (`hub/src/telegram/launch.ts`) — the
SAME path the Telegram `/doctor` autoheal uses. Concurrency (`reserveSessionSlot`)
and the cost-cap gate stay enforced; no parallel `session.start` path is minted.
Flow when `getChannel(sessionId) == null`:

| Launch outcome | Run result |
|---|---|
| `ok` (session.start fired) | fall through to `dispatch()` → parked in grace; launched runner connects → drain → `runNow` → delivered live. **Not** `target_offline`. |
| already pending (`launch_pending`) | `skipped/launch_pending` — dedup: one launch + one grace entry per session (a 4h task that keeps finding the session offline does not stack `session.start` calls or double-deliver). |
| `at_capacity` | `skipped/at_capacity` (informative, not `target_offline`). |
| `no_online_supervisor` (host truly offline) | unchanged: scheduled runs fall through to grace park → TTL lapse `skipped/target_offline`; **manual** runs fail fast `target_offline`. |
| `supervisor_ambiguous` / `no_project_dir` / `session_not_found` / `send_failed` / `internal_error` | `skipped/<reason>`. |

**Dedup** keys off the grace buffer: a live pending entry for the `sessionId`
means a launch is already in flight, so the next fire skips the duplicate
`session.start`. **Manual ("run now")** also launches; only when the host itself
is offline does it keep the immediate fail-fast `target_offline` feedback.

---

## Post-run actions

After a run finalizes (`status` in `success | failed | skipped | cancelled`),
the dispatcher iterates `task.post_run_actions` and fires every action
whose `on` condition matches. Each action has an optional `delay_seconds`
(setTimeout, tracked for shutdown cancellation).

### Action types

| `type`              | `config`                                          | Notes                                           |
|---------------------|---------------------------------------------------|-------------------------------------------------|
| `chain_task`        | `{ task_id }`                                     | Triggers `dispatcher.runNow` on the target task |
| `notify_email`      | `{ to?, subject, body }`                          | POSTs to emails4agents; `to` defaults to user   |
| `notify_telegram`   | `{ body }`                                        | Sends via the user's Telegram integration       |
| `notify_web_push`   | `{ title?, body }`                                | Broadcasts to subscribed browsers via WS        |
| `webhook`           | `{ url }`                                         | POST JSON with `X-Remo-Signature: sha256=...`   |
| `github_issue`      | `{ repo_full_name, labels?, assignees? }`         | Creates a GitHub issue from a `triage` run result; gateway-pair creds |

### `on` conditions

- `success` — run status is exactly `success`
- `failure` — run status is `failed`, `skipped`, or `cancelled`
- `always` — fires regardless of outcome
- `cost_exceeded` — only matches `error === 'daily_cost_cap'`

### Template variables

Subject/body/payload fields support `{{var}}` substitution. The email
variant HTML-escapes substituted values; webhook payloads ship raw.

Available variables: `task_name`, `task_id`, `status`, `error`,
`output_snippet`, `cost_usd`, `duration_ms`, `run_url`, `user_id`,
`chain_depth`, and (for fan-out parents) `aggregate_total`,
`aggregate_successes`, `aggregate_failures`.

### Chain depth cap

`MAX_CHAIN_DEPTH = 5`. A 6th-level chained `runNow` finalizes the run as
`failed(chain_depth_exceeded)` and does not dispatch further actions. The
REST router also rejects chain cycles at write time
(`detectChainCycles` returns `{ ok: false, cycle: [...] }` → 400 with
`{ error: 'chain_cycle', path: [...] }`).

### Fan-out aggregator

For `target_kind` in `all_agents` / `all_supervisors`, the dispatcher
creates N child runs but only fires post-run actions ONCE per parent fire,
via `scheduler/post-run/aggregator.ts`:

- Register a bucket on dispatch with `expectedCount = targets.length`.
- Each child finalize calls `aggregator.report(parentFireId, ...)`.
- When `results.length === expected` (or 5-min timeout elapses) the
  aggregator computes `aggregateStatus` (success iff all succeeded; failed
  otherwise) and calls `fireWithContext` once.
- Aggregate counts surface in template vars
  (`aggregate_total/successes/failures`).
- Buckets are in-memory only — hub restart drops any in-flight aggregates
  (documented limitation; restart sweeper sends nothing).

---

## Auto-dev: propose-to-chat + HITL (P3)

When the dev controller (`dev`/`dev_controller`, see Phase 11 + auto-dev P2)
emits `action=propose` — there is no plan AND no clear goal — the post-run
router does NOT chain. Instead it **surfaces the roadmap to chat** and waits for
a human. `propose` NEVER auto-builds.

Flow (`hub/src/scheduler/post-run/propose-notify.ts`):

1. **Surface** — `surfaceProposal()` parses the decision's `roadmap` (the
   controller template emits `" | "`-separated features on one line), formats a
   numbered, actionable message ("Routine X has no plan or goal and proposes: …
   Reply with the number(s) or text to approve"), and sends it via the existing
   `notify_email` + `notify_telegram` post-run senders (synthesized in-memory
   actions — nothing persisted to `post_run_actions`).
2. **Throttle/dedupe** — reuses `notifications_sent` with
   `kind='propose_roadmap'`, `dedupe_key = <taskId>:<sha256(roadmap)[:16]>`,
   TTL `PROPOSE_TTL_SECONDS` (6h). A routine that keeps ticking `propose` with
   the same roadmap notifies once per window; a changed roadmap re-notifies.
3. **Pending state** — the proposal (`{roadmap, items, run_id, proposed_at}`) is
   persisted under the task's `payload.pending_proposal` (JSONB; **no new
   table**). The #214 `prompt`/`payload.prompt` mirror is left untouched.
4. **HITL capture** — an inbound chat reply (`captureApprovalReply`, called from
   the Telegram webhook before `dispatchToSession`) that is an unambiguous
   numeric selection ("1", "1, 3") writes the chosen item(s) into the routine's
   `payload.notes` and clears `pending_proposal`. `requireSelection` keeps
   unrelated chat from being hijacked; free-form replies fall through to a normal
   session dispatch.
5. **Loop close** — `buildRuntimeContext` surfaces `payload.notes` as `user_goal`
   in the `## RUNTIME CONTEXT` block. The NEXT controller tick now sees a stated
   goal and chooses `plan` (per the controller decision tree) instead of
   `propose`.

DB: `notifications_sent` CHECK constraint gains `'propose_roadmap'` (idempotent
ALTER, re-runs every boot). DAL helpers: `setPendingProposal`,
`findPendingProposalTasksForUser`, `captureProposalNotes` in
`hub/src/db/scheduled-tasks-dal.ts`.

Tests: `hub/test/propose-notify.test.ts` (parse/format/resolve, throttle/dedupe,
capture), `hub/test/dev-controller-routing.test.ts` (propose → surface, no chain;
non-propose → no surface).

---

## Coolify webhook ingress (Phase 06)

Public webhook endpoint that turns Coolify deployment events into
`scheduled_task_runs` rows with deployment metadata. Failed deployments
queue a `triage` run (routing wire-up pending — see status note in
"Task types → triage" above); succeeded / in-progress events insert a
metadata row only (no LLM spend).

- **Endpoint:** `POST /api/coolify/webhook/:user_id` (public — auth is
  per-user HMAC, not JWT)
- **Module:** `hub/src/api/coolify-webhook.ts`
- **Required headers:**
  - `X-Coolify-Signature: sha256=<hex>` — HMAC-SHA256 over
    `${X-Coolify-Timestamp}.${rawBody}`, constant-time compared
  - `X-Coolify-Timestamp: <unix-seconds>` — rejected if skew > 5 minutes
- **Secret management:** per-user secret in `users.coolify_webhook_secret`.
  Rotated via `POST /api/account/coolify-webhook-secret/rotate` (JWT
  authed); status fetched via `GET /api/account/coolify-webhook-secret`
  (returns existence + last rotated, never the secret itself).
- **Persisted deployment metadata** (new nullable columns on
  `scheduled_task_runs`):
  - `deployment_uuid TEXT`
  - `application_uuid TEXT`
  - `git_repository TEXT`
  - `commit_sha TEXT`
- **Event mapping:**
  - `deployment.failed` → row inserted with metadata; triage dispatch
    stubbed (awaits plan 008)
  - `deployment.succeeded` / `deployment.in_progress` → metadata-only row,
    `status='success'`, no spend
- **Response:** `202 { ok: true, run_id }`

See [coolify-webhook-migration.md](./coolify-webhook-migration.md) for the
end-to-end migration plan from `coolify-ai-monitor` and full setup steps.

---

## Log classifier (Phase 06 — pending wire-up)

`hub/src/scheduler/log-classifier.ts` is the planned 16-pattern regex gate
that runs over `log_check` output BEFORE any LLM spend. If `hasErrors ===
false`, the dispatcher finalizes the run as `status='success',
output_snippet='[no errors detected]'` and **skips post-run actions
entirely** to preserve the daily cost cap. Triage runs (from the webhook)
bypass the classifier — they're already known-failed.

**Status:** Phase 06 plans 002 (`log-classifier.ts`) and 003
(coolify-sender wire-up) have **not yet shipped** to this branch. The
patterns and severity tags are spec'd in
`.planning/phases/06-self-heal-absorb/06-CONTEXT.md`; when the module
lands, this section gets the file path + the final pattern set and the
"When adding a new task type..." paragraph below stays accurate.

---

## GitHub-issue post-run action (Phase 06)

`github_issue` is a new `post_run_actions` type that creates a GitHub
issue from a `triage` run result.

- **Module:** `hub/src/scheduler/post-run/github-issue.ts`
- **Config (per scheduled task):**
  ```ts
  {
    type: 'github_issue',
    on: 'failure' | 'always' | ...,
    config: {
      repo_full_name: 'owner/repo',
      labels?: string[],
      assignees?: string[],
    }
  }
  ```
- **Credentials:** loaded from the gateway pair
  (`GET {GATEWAY_URL}/api/credentials/service/github` → `{ token }`),
  with `FALLBACK_GATEWAY_URL` used if the primary fails. There is **no
  `GITHUB_TOKEN` env var on the hub** — per global rule #19 / the MCP
  server auth architecture, third-party creds live in the gateway only.
- **Idempotency:** `sha256(repo|application_uuid|deployment_uuid)`. The
  `github_issue_idempotency` table records each issued hash with a
  24-hour window — duplicate hashes inside that window are skipped (no
  duplicate issues for the same failed deployment).
- **Issue body:** rendered via `post-run/template.ts` using `TriageResult`
  fields as template vars (`{{error_type}}`, `{{severity}}`,
  `{{root_cause}}`, `{{suggested_fix}}`, `{{confidence}}`, plus the
  standard run vars).
- **Severity → label:** `severity:high`, `severity:critical`, etc. are
  added on top of the user-supplied `labels`.
- **Failure mode:** Octokit errors are logged only — they never fail the
  parent run.

---

## Environment variables

The scheduler does not introduce new required env vars. Optional vars:

| Var                | Used by                          | Default                          | Purpose                                              |
|--------------------|----------------------------------|----------------------------------|------------------------------------------------------|
| `REMO_PUBLIC_URL`  | `post-run/dispatcher.ts`         | `https://app.remo-code.com`      | Prefix for `{{run_url}}` template variable           |
| `COOLIFY_TOKEN`    | `senders/coolify.ts` (`log_check`)| —                               | Coolify API auth for `log_check` task type           |
| `E4A_API_KEY`      | `post-run/email.ts`              | —                                | emails4agents key for `notify_email` action          |
| `E4A_BASE_URL`     | `post-run/email.ts`              | `https://api.emails4agents.com`  | emails4agents base URL                               |
| `E4A_INBOX_ID`     | `post-run/email.ts`              | —                                | Inbox to send through                                |
| `REMO_E2E_DB_URL`  | `hub/test/scheduled-tasks.e2e.test.ts` | —                          | Disposable Postgres for e2e tests (skipped if unset) |

Per the global rule, email notifications always default to **emails4agents**
— never SendGrid/Postmark/Mailgun/Resend without explicit user request.

---

## Notes-field templates (web editor UX)

For structured task types (`continue_dev`, `log_check`, `security_scan`)
the editor pre-fills the **Notes** textarea with a starter prompt template
defined in `web/src/lib/task-templates.ts`. Behavior:

- New schedule → notes pre-populated with the matching template.
- Switching task type → swaps in the new template, but only if current
  notes are empty OR still exactly match a known template (preserves user
  edits via `isReplaceableNotes`).
- Editing an existing schedule → never overwritten; saved value loads as-is.

Post-run actions (`PostRunActionsEditor`) similarly pre-fill `config` with
sensible `{{template_var}}` defaults on action create + type-change via
`defaultActionConfig()` — email subject/body, Telegram body, web-push
title/body, etc. Empty config is no longer the default.

When adding a new templated task type, drop the prompt body into
`web/src/lib/task-templates.ts` and register it in `TASK_TEMPLATES`.

---

## How to add a new task type

1. Add the new enum value to `TaskTypeEnum` in
   `hub/src/api/scheduled-tasks.ts` and to the `TaskType` union in
   `hub/src/db/scheduled-tasks-dal.ts`.
2. Add a sender at `hub/src/scheduler/senders/<name>.ts`. For a SESSION-targeted
   type, model it on the Round-2 `senders/agent.ts` adapter: build a `RunStore`
   over the existing run row + `PipelineDeps` (gates `[thresholdGate,
   dailyCostCapGate]`, `isOnline`, `replay`, `onParkExpire`, `send`) and call
   `dispatch(req, deps)` from `hub/src/dispatch/pipeline.ts`. Finalize lands via
   `RunStore.onFinalize` (driven by `dispatch.onSessionReply` in
   `hub/src/ws/agent.ts`), which calls
   `finalizeRun(runId, status, error?, { cost_usd, duration_ms, output_snippet })`
   — that is the seam that fires the post-run action pipeline. A non-session
   (supervisor/coolify) sender owns its own lifecycle directly.
3. Add a `case 'your_type':` branch to `routeToSender` in
   `hub/src/scheduler/dispatcher.ts` that dynamically imports your sender.
4. A session-targeted type does NOT touch `scheduler/session-queue.ts` (the
   back-compat shim) — the shared `dispatch()` pipeline owns the per-session
   queue + promotion. Offline parking goes through `getGraceBuffer()`.
5. Add a UI radio option in `web/src/components/ScheduleEditor.tsx` and a
   payload editor.
6. Add a unit test in `hub/test/scheduler.test.ts` for any new pure-logic
   helper your type introduces.

---

## How to add a new post-run action type

1. Extend the discriminated union in
   `hub/src/scheduler/post-run/schema.ts` with a new variant (zod `object`
   with `type: z.literal('your_type')` and a `config` shape).
2. Add an executor at `hub/src/scheduler/post-run/<your_type>.ts`
   exporting `executeYourType(action, { userId, templateVars, payload? })`.
3. Wire it into the `switch` in
   `hub/src/scheduler/post-run/dispatcher.ts` (`executeAction`).
4. Extend the editor at `web/src/components/PostRunActionsEditor.tsx`
   with a type-specific config block.

---

## Testing

- **Unit tests:** `cd hub && bun test test/scheduler.test.ts` — 41 tests
  cover cron, queue, catch-up math, post-run schema + cycle detector,
  template renderer, condition matcher, aggregator, chain depth cap.
- **E2E:** `cd hub && REMO_E2E_DB_URL=... bun test test/scheduled-tasks.e2e.test.ts`.
  Without `REMO_E2E_DB_URL`, the e2e cases are skipped.

---

## Phase 11 — Structured workflows + runtime context

**Task-type narrowing.** Three user-pickable roots (`dev`, `security`,
`log_check`) plus nine chained step kinds plus internal `triage`. Legacy
`prompt`/`skill`/`continue_dev` rewritten to `dev` by the schema migration
in `hub/src/db/schema.sql` (commit `b9edb82`) and the standalone data
script `hub/scripts/migrate-task-kinds.ts`. The legacy `prompt` column
is preserved verbatim — no auto-explosion (PLAN.md decision #7).

**Workflow chaining.** A `dev`/`security`/`log_check` save creates three
pre-chained `scheduled_tasks` rows; each step has its own `chain_task`
post-run action pointing at the next step's task id. `nextStepInWorkflow`
in `hub/src/scheduler/workflows.ts` is the canonical ordering table and
is consulted by `post-run/chain.ts` for audit logging (mismatched edges
are logged, never blocked — chain_task remains authoritative).

**Workflow templates.** Prompt templates live as static repo `.md` files
under `hub/src/scheduler/prompts/<workflow>/<step>.md`. Loader at
`hub/src/scheduler/prompts/loader.ts`. Nine step files shipped:

- `dev/plan.md`, `dev/execute.md`, `dev/ship.md`
- `security/scan.md`, `security/triage.md`, `security/fix-or-issue.md`
- `log_check/pull.md`, `log_check/classify.md`, `log_check/triage.md`

Each template is interpolated with `{{user_prompt}}` (one shared slot
across all three steps per PLAN.md decision #2), `{{runtime_context}}`,
and `{{prior_step_output}}`.

**Runtime context injection.** `hub/src/scheduler/context/build.ts`
assembles a JSON object from: project type (`context/project-type.ts`),
deploy target (`context/deploy-target.ts`), version (`context/version.ts`),
global-rules digest (`context/global-rules-digest.ts`), design preferences
(`context/design-preferences.ts`). The agent sender prepends a
`## RUNTIME CONTEXT` block BEFORE `## TASK`; the `Summary:` directive
stays at the very end. The exact JSON is persisted to
`scheduled_task_runs.runtime_context_snapshot` (new nullable JSONB) for
audit + repro; the rendered string is NOT written to `messages` (the
existing invariant that runtime-only directives never enter chat history).

**UI compaction.** `web/src/components/ScheduleEditor.tsx` replaced the
card-grid task-type picker with a single `<select>` (three options) and
the target picker with a sibling `<select>`. Desktop layout switched to
`md:grid-cols-2`/`md:grid-cols-3` groupings; mobile stacking unchanged.

**Cost cap.** Per-user-per-day. A workflow CAN be cut mid-chain when the
cap trips between steps (PLAN.md decision #4 — status quo).

---

## Known follow-ups

- Drop the legacy v0 scheduler (`hub/src/scheduler/index.ts`) once we've
  confirmed there are no v0-shaped tasks in production.
- Add a `users.timezone` column to drive `sumTodayCostForUser` so users in
  TZs other than UTC see the right "today" boundary without per-task TZ
  inheritance.
- `scheduled_task_runs.session_id` should be `NOT NULL` for all
  `target_kind = 'session'` rows — currently nullable while migration is
  in flight.
- Wire a test Postgres harness (pg-mem or testcontainers) so the e2e file
  can run in CI without manual env setup.

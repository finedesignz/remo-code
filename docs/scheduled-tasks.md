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
| `hub/src/scheduler/session-queue.ts`      | Per-session FIFO (1 in-flight + 1 waiter; further dispatches dropped)  |
| `hub/src/scheduler/targets.ts`            | Resolves `target_kind` → list of `{kind, sessionId?, supervisorId?}`   |
| `hub/src/scheduler/dispatcher.ts`         | Cost cap, fan-out, per-target run rows, route to sender                |
| `hub/src/scheduler/senders/agent.ts`      | Writes `user_message` to an agent socket, captures result + cost       |
| `hub/src/scheduler/senders/supervisor.ts` | `run_command` against a supervisor socket (`run_started/output/finished`)|
| `hub/src/scheduler/senders/coolify.ts`    | Hub-local `log_check` via Coolify deploy/logs API                      |
| `hub/src/scheduler/catchup.ts`            | On boot: walk missed fires per task (cap 100), respect `catchup_policy`|
| `hub/src/scheduler/grace.ts`              | 10-min offline buffer; replays pending runs on agent/supervisor auth   |
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
  name: string
  task_type: 'prompt' | 'skill' | 'security_scan' | 'log_check' | 'continue_dev'
  target_kind: 'session' | 'supervisor' | 'all_agents' | 'all_supervisors'
  target_id: string | null            // required for session / supervisor
  payload: { prompt?: string, command?: string, args?: any }
  cron_expr: string                   // 5-field cron, validated via croner
  timezone: string                    // IANA, validated via Intl.DateTimeFormat
  catchup_policy: 'skip' | 'run_once'
  max_concurrent: number              // currently locked to per-session-queue semantics
  enabled: boolean
  post_run_actions: PostRunAction[]
}
```

### Task types

- **prompt** — sends a free-form prompt to a Claude Code agent
- **skill** — sends `/<skill-name>` to invoke a registered skill
- **security_scan** — preset shortcut: skill `/security-review`
- **continue_dev** — preset shortcut: `/gsd-fast` or similar
- **log_check** — hub-local; pulls Coolify logs and analyzes (no agent)
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
the dispatcher calls `sumTodayCostForUser(userId, timezone)` and compares
against the cap.

- If `spent >= cap`, the dispatcher inserts ONE run row with
  `status='skipped', error='daily_cost_cap'` and emits
  `scheduled_run_finished` immediately. No agent message is sent.
- A boundary value of exactly `cap` is considered over (>=, not >).
- Cap `<= 0` disables enforcement (documented escape hatch).
- We use query-time summation rather than a per-user reset job — see
  `hub/src/scheduler/daily-reset.ts` (alternative left in place for the
  case where summation becomes too slow at scale).

The UI surfaces today's spend at `GET /api/profile/cost-today` and lets the
user adjust their cap on the Settings → Account tab.

---

## Per-session queue

A single agent session admits at most one in-flight scheduled run plus one
waiter. The 3rd enqueue while a slot is still busy is **dropped** (the
caller finalizes that run as `skipped(session_busy)`). When the agent
transitions thinking → idle, `onSessionIdleAndPromote(sessionId)` promotes
the waiter and notifies the dispatcher to ship it.

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

---

## Offline grace

When `resolveTargets` returns a target with `online: false`, the dispatcher
inserts the run as `pending` and registers it in
`scheduler/grace.ts` keyed by session/supervisor id. On agent/supervisor
WebSocket auth success, `drainPending(key)` re-dispatches any runs created
within the last 10 minutes. Older pending runs are swept to
`skipped(target_offline)` by a 60-second background timer.

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

## How to add a new task type

1. Add the new enum value to `TaskTypeEnum` in
   `hub/src/api/scheduled-tasks.ts` and to the `TaskType` union in
   `hub/src/db/scheduled-tasks-dal.ts`.
2. Add a sender at `hub/src/scheduler/senders/<name>.ts` exporting an
   async function with signature `(task, runContext) => Promise<void>`.
   The sender owns the lifecycle from "send to target" through
   `finalizeRun(runId, status, error?, { cost_usd, duration_ms, output_snippet })`.
3. Add a `case 'your_type':` branch to `routeToSender` in
   `hub/src/scheduler/dispatcher.ts` that dynamically imports your sender.
4. If the type fans out to agents, honor the per-session queue
   (`scheduler/session-queue.ts`).
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

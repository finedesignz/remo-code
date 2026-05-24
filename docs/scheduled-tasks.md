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

### REST surface

| Method | Path                                   | Notes                                                           |
|--------|----------------------------------------|-----------------------------------------------------------------|
| GET    | `/api/scheduled-tasks`                 | List user's tasks; each row includes `next_3_runs`              |
| POST   | `/api/scheduled-tasks`                 | Create. Validates cron + TZ + `post_run_actions` + cycle check  |
| GET    | `/api/scheduled-tasks/:id`             | Get one (user-scoped)                                           |
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

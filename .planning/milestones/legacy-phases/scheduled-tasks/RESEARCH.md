# Research — Scheduled Tasks

## Cron engine choice: `croner`

| Criterion | croner | node-cron | node-schedule |
|---|---|---|---|
| Bun-native | ✅ pure ESM | ⚠️ CJS-leaning | ⚠️ heavy deps |
| IANA TZ | ✅ built-in | ⚠️ via plugin | ✅ |
| `nextRun()` introspection | ✅ `nextRuns(n)` | ❌ | ⚠️ partial |
| Pause/resume | ✅ | ❌ recreate | ✅ |
| Overrun protection | ✅ | ❌ | ⚠️ |
| Bundle size | ~5KB | ~15KB | ~50KB |

**Pick:** `croner`. Install: `bun add croner` in `hub/`.

Usage sketch:
```ts
import { Cron } from 'croner'
const job = new Cron(task.cron_expr, { timezone: task.timezone, name: task.id, protect: true }, () => dispatcher.fire(task))
// task.next_fire_at = job.nextRun()?.toISOString()
// job.stop() on disable/delete
```

## Reuse vs new code

| Need | Reuse | New |
|---|---|---|
| Send prompt to Claude session | ✅ existing `user_message` over `/ws/agent` (handler at `hub/src/ws/agent.ts:147`-ish) | — |
| Send slash command | ✅ same path — Claude CLI parses leading `/` | — |
| Get list of online sessions per user | ✅ `registry.ts` connectedSessions + DB `sessions.status='online'` | — |
| Get list of online supervisors | ✅ `supervisor-registry.ts` | — |
| Supervisor command catalog (validate skills exist) | ✅ `supervisor_commands` table (already populated by command sync) | — |
| Run a skill on a supervisor (no Claude session involved) | — | New WS msg `supervisor.run_command` + reply events |
| Read Coolify/server logs | — | New hub-local executor that calls Coolify API (creds in `~/.claude/secrets/services.json`) |
| Live run streaming to web | partial — existing activity events | Tag activity events with `run_id` for UI grouping |
| Persistence | ✅ Postgres + auto-migrate via `hub/src/db/migrate.ts` | New tables |

## Catch-up math

On scheduler boot, for each enabled task:
```ts
const job = new Cron(task.cron_expr, { timezone: task.timezone })
const since = task.last_fire_at ?? task.created_at
// Walk forward fires that should have fired between `since` and now
const missed = []
let cursor = since
while (true) {
  const next = job.nextRun(cursor)
  if (!next || next > new Date()) break
  missed.push(next)
  cursor = next
}
```
- `catchup_policy = 'skip'`: insert one `runs` row per missed fire with `status='skipped'`.
- `catchup_policy = 'run_once'`: insert only the last `missed[missed.length-1]` and dispatch it.
- Cap missed at 100 to avoid pathological backlogs after a long outage.

## Per-session queue

```ts
// hub/src/scheduler/session-queue.ts
const queues = new Map<sessionId, { inflight: RunId|null; waiter: RunId|null }>()
function enqueue(sessionId, runId): 'inflight'|'queued'|'dropped' { ... }
function onSessionIdle(sessionId) { promote waiter → inflight, dispatch }
```
Hook `onSessionIdle` to existing `status: idle` event at `agent.ts:184`-ish.

## API endpoints (Hono routes; new `hub/src/api/scheduled-tasks.ts`)

```
GET    /api/scheduled-tasks
POST   /api/scheduled-tasks
GET    /api/scheduled-tasks/:id
PATCH  /api/scheduled-tasks/:id
DELETE /api/scheduled-tasks/:id
POST   /api/scheduled-tasks/:id/run-now
GET    /api/scheduled-tasks/:id/runs?limit=50&before=ts
GET    /api/scheduled-task-runs/:run_id
POST   /api/scheduled-task-runs/:run_id/cancel
```

Wire into `hub/src/index.ts` alongside existing routers. Reuse `authMiddleware`.

## WS events (`/ws/client`, schema in `hub/src/ws/protocol.ts`)

Inbound (none — REST drives CRUD; "run now" is REST too).
Outbound additions:
- `scheduled_run_started { run_id, task_id, fanout_target, session_id }`
- `scheduled_run_progress { run_id, snippet }` (throttled)
- `scheduled_run_finished { run_id, status, cost_usd, duration_ms, error? }`
- Tag existing `text_delta`/`tool_use`/`tool_result` with optional `run_id` when produced by a scheduled run.

## Cron expression validation
Server-side: try `new Cron(expr)` in a try/catch — croner throws on invalid. Reject 400.
UI: presets dropdown ("Every hour", "Daily at HH:MM", "Weekdays at HH:MM", "Every N minutes", "Custom"); custom shows raw 5-field with live "next 3 runs" preview computed client-side via croner (also installed in `web/`).

## Timezone handling
Always store cron_expr + timezone separately. Display `next_fire_at` in user's browser TZ but compute in stored TZ. Default new task TZ = browser TZ (sent in POST body).

## Cost guard
- New table column `users.daily_cost_cap_usd` (default e.g. 10.00). Track `users.cost_used_today_usd` rolling, reset at user-TZ midnight via a daily croner job.
- Before dispatching a fire, sum today's runs cost; if would exceed cap, mark `status='skipped', error='daily_cost_cap'`.
- UI: settings field + per-task warning on interval `< 15min` for skill/security_scan/log_check.

## Post-run action mechanics

### Storage shape
```ts
type PostRunAction =
  | { type: 'chain_task'; on: Condition; delay_seconds?: number; config: { task_id: string } }
  | { type: 'notify_email'; on: Condition; delay_seconds?: number; config: { to?: string; subject: string; body: string } }
  | { type: 'notify_telegram'; on: Condition; delay_seconds?: number; config: { body: string } }
  | { type: 'notify_web_push'; on: Condition; delay_seconds?: number; config: { title: string; body: string } }
  | { type: 'webhook'; on: Condition; delay_seconds?: number; config: { url: string; headers?: Record<string,string> } }
type Condition = 'success' | 'failure' | 'always' | 'cost_exceeded'
```
Validated with Zod discriminated union in `hub/src/scheduler/post-run/schema.ts`.

### Dispatcher flow (post-finalize)
After `dispatcher.finalizeRun(runId)`:
1. Load task's `post_run_actions`.
2. Filter actions whose `on` matches run.status (or 'always').
3. For each match: if `delay_seconds` → `setTimeout` queue; else execute now via `actionExecutor.run(action, runContext)`.
4. Action executors live in `hub/src/scheduler/post-run/{chain,email,telegram,webpush,webhook}.ts` — each exports `execute(action, ctx)`.

### Cycle detection (chain_task)
Write-time (in REST POST/PATCH validator): build directed graph from `user.tasks[].post_run_actions[chain_task].config.task_id`, DFS from edited node, reject if back-edge. Runtime: pass `chainDepth` in `runContext`; bail and finalize `failed(error='chain_depth_exceeded')` if `chainDepth >= 5`.

### Email via `emails4agents` (mandated)
```ts
await fetch(`${process.env.E4A_BASE_URL}/v1/messages/send`, {
  method: 'POST',
  headers: { 'X-API-Key': process.env.E4A_API_KEY!, 'Content-Type': 'application/json' },
  body: JSON.stringify({ inbox_id: process.env.E4A_INBOX_ID, to, subject, html: renderedBody })
})
```
Env vars (already mandated globally): `E4A_API_KEY`, `E4A_BASE_URL=https://api.emails4agents.com`, `E4A_INBOX_ID`. Default `to` = user's email if action.config.to omitted.

### Webhook signing
`X-Remo-Signature: sha256=<hex>` over the request body, key = user's first active API key (raw, fetched via DAL `getSigningKeyForUser`). 5-second fetch timeout, 1 retry on 5xx/network, then mark action failed (log only — does not fail the parent run).

### Web push transport
Piggyback on existing `/ws/client` per-user broadcaster. New outbound event:
- `notification { run_id, task_id, title, body, status, ts }`
No service-worker / VAPID push in v1 — only in-tab toast. Document service-worker push as future work.

### Telegram
Use the existing telegram MCP integration. Look up user's configured chat in the integration credentials store (`loadIntegrationConfig('telegram', userId)`); skip silently with a log line if absent. Reply via the `telegram.reply` tool (server-side admin invocation, not user-mediated).

### Template rendering
Tiny `{{var}}` replacer (no Handlebars dep): `body.replace(/\{\{(\w+)\}\}/g, (_, k) => String(ctx[k] ?? ''))`. HTML-escape for email body, plain for others.

### Fan-out aggregator
In-memory `Map<parentFireId, { taskId, expected: number, settled: RunResult[], firstAt: number }>`. Each child run on finalize calls `aggregator.report(parentFireId, result)`. When `settled.length === expected` OR `Date.now() - firstAt > 5*60_000`: compute aggregate status (all `success` → `success`; any `failure` → `failure`; else `partial`), dispatch post-run actions once with aggregate context. Sweep every 30s for timeouts. Parent fire id = uuidv4 stamped on the dispatcher fire batch.

## Open questions deferred to implementation
- Should `run-now` bypass per-session queue? **Decision:** no, it joins as waiter.
- Should disabled tasks still display `next_fire_at`? **Decision:** no, null it out.
- Multi-supervisor fan-out cost attribution: charge to `user_id` only; per-supervisor cost lives in run row.

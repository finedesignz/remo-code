# PLAN — Scheduled Tasks

Hub-side cron scheduler with per-user task CRUD, fan-out targeting (specific session/supervisor or all of either), run history, live progress over WS, and offline-grace dispatch. Lib: `croner`.

Tasks below are fine-grained, each one a single commit. Marked `[P]` are safe to run in parallel after their deps land. The wave columns are the recommended execution order.

---

## Wave 1 — Foundations (sequential)

### T1. Schema + migration
**Files:** `hub/src/db/schema.sql`
- Add `scheduled_tasks` and `scheduled_task_runs` tables (columns per CONTEXT.md).
- Add `users.daily_cost_cap_usd NUMERIC(10,4) NOT NULL DEFAULT 10.0000` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Indexes: `(user_id, enabled)` on tasks, `(next_fire_at) WHERE enabled` on tasks, `(task_id, scheduled_for DESC)` and `(user_id, scheduled_for DESC)` on runs.
- Add `scheduled_tasks.post_run_actions JSONB NOT NULL DEFAULT '[]'::jsonb` via `ADD COLUMN IF NOT EXISTS`.
- Add `scheduled_task_runs.triggered_by_run_id UUID NULL REFERENCES scheduled_task_runs(id) ON DELETE SET NULL` via `ADD COLUMN IF NOT EXISTS`; index `(triggered_by_run_id)`.
- All statements idempotent (existing pattern).

**Done when:** `bun run dev:hub` boots and `migrate.ts` applies cleanly against the existing DB.

### T2. Install croner in hub
**Files:** `hub/package.json`, `bun.lock`
- `bun add croner` in `hub/`.
- Sanity import in a throwaway scratch test, then delete.

### T3. DAL — scheduled tasks + runs
**Files:** `hub/src/db/scheduled-tasks-dal.ts` (new)
- `createTask`, `listTasksForUser(userId)`, `listEnabledTasks()` (boot), `getTask(id, userId)`, `updateTask(id, userId, fields)`, `deleteTask(id, userId)`, `setTaskFireTimes(id, last, next)`.
- `insertRun`, `updateRunStatus`, `listRunsForTask(taskId, userId, {limit, before})`, `getRun(runId, userId)`, `sumTodayCostForUser(userId, tzOffset)`.
- Post-run support: `insertChainedRun(parentRunId, childTaskId, userId)`, `listActionsForTask(taskId)`, `markActionFired(runId, actionIdx, outcome)` (writes to an in-memory action-log; persist only on failure to keep noise low), `getSigningKeyForUser(userId)` for webhook HMAC.
- All queries scoped by `user_id` with explicit WHERE.

### T4. Cron expression util + presets
**Files:** `hub/src/scheduler/cron.ts` (new), `web/src/lib/cron.ts` (new — mirror)
- `validate(expr): { ok: true } | { ok: false, error }` using `new Cron(expr, { paused: true })`.
- `nextRuns(expr, tz, n=3, from=new Date()): Date[]`.
- Preset compiler: `{ kind: 'hourly' } → '0 * * * *'`, `{ kind: 'daily', hh, mm } → '<mm> <hh> * * *'`, `{ kind: 'every_n_minutes', n }`, `{ kind: 'weekdays', hh, mm }`, `{ kind: 'custom', expr }`.

---

## Wave 2 — Dispatcher core (sequential after Wave 1)

### T5. Scheduler registry
**Files:** `hub/src/scheduler/registry.ts` (new)
- In-memory `Map<task_id, Cron>`.
- `loadAll()` — pulls enabled tasks, registers a `Cron` for each, computes `next_fire_at`, persists.
- `register(task)`, `unregister(taskId)`, `replace(task)` for edit, `pauseAll()`/`resumeAll()` for shutdown.
- Each Cron callback delegates to `dispatcher.fire(task)`.

### T6. Per-session FIFO queue
**Files:** `hub/src/scheduler/session-queue.ts` (new)
- `enqueue(sessionId, runId) → 'dispatched' | 'queued' | 'dropped'` with max 1 in-flight + 1 waiter.
- `onSessionIdle(sessionId)` — promote waiter, call dispatcher.
- Hook into existing `status: idle` broadcast in `hub/src/ws/agent.ts` (call `sessionQueue.onSessionIdle(sessionId)` when `dbStatus === 'online'` and prior status was `thinking`).

### T7. Target resolver
**Files:** `hub/src/scheduler/targets.ts` (new)
- `resolveTargets(task, userId): Array<{ kind, sessionId?, supervisorId?, agentSocket?, supervisorSocket? }>`.
- `session` → look up session, find its agent socket via `registry.ts`; if offline → return one pending stub.
- `supervisor` → `supervisor-registry.ts` lookup.
- `all_agents` → enumerate online agents for user (joins existing `connectedSessions` semantics).
- `all_supervisors` → enumerate online supervisors.

### T8. Dispatcher
**Files:** `hub/src/scheduler/dispatcher.ts` (new)
- `fire(task)`:
  1. cost-cap check (`sumTodayCostForUser` vs `users.daily_cost_cap_usd`); if would exceed, insert run rows with `status='skipped', error='daily_cost_cap'` and return.
  2. `resolveTargets` → for each, insert a `pending` run row.
  3. For each resolved + online target: route by `task_type` to the right sender (see T9/T10).
  4. For offline targets: leave `pending`, set 10-min grace expiry tracked in-memory.
  5. Update `scheduled_tasks.last_fire_at = now()` and recompute `next_fire_at`.
- `runNow(taskId, userId)` — same path but bypasses cron, single fire.
- `cancelRun(runId, userId)` — best-effort: send `cancel` to relevant socket, mark `cancelled`.

### T9. Senders — prompt / skill via agent
**Files:** `hub/src/scheduler/senders/agent.ts` (new)
- For `prompt` and `skill` (and presets `security_scan`, `continue_dev`): build content (`/<slash>` text for skill), call existing `user_message` send path against the agent socket; tag with `run_id`. Subscribe to that session's next `assistant_message` / `result` to capture cost+duration+snippet and finalize run.
- Honor per-session queue (T6).

### T10. Senders — supervisor skill + log-check
**Files:** `hub/src/scheduler/senders/supervisor.ts` (new), `hub/src/ws/supervisor-protocol.ts` (extend)
- New WS messages (supervisor side): `run_command { run_id, command, args }` → reply `run_started { run_id }`, `run_output { run_id, chunk }` (throttled), `run_finished { run_id, exit_code, duration_ms, snippet, error? }`.
- Pre-flight validation: query `supervisor_commands` for `(supervisor_id, kind='command', name=command)`; if missing, finalize run as `failed` with `error='command_not_available'`.
- `log_check` task type: hub-local; call Coolify deploy/logs API using gateway-stored creds (read from env `COOLIFY_TOKEN`) — outside agent path. Stub a simple HTTP helper.

### T11. Catch-up on boot
**Files:** `hub/src/scheduler/catchup.ts` (new), hook in `hub/src/index.ts`
- After `registry.loadAll()`: for each task, walk missed fires between `last_fire_at` and now (cap 100).
- `catchup_policy='skip'` → batch insert `runs` as `skipped`.
- `catchup_policy='run_once'` → insert + dispatch only the most recent missed fire.

### T12. Reconnect grace dispatch
**Files:** `hub/src/ws/agent.ts` (hook auth success), `hub/src/scheduler/grace.ts` (new)
- Maintain `Map<sessionId|supervisorId, Array<pendingRunId>>` keyed by target.
- On agent/supervisor auth success: drain matching pending runs created within last 10 min; dispatch via the right sender. Older ones → mark `skipped(target_offline)`.
- Background sweep every 60s to expire stale pending runs.

### T8.5. Post-run action dispatcher
**Files:** `hub/src/scheduler/post-run/dispatcher.ts` (new), hook in `hub/src/scheduler/dispatcher.ts` finalize path
- After `finalizeRun(runId)`: load task `post_run_actions`, filter by `on` matching `run.status` (success/failure/always; `cost_exceeded` when `error='daily_cost_cap'`).
- For each match: if `delay_seconds` → `setTimeout` (track in-mem map for cancel-on-shutdown); else execute now.
- Build `runContext = { task_name, status, output_snippet, cost_usd, duration_ms, run_url, user, chainDepth }`.
- Route by `action.type` to executor under `post-run/`. Bail with logged failure if `chainDepth >= 5`.
- For fan-out parent fires (target_kind `all_*`): do NOT fire here — delegate to aggregator (T8.7).

### T8.6. Post-run action executors
**Files:** `hub/src/scheduler/post-run/{schema,chain,email,telegram,webpush,webhook,template}.ts` (new)
- `schema.ts` — Zod discriminated union for `PostRunAction`; export `validatePostRunActions(arr)`.
- `template.ts` — `render(str, ctx)` with `{{var}}` substitution; HTML-escape variant for email.
- `chain.ts` — calls `dispatcher.runNow(config.task_id, userId, { triggeredByRunId, chainDepth: chainDepth+1 })`.
- `email.ts` — POST `${E4A_BASE_URL}/v1/messages/send` with `X-API-Key`, body `{ inbox_id, to, subject, html }`. Default `to` = user email. Per global CLAUDE.md: never any other provider.
- `telegram.ts` — load user's telegram chat from integration config; if missing, log + skip; else invoke `telegram.reply` server-side.
- `webpush.ts` — call `broadcastToUser(userId, { type: 'notification', ... })` via existing WS broadcaster (extend `protocol.ts` with `notification` outbound schema in T15).
- `webhook.ts` — POST JSON with `X-Remo-Signature: sha256=<hmac(rawBody, userApiKey)>`. 5s timeout, 1 retry on 5xx/network. Log-only failure (does not fail parent run).

### T8.7. Fan-out aggregator
**Files:** `hub/src/scheduler/post-run/aggregator.ts` (new), wire into `dispatcher.ts`
- `register(parentFireId, taskId, userId, expectedCount)` on fan-out dispatch.
- `report(parentFireId, runResult)` on each child finalize; when `settled === expected` or 5-min elapsed → compute aggregate status (`success` iff all succeed; `failure` if any failed; `partial` mixed) and call `postRunDispatcher.fire(task, aggregateContext)` ONCE.
- 30s sweep timer for stale buckets. Persist nothing — best-effort across hub restarts (document: pending fan-out aggregates dropped on restart).

---

## Wave 3 — API + WS (parallel after Wave 2)

### T13. [P] REST router for scheduled tasks
**Files:** `hub/src/api/scheduled-tasks.ts` (new), register in `hub/src/index.ts`
- All endpoints in RESEARCH.md §API. Zod-validate body (`task_type` enum, `target_kind` enum, valid cron via T4, valid `timezone` via `Intl.DateTimeFormat(tz)`).
- Extend POST/PATCH body schema with `post_run_actions: PostRunAction[]` via `validatePostRunActions` (T8.6 schema). On write: run cycle detector across the user's task graph for any `chain_task` actions; reject 400 with `{ error: 'chain_cycle', path: [...taskIds] }` on back-edge.
- `POST` and `PATCH` call `scheduler.register/replace`; `DELETE` calls `unregister`.
- `run-now` → `dispatcher.runNow`.
- Response shape includes computed `next_fire_at` and a `next_3_runs` preview.

### T14. [P] REST router for runs
**Files:** `hub/src/api/scheduled-task-runs.ts` (new)
- `GET /api/scheduled-task-runs/:run_id` (with embedded events from the broadcasting WS if still in-flight — fall back to stored row).
- `POST /api/scheduled-task-runs/:run_id/cancel`.

### T15. [P] WS protocol extension
**Files:** `hub/src/ws/protocol.ts`, `hub/src/ws/client.ts`, broadcast helpers in `registry.ts`
- Add Zod schemas + types: `scheduled_run_started`, `scheduled_run_progress`, `scheduled_run_finished`.
- Extend existing `text_delta`/`tool_use`/`tool_result` schemas with optional `run_id`.
- Broadcaster helper `broadcastScheduledRun(userId, event)`.

### T16. [P] Daily cost cap reset job
**Files:** `hub/src/scheduler/daily-reset.ts` (new)
- One internal croner job per user (registered at boot for users with at least one enabled task; opt-in lazy add). Fires at user-TZ midnight; resets `cost_used_today_usd`.
- Alternative if simpler: query-time summation (T3 `sumTodayCostForUser`) — no reset job needed. **Choose query-time summation for v1, document tradeoff at top of file.**

---

## Wave 4 — Web UI (sequential within the page, parallel with Wave 3)

### T17. [P] `useSchedules` hook
**Files:** `web/src/hooks/useSchedules.ts` (new)
- CRUD over `/api/scheduled-tasks`. Loading/error state. Optimistic update on enable/disable.

### T18. [P] `useScheduleRuns` hook
**Files:** `web/src/hooks/useScheduleRuns.ts` (new)
- Paged list for a task; subscribes to live events for in-flight runs.

### T19. SchedulesPage list view
**Files:** `web/src/components/SchedulesPage.tsx` (new), route added in `web/src/App.tsx`, nav entry in sidebar (`web/src/components/Sidebar.tsx`)
- Table/list of tasks: name, next fire (browser TZ), target summary, last status, enable toggle, run-now, edit, delete.
- Empty state with "+ New schedule".
- Follow visual conventions from `CLAUDE.md` "Frontend / CSS Conventions" and `SettingsPage.tsx` baseline. No hard borders; `bg-[var(--bg-secondary)]/60` cards; indigo accent.

### T20. Schedule create/edit modal
**Files:** `web/src/components/ScheduleEditor.tsx` (new)
- Fields: name; task type (radio: prompt / skill / security_scan / log_check / continue_dev); body (prompt textarea OR command picker from `/api/commands`); schedule (preset dropdown + custom cron); timezone (default browser); target (radio + dependent picker — session, supervisor, all_agents, all_supervisors); catchup policy; max_concurrent.
- Live "next 3 runs" preview via shared cron util (T4).
- Sub-15min warning banner for non-prompt types.
- Save → POST/PATCH → close.

### T20.5. Post-run actions editor in ScheduleEditor
**Files:** `web/src/components/ScheduleEditor.tsx` (extend), `web/src/components/PostRunActionsEditor.tsx` (new)
- New collapsible block at modal bottom: header **"When this task finishes..."**.
- List of action rows; each row: type dropdown (chain_task | notify_email | notify_telegram | notify_web_push | webhook), `on` dropdown (success | failure | always | cost_exceeded), `delay_seconds` numeric (optional), and type-specific config:
  - `chain_task` → task picker (filtered to user's other tasks; hide selections that would cycle, client-side preview).
  - `notify_email` → `to` (defaults to user email), subject, body (textarea with template-var hint chips).
  - `notify_telegram` / `notify_web_push` → body (+ title for web_push).
  - `webhook` → URL.
- Add/remove rows. Persists into `post_run_actions` array on save. Display server-side cycle errors inline.

### T21. Runs drawer
**Files:** `web/src/components/ScheduleRunsDrawer.tsx` (new)
- Slide-over drawer with paged run history. Click a run → activity timeline (reuse `ActivityFeed`/`ThinkingBlock`/`ToolUseBlock`) keyed by `run_id` filter.
- Live updates from WS while drawer is open.

### T22. Daily cost cap setting
**Files:** `web/src/components/SettingsPage.tsx` (extend Account tab), hub PATCH `/api/profile`
- Numeric input for `daily_cost_cap_usd`; reuse existing profile update flow.
- Display today's spend (compute on the fly via new lightweight `/api/profile/cost-today` endpoint).

### T22.5. Notification settings (email destination + web push toggle)
**Files:** `web/src/components/SettingsPage.tsx` (extend Notifications subsection — add if missing)
- Show user's email (read-only or editable depending on existing profile flow) as the default `notify_email` recipient.
- Web-push: in-tab toast toggle (persists to `users.web_push_enabled BOOLEAN DEFAULT true` — add via idempotent ALTER in T1 if not already).
- Inline note: "Telegram notifications require connecting Telegram in the Integrations tab" — link out; no setup here.

---

## Wave 5 — Tests + ship (sequential)

### T23. Scheduler unit tests
**Files:** `hub/test/scheduler.test.ts` (new — Bun test)
- Cron util validates expressions, rejects junk.
- Preset compiler produces expected expressions.
- Catch-up math: given `last_fire_at`, returns expected missed fires (mocked clock).
- Session queue: in-flight + 1 waiter + drop semantics.
- Target resolver: each `target_kind` returns expected fan-out.
- Cost-cap blocks dispatch and inserts `skipped` rows.
- Post-run cycle detector: direct self-chain rejected; A→B→A rejected; A→B→C linear allowed.
- Action condition matcher: `on:'success'` skips a failed run; `on:'cost_exceeded'` only matches `error='daily_cost_cap'`; `on:'always'` always matches.
- Fan-out aggregator: 3 children → fires once after 3 reports; timeout fires once after 5min with `partial`; reports past completion ignored.
- Chain depth cap: 6th chained dispatch finalizes `failed(error='chain_depth_exceeded')`.
- Template renderer: substitutes known vars, leaves unknown as empty, HTML-escapes for email.

### T24. End-to-end smoke
**Files:** `hub/test/scheduled-tasks.e2e.test.ts` (new)
- Create task via REST → wait one fire (using `every_n_minutes: 1` and a 70s test window OR mock croner clock) → assert run row appears with `success`.
- Disable task → assert no new fire.
- Delete task → assert registry unregistered.

### T25. Migration runbook + docs
**Files:** `CLAUDE.md` (append a Scheduled Tasks section), `docs/scheduled-tasks.md` (new)
- Architecture summary, env vars (none new beyond existing Coolify token), how catch-up + cost cap behave, how to add a new task type.
- Update `CLAUDE.md` "What This Is" to mention scheduled tasks.

### T26. Build, commit, push, redeploy
- `bun run build:web` clean.
- Commit per task (atomic) or per wave with descriptive messages.
- Push main → Coolify auto-deploys.
- Verify in prod: create a 2-min-interval test task targeting a connected agent, watch a run land in the runs drawer.

---

## Verification gates

After each wave:
- **W1:** schema applies; DAL functions return expected shapes for hand-crafted rows.
- **W2:** unit tests for queue/resolver/catchup pass.
- **W3:** REST endpoints return 200 with `curl` against local hub; WS events appear in DevTools.
- **W4:** UI renders, create/edit/delete round-trip works in browser.
- **W5:** e2e smoke green; prod deploy fires a real scheduled run.

## Out of scope reminders
No workflow chaining, no conditional schedules, no shared schedules, no per-task billing — keep these out of v1 even if tempting.

## Risk mitigations baked in
- **Slash-command drift:** T10 pre-flight against `supervisor_commands`; T20 picker only shows commands the chosen supervisor has synced.
- **Cost runaway:** T8 cost-cap check + T20 UI warning + T22 user-facing daily cap.

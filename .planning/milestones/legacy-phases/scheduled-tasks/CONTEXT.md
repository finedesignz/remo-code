# Phase: Scheduled Tasks

## Goal
Let users define cron-style schedules in the remo-code web UI that trigger automated actions against their connected agents and supervisors — prompts, slash commands / skills, security scans, log checks, "continue development" loops — with run history, fan-out targeting, and offline grace.

## User stories
1. As a user, I can open a "Schedules" page, create a new task with a name, cron expression (or preset), timezone, target (specific repo / specific supervisor / all my connected agents / all my supervisors), and a task body (free-form prompt OR a slash command to invoke).
2. As a user, I can pause/enable, edit, delete, and "run now" each task.
3. As a user, I can browse run history per task (status, time, target, cost, duration, snippet of output) and click into a run to see live or replayed activity.
4. As a user, schedules continue firing after a hub restart; if a target was offline at fire-time, the run is dispatched on reconnect within a grace window or marked `skipped`.

## Non-goals (out of scope this phase)
- Multi-step "workflows" (chaining tasks). Single action per fire.
- Conditional schedules ("only if X failed").
- Sharing schedules across users.
- Pricing/billing limits beyond a hard daily cost cap as a safety guard.

## Locked decisions (architect-reviewed)
- **Scheduler: hub-side.** Single source of truth. (Architect rejected supervisor-side: drift, offline gaps, forked history.)
- **Cron lib: `croner`.** Bun-friendly, zero deps, IANA TZ, `nextRuns()` API.
- **Fan-out model:** one `scheduled_tasks` row → N `scheduled_task_runs` per fire (one per resolved target).
- **Offline target:** 10-minute grace window; re-dispatch on reconnect via existing auth handlers, else `skipped`.
- **Catch-up policy:** `skip` default; `run_once` for `continue_dev`-style tasks.
- **Concurrency:** per-session FIFO queue, max 1 in-flight + 1 waiter; further fires dropped as `skipped(session_busy)`.
- **Retry:** no blanket retry. Optional 2-try exponential only if `payload.retry=true`.
- **Cost guard:** per-user daily cost cap + UI warning when interval < 15min on non-prompt task types.

## Stack constraints
Bun + Hono hub (Postgres), React 19 + Tailwind 4 web, Bun-based local agent/supervisor. Reuse existing `/ws/agent` `user_message` path for prompt and slash-command dispatch — do not fork. Extend supervisor WS protocol for skill-run dispatch with new message types only where existing channels don't fit.

## Targeting model
| target_kind | target_id | semantics |
|---|---|---|
| `session` | sessions.id | fire against one Claude session via its agent |
| `supervisor` | supervisors.id | fire against one supervisor (skill or repo op) |
| `all_agents` | NULL | fan-out to all connected agent sockets for user |
| `all_supervisors` | NULL | fan-out to all online supervisors for user |

## Task types
- `prompt` — free-form text → `user_message` to a Claude session
- `skill` — slash command (e.g. `/security-review`) → `user_message` (Claude CLI handles slash)
- `security_scan` — preset wrapping `/security-review`
- `log_check` — hub-local; calls Coolify API or supervisor `repo.read_logs` op
- `continue_dev` — preset prompt like "continue where you left off"

## Post-run actions
Each `scheduled_tasks` row may carry zero or more **post-run actions** that fire after the run finishes (conditionally on outcome). Stored as `post_run_actions JSONB` on the task row; runs that chain to this run carry `triggered_by_run_id` for trace/debug.

**Action types (extensible registry):**
- `chain_task` — dispatch another `scheduled_tasks` row by id (bypasses its cron). Enables "after security scan succeeds, run /gsd-audit-fix".
- `notify_email` — send via **`emails4agents`** (per global CLAUDE.md mandate — never SES/SendGrid/etc). Subject + body templates.
- `notify_telegram` — DM via existing telegram MCP integration if user has a channel configured; silent skip otherwise.
- `notify_web_push` — broadcast a `notification` WS event to that user's open web tabs.
- `webhook` — POST JSON to user-supplied URL with HMAC `X-Remo-Signature` (key = user's API key).

**Conditions (per action):**
- `on: 'success' | 'failure' | 'always' | 'cost_exceeded'` — fire only when run lands in that bucket.
- `delay_seconds?` — defer this many seconds after run finalize; batches noisy fan-out into a single notification.

**Template vars** (all action types): `{{task_name}}`, `{{status}}`, `{{output_snippet}}`, `{{cost_usd}}`, `{{duration_ms}}`, `{{run_url}}`.

**Cycle protection (chain_task):**
- Cycle detection at write time (graph walk over all user's tasks): reject 400 if direct or indirect cycle.
- Hard runtime cap: chain depth 5 (defense in depth even if write check bypassed).

**Fan-out interaction:**
- For `target_kind in ('all_agents', 'all_supervisors')`: actions fire ONCE per parent fire after ALL child runs settle (or 5-min aggregator timeout). Aggregate outcome = `success` iff all succeed, `failure` if any fail, else propagate. Documented to avoid notification spam.

## Tables (new)
- `scheduled_tasks` (id, user_id, name, task_type, payload JSONB, cron_expr, timezone, target_kind, target_id, enabled, catchup_policy, max_concurrent, next_fire_at, last_fire_at, **post_run_actions JSONB NOT NULL DEFAULT '[]'**)
- `scheduled_task_runs` (id, task_id, user_id, scheduled_for, started_at, finished_at, status, fanout_target, session_id, output_snippet, cost_usd, duration_ms, error, **triggered_by_run_id UUID NULL**)

## Risks (call out)
1. **Slash-command drift.** Validate command exists in `supervisor_commands` for the target supervisor at dispatch time; fail fast with clear UI error.
2. **Cost runaway.** Hard daily cost cap per user + UI warning on sub-15min intervals for non-prompt types.

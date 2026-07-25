# Phase: Error Capture

## Goal
Sentry-style error capture across the user's Coolify-hosted apps, routed back into the live Claude Code session for each repo. Errors flow into the remo-code hub (`/api/sentry/:project_id/envelope/`), are deduped/rate-limited/cost-gated, then forwarded as a structured `user_message` to the agent socket bound to that project's session. Claude investigates and fixes in-session, commits, and pushes to the default branch — Coolify auto-deploys. v1 also auto-installs the Sentry SDK into 4 supported stacks via supervisor git-ops and patches `SENTRY_DSN` into the Coolify app's env vars. Replaces the standalone `claude-code-self-heal` service, which is decommissioned at the end of this phase.

## User stories
1. As a user, I open the new "Error Capture" tab in Settings, create an `error_project` with a name and link it explicitly to one of my existing sessions (the Claude CLI session for that repo).
2. As a user, I click "Auto-install SDK" — the hub uses the supervisor to detect my stack (Node+Express / Node+Next.js / Python+FastAPI / Python+Django), prepend the Sentry init snippet to the entry file, add the dependency to my manifest, commit, and push to my default branch; Coolify redeploys on its own (or, by default, waits for me to redeploy).
3. As a user with an unsupported stack, I receive an email with a copy-paste init snippet and DSN.
4. As a user, when a runtime error fires in my deployed app, I see the error appear in the Settings tab live and watch a `dispatch_to_session` run materialize in the linked Claude session — Claude reads the prompt, investigates the repo, fixes the bug, commits, and pushes.
5. As a user, dupes within 60s on the same fingerprint collapse to one dispatch; sustained error storms are capped at 20/hr/project and 50/day/project (configurable per project).
6. As a user, when daily cap is hit or my session is offline past the 10-min grace window, I get one summary email instead of a flood of dispatches.

## Non-goals
- Auto-link by repo URL match (post-v1; v1 is explicit session pick).
- `target_kind=supervisor` (post-v1; v1 is session-only).
- Cross-project aggregation / org-level dashboards.
- Sourcemap upload pipeline (rely on whatever Sentry SDK does locally).
- Performance / tracing / replay ingestion (errors only).
- Opening pull requests — Claude commits straight to default branch in-session.

## Locked decisions (architect-reviewed)
- Sentry intake endpoint is public/unauthed at the network layer; the per-project `sentry_key` in the `X-Sentry-Auth` header is the credential. Unknown keys → 401 silently.
- The Claude CLI session is the SOLE remediation surface. The hub builds a `user_message` and sends it via the existing `/ws/agent` path — no `claude -p` worker, no PR-opening bot, no GitHub App.
- Per-session 1-in-flight + 1-waiter queue REUSES `hub/src/scheduler/session-queue.ts` verbatim. Further enqueues drop as `skipped(session_busy)`.
- All email notifications go through emails4agents. Reuse `hub/src/scheduler/post-run/email.ts`. No SES/SendGrid/etc.
- v1 project→session linkage is EXPLICIT: operator picks `session_id` when creating the `error_project`. Auto-linking by repo URL is post-v1.
- SDK auto-install uses the supervisor's existing git-ops (read entry file, prepend snippet, write manifest, commit + push to default branch). No GitHub App, no PR opening.
- Supported stacks for auto-install: Node+Express, Node+Next.js, Python+FastAPI, Python+Django. Anything else → email user a copy-paste snippet and stop.
- The dispatch prompt instructs Claude to investigate AND fix in one shot, then commit + push to the default branch.
- Coolify redeploy after SDK install defaults OFF — the user explicitly redeploys (or relies on Coolify's auto-deploy-on-push).
- v1 `target_kind` is `session` only.

## Stack constraints
- Bun + Hono hub, Postgres (Coolify-hosted), Bun-based local agent.
- Reuse `hub/src/scheduler/session-queue.ts` (per-session FIFO).
- Reuse `hub/src/scheduler/post-run/email.ts` for any email notification.
- Reuse the existing `/ws/agent` `user_message` send path in `hub/src/ws/agent.ts` for dispatch.
- Supervisor git-ops (already used by the supervisor app) handles file edits, commits, and pushes — no new git library in the hub.
- Coolify API for env-var PATCH (`SENTRY_DSN`) — credentials via existing `COOLIFY_TOKEN` env.

## Routing model
| target_kind | target_id | semantics (v1) |
|---|---|---|
| `session` | sessions.id | dispatch one `user_message` to the agent socket bound to that session |

Post-v1: `supervisor` (background remediation surface), `all_sessions` (org-wide error firehose).

## Task types
- `dispatch_to_session` — the only v1 task. Resolved at error-receive time (not by cron). Builds a structured prompt and ships via the agent socket.

## Schema sketch
- **`error_projects`** — one row per Sentry-style project. Columns: `id UUID PK`, `user_id UUID FK users`, `name TEXT`, `sentry_key TEXT UNIQUE` (random, used in DSN + `X-Sentry-Auth`), `session_id UUID FK sessions ON DELETE SET NULL`, `dedupe_window_seconds INT DEFAULT 60`, `rate_limit_per_hour INT DEFAULT 20`, `daily_dispatch_cap INT DEFAULT 50`, `enabled BOOLEAN DEFAULT true`, `created_at`, `updated_at`.
- **`errors`** — one row per accepted error envelope. Columns: `id UUID PK`, `project_id UUID FK error_projects ON DELETE CASCADE`, `fingerprint TEXT`, `error_type TEXT`, `error_value TEXT`, `stacktrace_json JSONB`, `release TEXT NULL`, `received_at TIMESTAMPTZ DEFAULT now()`, `dispatch_status TEXT` (enum: `pending|dispatched|skipped_dedupe|skipped_rate_limit|skipped_cap|skipped_offline|skipped_disabled`), `dispatched_at TIMESTAMPTZ NULL`, `run_id UUID NULL FK error_runs`, `error TEXT NULL`.
- **`error_runs`** — one row per dispatch attempt. Columns: `id UUID PK`, `error_id UUID FK errors ON DELETE CASCADE`, `project_id UUID`, `session_id UUID`, `status TEXT` (enum: `pending|running|succeeded|failed|cancelled|skipped`), `started_at`, `finished_at`, `snippet TEXT`, `error TEXT NULL`. Mirrors `scheduled_task_runs` structurally.
- **`notifications_sent`** — reuse if scheduled-tasks already has one (T8.6 may have added it); check at W1/T1. Otherwise add: `(id, kind, dedupe_key, sent_at)` with unique `(kind, dedupe_key, date_trunc('day', sent_at))` so we email at most once per day per condition.

Indexes:
- `errors (project_id, received_at DESC)`
- `errors (fingerprint, project_id, received_at DESC)` — dedupe lookup window
- `errors (project_id) WHERE dispatched_at IS NOT NULL` — daily-cap counting
- `error_projects (user_id, enabled)`
- `error_projects (sentry_key)` UNIQUE already covers lookup
- `error_runs (project_id, started_at DESC)`

## Supported SDK stacks
| Stack | Entry-file detection | Snippet location | Manifest update |
|---|---|---|---|
| Node + Express | `package.json#dependencies.express` present; entry from `package.json#main`, `package.json#scripts.start`, else `src/index.{ts,js}` → `src/server.{ts,js}` → `index.{ts,js}` | Prepend `import * as Sentry from '@sentry/node'; Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });` after any shebang, before all other imports | Add `@sentry/node: ^9.0.0` to `dependencies` |
| Node + Next.js | `package.json#dependencies.next` present | Create/append `sentry.server.config.ts` + `sentry.client.config.ts` per `@sentry/nextjs` v9 docs; wrap `next.config.{js,ts}` with `withSentryConfig` | Add `@sentry/nextjs: ^9.0.0` to `dependencies` |
| Python + FastAPI | `pyproject.toml`/`requirements.txt` contains `fastapi` | Prepend `import sentry_sdk; sentry_sdk.init(dsn=os.environ['SENTRY_DSN'], traces_sample_rate=1.0)` (with `import os`) to the file declaring the `FastAPI()` app (heuristic: `main.py`, `app.py`, `app/main.py`) | Add `sentry-sdk[fastapi]>=2.0` to `requirements.txt` or `[tool.poetry.dependencies]` |
| Python + Django | `manage.py` present and `django` in deps | Prepend init to `<project>/settings.py` (resolve `<project>` from `manage.py` env line) | Add `sentry-sdk[django]>=2.0` to the manifest |

Detection logic is lifted from `claude-code-self-heal/src/setup/detect.ts` and stripped to these 4 stacks. Anything else → mark setup as `unsupported`, email user a copy-paste snippet + DSN, stop.

## Dispatch prompt template
The `user_message` sent over `/ws/agent` is a single text block (no images/attachments), shaped like:

```
[Remo Error Capture] {{project_name}} — {{error_type}}

A runtime error fired in your deployed app. Please:
1. Investigate the cause using the repo at {{cwd}}.
2. Fix it in this session.
3. Commit with message: "fix({{project_name}}): {{error_type}} — {{short_value}}"
4. Push to the default branch (Coolify will auto-deploy).

Error type: {{error_type}}
Error value: {{error_value}}
Release: {{release_or_unknown}}
Fingerprint: {{fingerprint}}
Received at: {{received_at_iso}}

Top frames:
{{top_frames_pretty}}

Full stacktrace (JSON):
{{stacktrace_json_indented}}

Run URL (for your reference): {{run_url}}
```

Template vars (built by `senders/session.ts` from the `errors` row): `project_name`, `error_type`, `error_value`, `short_value` (truncated to 60 chars), `release_or_unknown`, `fingerprint`, `received_at_iso`, `top_frames_pretty` (first 8 frames, normalized), `stacktrace_json_indented`, `cwd` (session's `project_dir`), `run_url` (`${REMO_PUBLIC_URL}/sessions/{{session_id}}#run-{{run_id}}`).

## Risks (call out)
1. **Session disabled / agent offline at error time.** Handled by 10-min offline-grace replay (mirrors scheduled-tasks `grace.ts`); after that, error row stays `skipped_offline` and one summary email fires per project per day.
2. **Snippet collision on second auto-install.** `injectSnippet` is idempotent (checks for `@sentry/node`/`sentry_sdk` already present) — copy that behavior from self-heal.
3. **Sentry SDK floods on first deploy.** Default `rate_limit_per_hour=20`, `daily_dispatch_cap=50`, `dedupe_window_seconds=60` — generous enough for real fires, tight enough to prevent runaway dispatch.
4. **`X-Sentry-Auth` parsing.** Sentry sends it as `Sentry sentry_version=7, sentry_key=<key>, sentry_client=...`. Lift the parser from `claude-code-self-heal/src/sentry/auth.ts` verbatim.

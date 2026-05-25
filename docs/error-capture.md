# Error Capture

Sentry-style error capture across the user's Coolify-hosted apps, routed back into the live Claude Code session for each repo. Deployed apps ship Sentry SDK envelopes to the hub at `POST /api/sentry/:project_id/envelope/`. The hub decodes the envelope, fingerprints the first exception, gates the row through dedupe → rate-limit → daily-cap, then ships the structured error to the Claude session bound to that project as a `user_message` over the existing `/ws/agent` path. Claude investigates and fixes in-session, commits, and pushes to the default branch — Coolify auto-deploys. v1 also auto-installs the Sentry SDK into 4 supported stacks via supervisor git-ops and patches `SENTRY_DSN` into the Coolify app's env vars.

> **Status:** shipped in the `error-capture` phase (PR #17). Replaces the standalone `claude-code-self-heal` service, which is decommissioned in a follow-up.

---

## Architecture

```
   ┌──────────────────────┐
   │  Deployed app (user) │ Sentry SDK
   └──────────┬───────────┘
              │ POST /api/sentry/:project_id/envelope/
              │  (X-Sentry-Auth: Sentry sentry_key=<key>)
              ▼
   ┌─────────────────────────────────────────────────────┐
   │  Hub                                                │
   │  ┌───────────────┐  ┌────────────────────────────┐ │
   │  │ api/          │  │ error-capture/             │ │
   │  │  sentry-      │──▶│  auth        (parse hdr)  │ │
   │  │  intake       │  │  envelope    (gunzip+split)│ │
   │  │               │  │  fingerprint (sha-256)     │ │
   │  │  error-       │  │  record      (gates)       │ │
   │  │  projects     │  │  notify      (e4a + ttl)   │ │
   │  │  errors       │  │  prompt      (build msg)   │ │
   │  │  error-runs   │  │  dispatcher  (queue+send)  │ │
   │  │  error-setup  │  │  run-lifecycle (finalize)  │ │
   │  └───────────────┘  │  grace       (offline)     │ │
   │                     │  setup/                    │ │
   │                     │    detect    (4 stacks)    │ │
   │                     │    snippet   (inject)      │ │
   │                     │    coolify-env (PATCH env) │ │
   │                     └────────────────────────────┘ │
   └──────────┬──────────────────────────────────────────┘
              │ user_message (over existing /ws/agent)
              ▼
   ┌──────────────────────┐
   │  Claude CLI session  │  investigates, fixes, commits, pushes
   └──────────────────────┘
              │ git push → default branch
              ▼
   ┌──────────────────────┐
   │  Coolify auto-deploy │
   └──────────────────────┘
```

### Module map

| Module                                     | Role                                                                  |
|--------------------------------------------|-----------------------------------------------------------------------|
| `hub/src/api/sentry-intake.ts`             | Public envelope endpoint; key auth, envelope decode, hand-off to gates|
| `hub/src/error-capture/auth.ts`            | `extractSentryKey` — parses `X-Sentry-Auth` or `?sentry_key=` fallback |
| `hub/src/error-capture/envelope.ts`        | `parseEnvelope` — gunzip + multi-line JSON Sentry envelope parser     |
| `hub/src/error-capture/fingerprint.ts`     | Stable sha-256 of `(project_id, error_type, error_value, top_3_frames)`|
| `hub/src/error-capture/record.ts`          | Three pre-dispatch gates (dedupe → rate-limit → daily-cap); persists row|
| `hub/src/error-capture/notify.ts`          | `notifyThrottled` — silent-skip emails via emails4agents (TTL gated)  |
| `hub/src/error-capture/prompt.ts`          | `buildErrorMessage` — turns an error row + project into the dispatch prompt|
| `hub/src/error-capture/dispatcher.ts`      | Resolves agent socket, claims per-session queue slot, sends `user_message`|
| `hub/src/error-capture/run-lifecycle.ts`   | Finalizes the `error_run` when the agent emits `assistant_message`    |
| `hub/src/error-capture/grace.ts`           | 10-min offline buffer keyed by session_id; replays on agent reconnect |
| `hub/src/error-capture/setup/detect.ts`    | Content-driven stack detector (4 stacks); content-only, no fs walk    |
| `hub/src/error-capture/setup/snippet.ts`   | `getSnippet`, `injectSnippet`, `addSentryDep`, `addPythonSentryRequirement`|
| `hub/src/error-capture/setup/coolify-env.ts`| `setCoolifyEnv` (PATCH `SENTRY_DSN`) + `redeployCoolifyApp`           |
| `hub/src/api/error-projects.ts`            | User-scoped CRUD; computes DSN string for UI copy                     |
| `hub/src/api/errors.ts`                    | Paged read of captured errors per project                             |
| `hub/src/api/error-runs.ts`                | Dispatch-attempt history per error                                    |
| `hub/src/api/error-setup.ts`               | One-shot SDK auto-install via supervisor + Coolify env PATCH          |

---

## Schema

Four tables added by `hub/src/db/schema.sql` (idempotent `CREATE TABLE IF NOT EXISTS`):

### `error_projects`

| Column                  | Type        | Notes                                              |
|-------------------------|-------------|----------------------------------------------------|
| `id`                    | UUID PK     |                                                    |
| `user_id`               | UUID FK     | `users(id) ON DELETE CASCADE`                      |
| `name`                  | TEXT        |                                                    |
| `sentry_key`            | TEXT UNIQUE | Random; appears in DSN + `X-Sentry-Auth` header    |
| `session_id`            | TEXT FK     | `sessions(id) ON DELETE CASCADE` — the remediation surface |
| `dedupe_window_seconds` | INT         | Default 60                                         |
| `rate_limit_per_hour`   | INT         | Default 20                                         |
| `daily_dispatch_cap`    | INT         | Default 50                                         |
| `enabled`               | BOOLEAN     | Default true                                       |
| `created_at`/`updated_at` | TIMESTAMPTZ |                                                  |

Indexes: `(user_id, enabled)`, `(sentry_key)`.

### `errors`

| Column            | Type         | Notes                                                              |
|-------------------|--------------|--------------------------------------------------------------------|
| `id`              | UUID PK      |                                                                    |
| `project_id`      | UUID FK      | `error_projects(id) ON DELETE CASCADE`                             |
| `fingerprint`     | TEXT         | sha-256 input from `fingerprint.ts`                                |
| `error_type`      | TEXT         | e.g. `TypeError`                                                   |
| `error_value`     | TEXT         |                                                                    |
| `stacktrace_json` | JSONB        | Raw Sentry frame array                                             |
| `release`         | TEXT NULL    |                                                                    |
| `received_at`     | TIMESTAMPTZ  | Default `now()`                                                    |
| `dispatch_status` | TEXT         | `pending\|dispatched\|skipped\|failed\|deduped\|rate_limited\|cap_exceeded` |
| `dispatched_at`   | TIMESTAMPTZ  |                                                                    |
| `skip_reason`     | TEXT NULL    |                                                                    |

Indexes: `(project_id, received_at DESC)`, `(fingerprint, project_id, received_at DESC)`, partial `(project_id) WHERE dispatch_status='pending'`.

### `error_runs`

Mirrors `scheduled_task_runs` structurally — one row per dispatch attempt.

| Column           | Type        | Notes                                                          |
|------------------|-------------|----------------------------------------------------------------|
| `id`             | UUID PK     |                                                                |
| `error_id`       | UUID FK     | `errors(id) ON DELETE CASCADE`                                 |
| `project_id`     | UUID FK     |                                                                |
| `session_id`     | TEXT FK     | `sessions(id) ON DELETE CASCADE`                               |
| `status`         | TEXT        | `pending\|in_flight\|success\|failed\|skipped\|cancelled`      |
| `started_at`/`finished_at` | TIMESTAMPTZ |                                                       |
| `output_snippet` | TEXT NULL   | First N chars of Claude's assistant_message                    |
| `error`          | TEXT NULL   |                                                                |
| `created_at`     | TIMESTAMPTZ |                                                                |

### `notifications_sent`

Throttle table for silent-skip emails. CHECK on `kind` ∈ {`dedupe_hit`, `rate_limit`, `daily_cap`, `dispatch_failed`, `session_offline`} (note: `stack_not_detected` is also passed at runtime — followup: extend CHECK). Index on `(kind, dedupe_key, sent_at DESC)`.

---

## Intake endpoint

```
POST /api/sentry/:project_id/envelope/
POST /api/sentry/:project_id/store/    (legacy SDK variant — same handler)
```

Mounted OUTSIDE the `/api/*` JWT catch-all. **Authentication is the `sentry_key`** carried in the `X-Sentry-Auth` header (`Sentry sentry_version=7, sentry_key=<key>, sentry_client=...`) or, as a legacy SDK fallback, the `?sentry_key=<key>` query param.

| Response | Condition |
|----------|-----------|
| `401 missing_sentry_key`     | No header and no query param                              |
| `401 bad_sentry_key`         | Key does not match any `error_projects.sentry_key`        |
| `401 project_mismatch`       | Key resolves to a different project than the path param   |
| `403 project_disabled`       | `error_projects.enabled = false`                          |
| `400 bad_envelope`           | Gunzip/parse failure on the body                          |
| `202 { ok, ignored: 'non_exception' }` | Envelope held only transactions/sessions/etc.   |
| `202 { ok, error_id, dispatch_status, skip_reason? }` | Accepted (returns the gate verdict)|

The body is gzipped multi-line JSON (`content-encoding: gzip` handled by `parseEnvelope`). The handler extracts the **first** item of `type=event` with an `exception.values[0]`, formats the top 3 frames callee-last for fingerprint input, and hands off to `recordError`.

---

## Gating order

`record.ts` applies three gates in fixed order. Each row is inserted as `pending` first so it participates in subsequent counts and so notifications can point at a real `error_id`.

1. **Dedupe** — `findRecentErrorByFingerprint(project_id, fingerprint, dedupe_window_seconds)`. Match (excluding self) → status `deduped`, reason `dedupe_window_<N>s`, fires `dedupe_hit` email (TTL = window seconds).
2. **Rate limit** — `countErrorsInLastHour(project_id)` includes this row. If `> rate_limit_per_hour` → status `rate_limited`, fires `rate_limit` email (TTL 3600s).
3. **Daily cap** — `countDispatchesToday(project_id, user_tz)` counts only rows with `dispatched_at IS NOT NULL`. If `>= daily_dispatch_cap` → status `cap_exceeded`, fires `daily_cap` email (TTL 24h, keyed by local-midnight `YYYY-MM-DD`).

Pass all three → row stays `pending` and `dispatchPendingError(row.id)` is invoked fire-and-forget (intake POST never blocks on dispatch).

Knobs are per-project: `dedupe_window_seconds`, `rate_limit_per_hour`, `daily_dispatch_cap`. Defaults 60s / 20/hr / 50/day. Set `daily_dispatch_cap = 0` to effectively disable dispatching (will always trip the cap).

---

## Dispatch into Claude session

`hub/src/error-capture/dispatcher.ts → dispatchPendingError(errorId)`:

1. Re-load the `errors` row; bail if not `pending` (idempotent).
2. Resolve the agent socket via `getChannel(project.session_id)`.
3. **Offline target** → `grace.register(sessionId, errorId)` + status `skipped(session_offline)` + throttled `session_offline` email (TTL 30 min, keyed by `project_id:session_id`).
4. **Per-session queue** (reuses `hub/src/scheduler/session-queue.ts` verbatim — 1 in-flight + 1 waiter):
   - `dropped` → status `skipped(session_busy)` + throttled `dispatch_failed` email (TTL 15 min, key suffix `:busy`).
   - `queued` → leave `pending`; queue promotion will re-enter `dispatchPendingError`.
   - `dispatched` → proceed.
5. **Insert `error_run` + register lifecycle hook** BEFORE sending — guards against a fast-reply race where `assistant_message` arrives before the run row exists.
6. Build the prompt via `buildErrorMessage(error, project)`. Persist it as a user message:
   - **Stored content** (chat history): `[error: <project.name> — <error_type>]\n\n<prompt>`
   - **Sent content** (over the wire to Claude): the bare prompt (no prefix).
7. Send `{ type: 'user_message', id, content, ts }` to the agent socket. On `send` failure → status `failed`, throttled `dispatch_failed` email (key suffix `:send`).
8. On success → status `dispatched`, broadcast `error_dispatched` to subscribed browsers.

Finalize happens in `run-lifecycle.ts`: when the agent emits the next `assistant_message` for that session, the registered hook moves the run to `success` (or `failed` on agent error), writes `output_snippet`, and broadcasts `error_run_finished`.

### Offline grace

`grace.ts` keyed by `sessionId`. On `/ws/agent` auth success for a session, any errors registered within the last 10 minutes are re-dispatched in order. Older entries are swept to `skipped(session_offline)` by a background interval. Mirrors `scheduler/grace.ts` semantics.

### Dispatch prompt template

Built by `prompt.ts → buildErrorMessage`. Variables: `project_name`, `error_type`, `error_value`, `short_value` (truncated to 60 chars), `release_or_unknown`, `fingerprint`, `received_at_iso`, `top_frames_pretty` (first 8 normalized frames), `stacktrace_json_indented`, `cwd` (session's `project_dir`), `run_url` (`${REMO_PUBLIC_URL}/sessions/<session_id>#run-<run_id>`). Asks Claude to investigate, fix in-session, commit with message `"fix(<project>): <type> — <short_value>"`, and push to the default branch (Coolify will auto-deploy).

---

## WebSocket events

All four are broadcast user-scoped via `broadcastErrorEvent(userId, ...)`. Zod schemas live in `hub/src/ws/protocol.ts` (`ErrorReceived`, `ErrorDispatched`, `ErrorRunFinished`, `ErrorSkipped`, joined into `ErrorCaptureEvent`).

- `error_received { error_id, project_id, fingerprint, received_at }` — fires before gates resolve, so the UI can flash a "new error" indicator even on rows that will immediately gate-skip.
- `error_dispatched { error_id, project_id, run_id, dispatched_at }`
- `error_run_finished { error_id, project_id, run_id, status, output_snippet?, cost_usd?, duration_ms?, error?, finished_at }` — status ∈ `success | failed | skipped | cancelled`.
- `error_skipped { error_id, project_id, dispatch_status, skip_reason }` — `dispatch_status` ∈ `skipped | failed | deduped | rate_limited | cap_exceeded`.

---

## REST surface

Mounted under `/api/*` (JWT-auth catch-all) in `hub/src/index.ts`. All routes user-scoped — every query pivots through `error_projects.user_id`.

### `error-projects`

| Method | Path                              | Notes                                                       |
|--------|-----------------------------------|-------------------------------------------------------------|
| GET    | `/api/error-projects`             | List user's projects; each row decorated with computed `dsn`|
| POST   | `/api/error-projects`             | Body: `{ name, session_id, dedupe_window_seconds?, rate_limit_per_hour?, daily_dispatch_cap?, enabled? }`. Session ownership verified |
| GET    | `/api/error-projects/:id`         |                                                             |
| PATCH  | `/api/error-projects/:id`         | Partial of create body; re-verifies `session_id` if changed |
| DELETE | `/api/error-projects/:id`         |                                                             |

DSN format: `https://<sentry_key>@<host>/<project_id>` (host stripped from `REMO_PUBLIC_URL`).

### `errors`

| Method | Path                                              | Notes                                              |
|--------|---------------------------------------------------|----------------------------------------------------|
| GET    | `/api/errors?project_id=...&limit=&before=`       | Paged list; `before` is ISO datetime cursor       |
| GET    | `/api/errors/:id`                                 | Single row (joined to `error_projects` for scope) |

### `error-runs`

| Method | Path                                  | Notes                          |
|--------|---------------------------------------|--------------------------------|
| GET    | `/api/error-runs?error_id=...&limit=` | Dispatch attempts for an error |
| GET    | `/api/error-runs/:id`                 | Single run                     |

### `error-setup`

| Method | Path                            | Notes                                                                                                                       |
|--------|---------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| POST   | `/api/error-setup/:project_id`  | Body: `{ supervisor_id, repo_path, coolify_app_uuid?, redeploy? }`. Returns `{ ok, stack, dsn, entry_file, manifest_file, commit_pushed, supervisor_error, coolify_env_set, coolify_env_error, redeployed, redeploy_error }` |

Failure codes:
- `404 project_not_found`
- `503 supervisor_offline`
- `403 forbidden` (supervisor belongs to a different user)
- `412 supervisor_command_missing` (`error_setup_probe` or `error_setup_apply` not registered)
- `502 supervisor_read_failed`
- `422 stack_not_detected` (also fires a 24h-throttled `stack_not_detected` email with copy-paste snippet + DSN)
- `500 entry_file_not_probed` (detection chose a path outside the probe list)
- `200 { ok: true, alreadyConfigured: true, ... }` when the snippet + manifest are already in place.

---

## SDK auto-install

`detectStack` is content-driven (no filesystem walk — the supervisor reads candidate files on behalf of the hub via `error_setup_probe`). Order: nextjs > express > django > fastapi; first match wins.

| Stack            | Detection signal                                                                 | Entry-file injection                                                                                                  | Manifest patch                                |
|------------------|----------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|-----------------------------------------------|
| `node-nextjs`    | `next.config.{js,ts,mjs}` present (+ `package.json`)                              | Prepend `@sentry/nextjs` init to `next.config.*` (snippet + manifest mode `package.json`)                              | `addSentryDep` → `@sentry/nextjs` in `dependencies` |
| `node-express`   | `package.json#dependencies.express` present (and not Next.js)                      | Prepend `import * as Sentry from '@sentry/node'; Sentry.init({ dsn: process.env.SENTRY_DSN, ... })` to entry            | `addSentryDep` → `@sentry/node` in `dependencies` |
| `python-django`  | `manage.py` present OR `wsgi.py` contains `django.core.wsgi`                       | Prepend `import sentry_sdk; sentry_sdk.init(...)` to entry                                                              | `addPythonSentryRequirement` → `sentry-sdk[django]` in `requirements.txt` |
| `python-fastapi` | Any `*.py` in probe set contains `from fastapi import FastAPI` or `FastAPI(`       | Prepend `import sentry_sdk; sentry_sdk.init(...)` to the file declaring `FastAPI()`                                     | `addPythonSentryRequirement` → `sentry-sdk[fastapi]` in `requirements.txt` |

`injectSnippet` is **idempotent** — it checks for `@sentry/node` / `@sentry/nextjs` / `sentry_sdk` markers and returns `alreadyConfigured` without re-prepending.

The apply step (`error_setup_apply` supervisor command) writes entry + manifest, runs `git add -A`, commits as `feat: install Sentry SDK for error capture`, and pushes to the default branch. **No PR is opened** — the user (or Coolify auto-deploy-on-push) takes it from there.

If `coolify_app_uuid` is supplied AND the commit was pushed, `setCoolifyEnv(app_uuid, 'SENTRY_DSN', dsn)` PATCHes the Coolify env. If `redeploy: true`, `redeployCoolifyApp(app_uuid)` triggers a deploy (defaults OFF — operator drives the redeploy).

Unsupported stacks → `422 stack_not_detected` + a throttled `stack_not_detected` email containing Node/Next/Python copy-paste snippets and the DSN.

---

## Silent-skip emails

`notifyThrottled(kind, dedupeKey, ttlSeconds, project, ctx)` writes a row to `notifications_sent` then sends via emails4agents (`POST /v1/messages/send` with `X-API-Key`). Per global rule, email **always** goes through emails4agents — no SES/SendGrid/Postmark/Mailgun/Resend.

| Kind                  | Fired when                                                  | TTL (seconds)             | Dedupe key                                  |
|-----------------------|-------------------------------------------------------------|---------------------------|---------------------------------------------|
| `dedupe_hit`          | Row matched an in-window fingerprint                         | `dedupe_window_seconds`   | `<project_id>:<fingerprint>`                |
| `rate_limit`          | Hourly count exceeded `rate_limit_per_hour`                  | 3600                      | `<project_id>`                              |
| `daily_cap`           | Successful dispatches today `>= daily_dispatch_cap`          | 86400                     | `<project_id>:<YYYY-MM-DD-in-user-tz>`     |
| `session_offline`     | Target session offline at dispatch time (parked in grace)    | 1800                      | `<project_id>:<session_id>`                 |
| `dispatch_failed`     | Queue dropped (`:busy`) or socket send threw (`:send`)       | 900                       | `<project_id>:<session_id>:{busy\|send}`    |
| `stack_not_detected`  | `error-setup` could not match any of the 4 supported stacks  | 86400                     | `stack_not_detected:<project_id>`           |

Throttle row is INSERTed BEFORE the email send attempt — a transient emails4agents failure can't cause a retry storm on the next error of the same kind. Email failure is log-only (never propagates up to the intake handler).

---

## Environment variables

| Var                       | Used by                          | Default                          | Purpose                                                |
|---------------------------|----------------------------------|----------------------------------|--------------------------------------------------------|
| `REMO_PUBLIC_URL`         | `error-projects.ts`, `error-setup.ts`, `prompt.ts` | `https://app.remo-code.com` | DSN host + `{{run_url}}` link in dispatch prompt |
| `E4A_API_KEY`             | `notify.ts`                       | —                                | emails4agents API key for silent-skip emails           |
| `E4A_BASE_URL`            | `notify.ts`                       | `https://api.emails4agents.com`  | emails4agents base URL                                 |
| `E4A_INBOX_ID`            | `notify.ts`                       | —                                | emails4agents inbox to send through                    |
| `COOLIFY_TOKEN`           | `setup/coolify-env.ts`            | —                                | Coolify API auth for `SENTRY_DSN` PATCH + redeploy     |
| `COOLIFY_URL`             | `setup/coolify-env.ts`            | —                                | Coolify base URL                                       |

If E4A env is missing, the throttle row is still written and the would-have-sent is logged (so the alert isn't retried on the next fire).

---

## Known follow-ups

- **Supervisor companion commands.** `error-setup` depends on `error_setup_probe` (composite read) and `error_setup_apply` (write + git add/commit/push). They are not yet shipped in the supervisor — `error-setup` currently returns `412 supervisor_command_missing` against any production supervisor. Tracked for the next supervisor release.
- **`notifications_sent.kind` CHECK constraint.** Schema CHECK currently omits `stack_not_detected`; `notify.ts` writes it at runtime. Either widen the CHECK or migrate the column to a softer constraint in a follow-up.
- **Decommission `claude-code-self-heal`.** The standalone service is superseded by this pipeline. Removal lands in a follow-up PR alongside DNS/Coolify cleanup.
- **`error_runs` cost + duration.** `cost_usd` and `duration_ms` are surfaced on `error_run_finished` but not yet persisted — finalize hook only writes `status`, `output_snippet`, `error`, and `finished_at`. Add columns + populate in `run-lifecycle.ts` when the scheduler's cost-capture helper is generalized.
- **`target_kind`.** v1 is `session`-only. Post-v1: `supervisor` (background remediation) and `all_sessions` (org-wide error firehose).
- **Auto-link by repo URL.** v1 requires explicit `session_id` at project-create time. Repo-URL match → session lookup is post-v1.

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
   │  │  error-runs   │  │  dispatcher  (adapter over │ │
   │  │  error-setup  │  │   shared dispatch pipeline)│ │
   │  └───────────────┘  │                            │ │
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
| `hub/src/error-capture/dispatcher.ts`      | **Thin adapter** over the shared `hub/src/dispatch/` pipeline: resolves project→session, builds the prompt + a `RunStore` (persists `error_runs`), sets `gates: [thresholdGate, dailyCostCapGate]`, supplies `replay`/`onParkExpire`/`send`, calls `dispatch()`, maps the `DispatchOutcome` back to error-capture WS events + `dispatch_status` |
| `hub/src/dispatch/pipeline.ts`             | Shared deep module (NOT error-capture-specific): gates → per-session queue → offline-grace park → agent-socket send → finalize hook. `onSessionReply` finalizes the in-flight run on `assistant_message` and promotes/re-dispatches any waiter |
| `hub/src/dispatch/grace.ts`                | Shared 10-min offline buffer (replaces the deleted `error-capture/grace.ts`); single 60s sweep; `onParkExpire` fires the legacy `skipped(target_offline_expired)` mark on TTL lapse |
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

As of the Round-2 hub-deepening refactor, `dispatcher.ts` is a **thin adapter over the shared `hub/src/dispatch/` pipeline** — it no longer hand-rolls the queue, the offline grace, or the finalize hook. The pipeline (`dispatch()` in `hub/src/dispatch/pipeline.ts`) owns gate ordering, the per-session queue (1 in-flight + 1 waiter), the offline-grace park, the send, and finalize-then-promote-then-redispatch.

`hub/src/error-capture/dispatcher.ts → dispatchPendingError(errorId)`:

1. Re-load the `errors` row; bail if not `pending` (idempotent).
2. Resolve the project → `session_id` + `user_id`. Build the prompt via `buildErrorMessage(error, project)` and the stored chat content `[error: <project.name> — <error_type>]\n\n<prompt>`.
3. Construct the adapter pieces and call `dispatch(req, deps)`:
   - **`gates: [thresholdGate, dailyCostCapGate]`** — threshold first, daily-cost-cap second (IR-2). The daily-cost-cap gate is **non-bypassable** (IR-1) and is NEW vs the legacy dispatcher (legacy gated only on the Claude usage threshold).
   - **`RunStore`** — `open()` inserts the `error_run` (status `in_flight`) and **returns its id**. The pipeline calls `open()` exactly when it actually dispatches (after gates + queue head-claim + online check — never for a skipped / dropped / queued / parked message; a queued waiter opens only when promotion re-dispatches it) and threads the returned run id into the finalize hook, so `onFinalize(runId, content)` / `markFailed(runId, err)` receive the **real run id**. `onFinalize()` moves the run to `success` + writes `output_snippet` + broadcasts `error_run_finished` (with the real `run_id`); `markSkipped()`/`markFailed()` set `dispatch_status` + broadcast `error_skipped` + throttled emails.
   - **`isOnline(req)`** = `getChannel(sessionId) != null`.
   - **`replay`** = re-run `dispatchPendingError(errorId)` (drained from grace on reconnect).
   - **`onParkExpire`** = `updateErrorDispatchStatus(skipped, 'target_offline_expired')` — the legacy TTL-lapse mark.
   - **`send`** = persist the user message (chat history) then `channel.ws.send({ type:'user_message', id, content:<bare prompt>, ts })`.
4. Map the `DispatchOutcome`:
   - `dispatched` → status `dispatched` (after the send succeeds) + broadcast `error_dispatched`.
   - `queued` → leave `pending`; the pipeline's `onSessionReply` promotes + re-dispatches the waiter through the full gate list (IR-2).
   - `parked_offline` → status `skipped(session_offline)` + throttled `session_offline` email (TTL 30 min, keyed `project_id:session_id`) + broadcast `error_skipped`. The pipeline parks the replay thunk in the shared grace buffer.
   - `dropped_busy` → status `skipped(session_busy)` (the `RunStore.markSkipped` already broadcast + threw the throttled `dispatch_failed` email).
   - `skipped` (gate block, e.g. cost-cap / threshold) → status `skipped(<reason>)`.
   - `failed` (send threw) → status `failed` + run `failed` + throttled `dispatch_failed` email.

### Spawn-on-error (opt-in lazy session start)

By default an inbound error whose bound session is **offline** finalizes `skipped(session_offline)` (above). With `REMO_SPAWN_ON_ERROR=1` (default **OFF** — ships dormant), the dispatcher passes an `ensureOnline` hook to the pipeline: when a gated, accepted repair targets an offline-but-existing session, `hub/src/dispatch/spawn-on-error.ts` **lazy-starts** that session via the supervisor's real `session.start` directive (NOT the dead `session.launch` drift), waits up to `REMO_SPAWN_ON_ERROR_TIMEOUT_MS` (default 25s) for the agent socket to appear, then dispatches — so idle apps auto-repair.

It runs **strictly after** the gate list (cost-cap / threshold / dedupe / rate-limit stay non-bypassable — a gated repair never spawns). Leak-safety: it uses the same hub-authoritative `reserveSessionSlot` → `createRun` → `session.start` sequence as the web/start endpoints, with `endRun` + `releaseSessionSlot` on send failure and a per-session in-flight lock; at capacity / no supervisor / timeout it returns false and the pipeline falls back to the existing park/skip (no orphan run). Flag OFF reproduces today's behaviour exactly.

Finalize happens via the **pipeline finalize hook**, not a per-subsystem run-lifecycle: the `/ws/agent` `assistant_message` branch calls `dispatch.onSessionReply(sessionId, content)`, which fires the in-flight error run's `RunStore.onFinalize` (→ `success`, `output_snippet`, `error_run_finished`) and then promotes/re-dispatches any queued errorId.

> **Transitional dual-path (Round-2 pilot):** error-capture is the FIRST subsystem migrated onto the shared pipeline. The `assistant_message` branch in `hub/src/ws/agent.ts` calls `onSessionReply` AND still calls the not-yet-migrated scheduler/triage/revanote `onAssistantMessage`/`onAgentReply` hooks. `onSessionReply` no-ops for any session without an active pipeline hook, so the calls coexist safely. The `// TODO(round2): collapse to onSessionReply once all subsystems migrated` comment marks where the legacy calls are removed once revanote/scheduler/telegram land on the pipeline.

### Offline grace

Now the **shared `hub/src/dispatch/grace.ts`** buffer (the old `error-capture/grace.ts` was deleted). When `dispatch()` finds the session offline it parks an opaque `replay()` thunk keyed by `sessionId` for 10 minutes. On `/ws/agent` auth success the agent handler calls `getGraceBuffer().drain(sessionId)` to re-run each live thunk; TTL-lapsed entries instead fire their `onExpire` (→ `skipped(target_offline_expired)`) exactly once, at drain-time or via the single 60s sweep — whichever observes the lapse first.

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

> **Why no official Sentry SDK (fleet-crash fix, pilot 2026-06-10):** error-project ids are **UUIDs**, but the official `sentry_sdk` / `@sentry/*` SDK requires an **integer** project id in the DSN and raises `BadDsn: Invalid project in DSN` at init — which **crash-loops every app** the snippet is installed into. So the snippet injects a tiny **dependency-free reporter** instead (proven in `finedesignz/mcp-factory` PRs #73 + #74). No `@sentry/*` / `sentry-sdk` dependency is added.

The reporter (per stack): reads the DSN from the `SENTRY_DSN` env var, parses `https://<key>@<host>/<uuid>` by hand, and POSTs a proper Sentry **envelope** (`{event_id}\n{"type":"event"}\n{event}\n`, the exact wire shape `error-capture/envelope.ts` accepts) to `https://<host>/api/sentry/<uuid>/envelope/?sentry_key=<key>`. It captures unhandled exceptions via the platform's process/excepthook hook plus a fail-open framework middleware, and is **fail-open** — any reporting error is swallowed so it can never take the host app down. **Node** uses the built-in `node:https`; **Python** uses the stdlib `urllib.request`.

`detectStack` is content-driven (no filesystem walk — the supervisor reads candidate files on behalf of the hub via `error_setup_probe`). Order: nextjs > express > django > fastapi; first match wins.

| Stack            | Detection signal                                                                 | Entry-file injection                                                                                                  | Manifest patch                                |
|------------------|----------------------------------------------------------------------------------|-----------------------------------------------------------------------------------------------------------------------|-----------------------------------------------|
| `node-nextjs`    | `next.config.{js,ts,mjs}` present (+ `package.json`)                              | Prepend dependency-free `node:https` reporter (`uncaughtException`/`unhandledRejection` → envelope POST) to `next.config.*` | none (no dependency — `addSentryDep` is a no-op) |
| `node-express`   | `package.json#dependencies.express` present (and not Next.js)                      | Prepend dependency-free `node:https` reporter (`uncaughtException`/`unhandledRejection` → envelope POST) to entry          | none (no dependency — `addSentryDep` is a no-op) |
| `python-django`  | `manage.py` present OR `wsgi.py` contains `django.core.wsgi`                       | Prepend stdlib `urllib.request` reporter (`sys.excepthook` + `got_request_exception` signal → envelope POST) to entry      | none (no dependency — `addPythonSentryRequirement` is a no-op) |
| `python-fastapi` | Any `*.py` in probe set contains `from fastapi import FastAPI` or `FastAPI(`       | Prepend stdlib `urllib.request` reporter (`sys.excepthook` + fail-open `BaseHTTPMiddleware` → envelope POST) to the file declaring `FastAPI()` | none (no dependency — `addPythonSentryRequirement` is a no-op) |

`injectSnippet` is **idempotent** — it checks for the `Remo error capture` reporter marker (and legacy `@sentry/node` / `@sentry/nextjs` / `sentry_sdk` markers) and returns `alreadyConfigured` without re-prepending. `addSentryDep` / `addPythonSentryRequirement` are now no-ops (return `alreadyConfigured: true`) because the reporter needs no third-party package.

The apply step (`error_setup_apply` supervisor command) writes the entry file, runs `git add -A`, commits as `feat: install Sentry SDK for error capture`, and pushes to the default branch. **No PR is opened** — the user (or Coolify auto-deploy-on-push) takes it from there.

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
- **`error_runs` cost + duration.** `cost_usd` and `duration_ms` are surfaced on `error_run_finished` but left null — the `RunStore.onFinalize` adapter writes only `status`, `output_snippet`, `error`, and `finished_at` (the agent stream protocol carries no per-turn cost, and the pipeline finalize hook does not thread a start timestamp). Populate when the shared dispatch pipeline exposes per-run timing/cost.
- **`target_kind`.** v1 is `session`-only. Post-v1: `supervisor` (background remediation) and `all_sessions` (org-wide error firehose).
- **Auto-link by repo URL.** v1 requires explicit `session_id` at project-create time. Repo-URL match → session lookup is post-v1.

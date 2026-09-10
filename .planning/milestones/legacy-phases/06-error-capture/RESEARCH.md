# RESEARCH — Error Capture

## Lift inventory
Files copied or adapted from `C:/Users/artic/GitHub/claude-code-self-heal/` into the remo-code hub:

| Source (self-heal) | Destination (remo-code worktree) | Adaptation |
|---|---|---|
| `src/sentry/envelope.ts` | `hub/src/error-capture/envelope.ts` | Verbatim; pure parser, no deps beyond `node:zlib`. Rename only. |
| `src/sentry/auth.ts` | `hub/src/error-capture/sentry-auth.ts` | Verbatim parser for `X-Sentry-Auth` header → `{ sentry_key, sentry_version, sentry_client }`. |
| `src/sentry/dsn.ts` | `hub/src/error-capture/dsn.ts` | Adapt: DSN format becomes `https://<sentry_key>@app.remo-code.com/<project_id>`. Drop self-heal's project-slug logic. |
| `src/sentry/mapper.ts` | `hub/src/error-capture/event-mapper.ts` | Maps a Sentry event payload → `{ error_type, error_value, top_frames, stacktrace_json, release }`. Drop self-heal's GitHub-attribution fields. |
| `src/fingerprint.ts` | `hub/src/error-capture/fingerprint.ts` | Verbatim. The `normalize()` + `fingerprint()` pair is exactly what we need. |
| `src/setup/detect.ts` | `hub/src/error-capture/setup/detect.ts` | Strip to 4 stacks (Express, Next.js, FastAPI, Django). Remove Astro/Vite-only paths. |
| `src/setup/snippet.ts` | `hub/src/error-capture/setup/snippet.ts` | Verbatim for Express + FastAPI + Django; add Next.js branch that emits the two `sentry.{server,client}.config.ts` files + `withSentryConfig` wrap. |
| `src/setup/setupRepo.ts` | (rewritten) `hub/src/error-capture/setup/orchestrator.ts` | Self-heal does this in-process with `simple-git`. In remo-code we delegate to the supervisor over WS — orchestrator just builds the file-edit plan and calls supervisor commands. |
| `src/routes/sentry.ts` | `hub/src/api/sentry-intake.ts` | Adapt: lookup by `sentry_key` → `error_projects` row; gate via our dedupe/rate-limit; on accept, hand off to in-process `dispatcher`. Drop self-heal's per-event GitHub commit lookup. |
| `src/github/webhookVerify.ts` (HMAC bits) | `hub/src/error-capture/hmac.ts` | Only the `timingSafeEqual` + `createHmac('sha256', secret)` helper is reused — for the eventual webhook post-run action (not v1 critical, but keep the helper handy). |

## Sentry envelope wire format
- URL pattern (what SDKs POST to): `POST /api/<project_id>/envelope/`. We expose `POST /api/sentry/:project_id/envelope/`.
- Header: `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<key>, sentry_client=sentry.javascript.node/9.0.0`.
- Body: newline-delimited JSON, optionally gzipped (look at `Content-Encoding: gzip`):
  1. envelope header `{ event_id, sent_at, dsn?, sdk? }`
  2. item header `{ type: "event", length?, content_type? }`
  3. item payload (the event itself)
  4. (repeat 2-3 for additional items: `attachment`, `transaction`, etc. — v1 ignores everything except `type=event` and `type=error`)
- Event payload of interest:
  - `exception.values[0].type` → `error_type`
  - `exception.values[0].value` → `error_value`
  - `exception.values[0].stacktrace.frames[]` → `top_frames` (reverse-iterate, take 8)
  - `release` → release
  - `event_id` → for idempotency dedupe at the request level (in addition to fingerprint dedupe)

## HMAC pattern (post-run webhook, future)
Lifted from self-heal `src/github/webhookVerify.ts`:
```ts
import { createHmac, timingSafeEqual } from 'node:crypto'
export function verifyHmacSha256(rawBody: Buffer, signatureHeader: string, secret: string): boolean {
  const mac = createHmac('sha256', secret).update(rawBody).digest('hex')
  const expected = Buffer.from(`sha256=${mac}`)
  const actual = Buffer.from(signatureHeader || '')
  if (expected.length !== actual.length) return false
  return timingSafeEqual(expected, actual)
}
```
Not on the v1 critical path (we have no `notify_webhook` in this phase). Land helper in `hub/src/error-capture/hmac.ts` so the post-v1 webhook action can reuse it.

## Session lookup options
**Option A — explicit operator pick (v1, locked).** `error_projects.session_id` is set at create time via a `<select>` of the user's sessions. When an error arrives, `INSERT INTO error_runs (session_id) SELECT session_id FROM error_projects WHERE id=$1`. FK has `ON DELETE SET NULL` so deleting a session disables dispatch (errors land as `skipped_disabled`) instead of breaking.

**Option B — auto-link by repo URL (post-v1).** Compare `sessions.project_dir` → git remote URL → normalize → match against `error_projects.repo_url`. Requires storing the repo URL on `error_projects` and adds ambiguity when one repo has multiple session copies. Defer.

Resolution at write time: dispatcher reads `error_projects.session_id` directly; no cache.

## SDK injection per stack

### Node + Express
- Detect: `package.json#dependencies.express` exists.
- Entry resolution: prefer `package.json#main`; else parse `package.json#scripts.start` for the first `.js`/`.ts` token; else fall back to `src/index.{ts,js}`, `src/server.{ts,js}`, `index.{ts,js}`.
- Snippet (TS):
  ```ts
  import * as Sentry from '@sentry/node';
  Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 });
  ```
- Snippet (JS): swap `import` for `const Sentry = require('@sentry/node');`.
- Manifest update: ensure `dependencies['@sentry/node'] = '^9.0.0'`.

### Node + Next.js
- Detect: `package.json#dependencies.next` exists.
- Files written: `sentry.server.config.ts`, `sentry.client.config.ts` at repo root (or wherever `next.config.*` lives). Both call `Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 1.0 })`.
- Wrap `next.config.{js,mjs,ts}` with `withSentryConfig` per `@sentry/nextjs` v9 conventions.
- Manifest: `@sentry/nextjs: ^9.0.0`.

### Python + FastAPI
- Detect: `fastapi` listed in `requirements.txt` or `pyproject.toml` (`[tool.poetry.dependencies]` or `[project].dependencies`).
- Entry: file that calls `FastAPI()`. Heuristic order: `main.py`, `app.py`, `app/main.py`, `src/main.py`. Grep for `FastAPI()` to confirm.
- Snippet:
  ```py
  import os
  import sentry_sdk
  sentry_sdk.init(dsn=os.environ.get("SENTRY_DSN"), traces_sample_rate=1.0)
  ```
- Manifest: append `sentry-sdk[fastapi]>=2.0` to `requirements.txt`, or insert into `[tool.poetry.dependencies]` / `[project].dependencies`.

### Python + Django
- Detect: `manage.py` at repo root + `django` in manifest.
- Settings path: parse `manage.py` for `os.environ.setdefault('DJANGO_SETTINGS_MODULE', '<project>.settings')`, resolve to `<project>/settings.py`.
- Snippet (prepended to settings.py, after any future imports):
  ```py
  import os
  import sentry_sdk
  sentry_sdk.init(dsn=os.environ.get("SENTRY_DSN"), traces_sample_rate=1.0)
  ```
- Manifest: append `sentry-sdk[django]>=2.0`.

All four use `injectSnippet()` idempotency from self-heal — if `@sentry/node`/`sentry_sdk` already appears, no-op + return `{ alreadyPresent: true }`.

## Coolify env-var PATCH
- Endpoint: `PATCH https://coolify.titaniumlabs.us/api/v1/applications/{uuid}/envs` (Coolify v4 API). Auth: `Authorization: Bearer ${COOLIFY_TOKEN}`.
- Payload shape: `{ "key": "SENTRY_DSN", "value": "<dsn>", "is_preview": false, "is_build_time": false, "is_literal": true }`.
- Idempotency: PATCH on an existing key overwrites; we look up the app UUID by name (matches the session's repo or supervisor-known mapping). If the env already exists with the same value, skip the PATCH.
- We do NOT redeploy by default. Coolify's "auto-deploy on commit" flag (if enabled by the user) handles it after the supervisor's `git push`. If not, the user clicks "Redeploy" themselves.

## DSN format
`https://<sentry_key>@app.remo-code.com/<project_id>`

- `<sentry_key>` — random 32-byte url-safe base64 string, stored on `error_projects.sentry_key` (unique index).
- `<project_id>` — the `error_projects.id` UUID; appears in the URL path the Sentry SDK POSTs to (`POST /api/<project_id>/envelope/`).
- Host is the public remo-code hub. Local dev uses `http://localhost:3040` (Sentry SDK does NOT require HTTPS).

## Dispatch payload shape
The dispatcher emits, over `/ws/agent` (no fork — reuse existing `user_message` outbound type):
```json
{
  "type": "user_message",
  "session_id": "<session uuid>",
  "message_id": "<server-issued uuid>",
  "content": "<rendered prompt from CONTEXT.md template>",
  "metadata": { "source": "error_capture", "error_id": "<uuid>", "run_id": "<uuid>", "project_id": "<uuid>" }
}
```
The `metadata` block is novel — extend `agent-protocol.ts` to accept an optional `metadata` passthrough that the agent forwards into the CLI as a sidecar (not interpreted, just logged). The CLI session receives the rendered `content` as a normal user turn.

Run finalization is driven the same way scheduled-tasks `senders/agent.ts` does it: subscribe to the next `assistant_message` / `result` for that session, capture `output_snippet` (first 1KB of assistant text), `duration_ms`, `cost_usd`, write to `error_runs`.

## Concurrency
- v1 reuses `hub/src/scheduler/session-queue.ts` directly. Same 1 in-flight + 1 waiter semantics.
- `enqueue()` returns `'dispatched' | 'queued' | 'dropped'`. On `dropped`, the `errors.dispatch_status` is set to `skipped_rate_limit` with `error='session_busy'` (distinct from the per-hour rate limit) and a summary email fires (daily-aggregated to avoid spam).
- On `markFinished()` / `onSessionIdleAndPromote()`: the dispatcher's promote handler routes the queued `error_id` through the same prompt-builder + send path.

## Dedupe + rate-limit + daily cost cap
**Dedupe (per project, fingerprint, window):**
```sql
SELECT 1 FROM errors
WHERE project_id = $1 AND fingerprint = $2
  AND received_at > now() - ($3 || ' seconds')::interval
LIMIT 1
```
If hit → status `skipped_dedupe`, no dispatch, still insert the row (for the UI counter), don't push to queue.

**Rate limit (per project, per hour):**
```sql
SELECT COUNT(*) FROM errors
WHERE project_id = $1
  AND dispatched_at IS NOT NULL
  AND dispatched_at > now() - interval '1 hour'
```
If `>= rate_limit_per_hour` → `skipped_rate_limit`, no dispatch.

**Daily cap (per project, calendar day in user TZ — v1 hardcodes UTC):**
```sql
SELECT COUNT(*) FROM errors
WHERE project_id = $1
  AND dispatched_at IS NOT NULL
  AND dispatched_at >= date_trunc('day', now())
```
If `>= daily_dispatch_cap` → `skipped_cap`, no dispatch, summary email fires once per day (gated by `notifications_sent`).

**Order of gates:** disabled → dedupe → rate-limit → daily-cap → session-busy. First-failing gate wins and is the recorded `dispatch_status`.

## Decommission of self-heal
After error-capture is shipped, tested in prod, and at least one real error round-trips through it:
- [ ] Close PR #2 (claude-code-self-heal main repo) with note pointing to remo-code phase 06.
- [ ] Close PR #3 (any open follow-up in self-heal).
- [ ] Coolify: stop + delete application `fxwnmfci3x44dwcjsyjh6sdj` (claude-code-self-heal).
- [ ] Coolify: delete the attached Postgres volume `bkzsx714w1vsxo35omakx9o2` after DB dump archived locally.
- [ ] Cloudflare: delete the tunnel for `errors.titaniumlabs.us` (or repoint to remo-code if a clean DNS swap is preferred; v1 just kills it — Sentry DSNs already point at `app.remo-code.com`).
- [ ] GitHub: archive the `claude-code-self-heal` repo (don't delete — keep history readable).
- [ ] Local: `rm -rf C:/Users/artic/GitHub/claude-code-self-heal`.
- [ ] Local: `rm -rf C:/Users/artic/.claude/projects/C--Users-artic-GitHub-claude-code-self-heal`.
- [ ] Update `~/.claude/CLAUDE.md` port map: remove the self-heal entry if present.

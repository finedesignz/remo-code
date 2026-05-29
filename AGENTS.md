# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Workflow: always use git worktrees for new features

**Mandatory.** When starting work on a new feature, phase, or non-trivial refactor, create a git worktree off `origin/main` and do ALL implementation work inside that worktree. Never build a new feature directly on the primary checkout — multiple Codex sessions and agents commonly run against this repo in parallel, and uncommitted/untracked files on the main checkout get wiped when another session switches branches or runs `git clean`.

```bash
cd C:/Users/artic/GitHub/remo-code
git fetch origin
git worktree add ../remo-code-feat-<slug> -b feat/<slug> origin/main
cd ../remo-code-feat-<slug>
# all subsequent work, commits, planning docs, agent dispatches happen here
```

Open the PR from `feat/<slug>` → `main` when ready. After merge, remove the worktree:

```bash
git worktree remove ../remo-code-feat-<slug>
git branch -D feat/<slug>
```

Exceptions: trivial single-file bugfixes, doc edits, README tweaks. Everything else — including planning docs under `.planning/phases/<N>-<slug>/` — lives in the worktree from the start.

## What This Is

Remo Code is a web app that lets you chat with Codex sessions remotely from any browser or phone. A local agent spawns Codex CLI with `--input-format stream-json --output-format stream-json`, giving the web UI full visibility into Codex's activity: thinking, tool calls, and streaming text responses.

It also ships **scheduled tasks** — a hub-side cron scheduler that fires user-defined prompts/skills/supervisor commands against one session, one supervisor, or all of either, with per-target run history, daily cost cap, offline-grace replay, and post-run actions. See [docs/scheduled-tasks.md](docs/scheduled-tasks.md).

It also ships **error capture** — a Sentry-style intake endpoint at `/api/sentry/:project_id/envelope/` that fingerprints, dedupes, rate-limits, and daily-caps runtime errors from your deployed apps, then dispatches them as structured `user_message` payloads into the Codex session bound to that repo so Codex can investigate, fix, commit, and push in-session. Includes one-click Sentry SDK auto-install for 4 stacks via supervisor git-ops + Coolify env PATCH. See [docs/error-capture.md](docs/error-capture.md).

## Architecture

```
Browser (React SPA)
    ↕ WebSocket /ws/client  +  REST /api/*
Hub Server (Bun + Hono, port 3040)
    ↕ WebSocket /ws/agent
Local Agent (Bun, runs on dev machine)
    ↕ subprocess stdin/stdout (stream-json)
Codex CLI (persistent interactive process)
```

Four packages in a Bun workspace:
- **hub/** — Bun + Hono HTTP/WS server. Authenticates users via Supabase JWT, manages sessions, relays messages and activity events between web clients and agents.
- **web/** — React 19 + Vite + Tailwind CSS 4 SPA. Connects to hub via WebSocket for real-time chat with activity feed (thinking blocks, tool call indicators, streaming text).
- **agent/** — Local streaming agent. Runs on the dev machine, spawns a persistent Codex CLI process, parses stream-json events, and relays them to the hub. Authenticates with an API key.
- **channel/** — (Legacy) Codex channel plugin. Kept for backward compatibility but no longer the recommended connection method.

## Commands

```bash
# Install dependencies (from repo root)
bun install

# Run hub server (port 3040)
bun run dev:hub

# Run web dev server (port 5173)
bun run dev:web

# Build web for production
bun run build:web

# Run the local agent (recommended: set up a shell alias)
# alias Codex-remote='npx remo-code-agent --api-key <your_api_key> --local-output'
Codex-remote

# Or run directly (connects to production hub, output to terminal + web)
npx remo-code-agent --api-key <your_api_key> --local-output

# Connect to local hub for development
npx remo-code-agent --hub-url http://localhost:3040 --api-key <your_api_key> --local-output

# Web UI only (no terminal output)
npx remo-code-agent --api-key <your_api_key>
```

## Local Agent (Recommended Connection Method)

The agent (`agent/src/index.ts`) runs on the same machine as Codex. It:

1. Connects to the hub via WebSocket at `/ws/agent`, authenticates with an API key
2. Spawns Codex CLI: `Codex --input-format stream-json --output-format stream-json --verbose`
3. Keeps a single persistent Codex process alive (full conversation memory)
4. Receives user messages from the hub, writes them to Codex's stdin as JSON
5. Parses Codex's stdout stream-json events and relays to the hub in real-time
6. Hub broadcasts activity events (thinking, text_delta, tool_use, tool_result) to subscribed browsers

**Session resume:** The agent reuses existing sessions by matching `project_dir`. Restarting the agent in the same directory reconnects to the same session with full message history.

**Config priority:** CLI args > env vars (`REMO_HUB_URL`, `REMO_API_KEY`) > config file (`~/.config/remo-code/config.json`)

## Database

Uses **PostgreSQL** (self-hosted). Schema in `hub/src/db/schema.sql` — run once on a fresh database.

Tables: `users` (email + bcrypt password, role), `sessions` (Codex sessions), `messages` (chat history), `api_keys` (agent authentication). All queries are scoped by `user_id` with explicit WHERE clauses.

## WebSocket Protocol

**`/ws/agent`** (local agent connects here):
- Auth: `{ type: "auth", api_key, project_dir, hostname }` → API key verified via SHA-256 hash, session found-or-created by project_dir
- Agent sends: `thinking`, `text_delta`, `tool_use`, `tool_result`, `status`, `assistant_message`
- Hub sends: `user_message` (with optional `images`/`attachments`), `cancel`, `ping`
- 30s heartbeat ping/pong

**`/ws/client`** (browser connects here):
- Auth: `{ type: "auth", token: "<jwt>" }` → verified via `JWT_SECRET`
- Client sends `send_message` (with optional `images`/`attachments`) and `subscribe`
- Hub sends `message`, `session_status`, `session_list`, plus activity events (`thinking`, `text_delta`, `tool_use`, `tool_result`, `status`)
- Both endpoints have 5s auth timeout, per-IP connection limits (20), per-connection message rate limits

**`/ws/channel`** (legacy channel plugin):
- Kept for backward compatibility. Same protocol as before.

All WS messages validated with Zod schemas in `hub/src/ws/protocol.ts` and `hub/src/ws/agent-protocol.ts`.

## Key Design Decisions

- Agent spawns Codex CLI with `--input-format stream-json --output-format stream-json` for full activity streaming
- Persistent Codex process per agent (conversation memory preserved across messages)
- Session resume by project_dir (agent reconnects to existing session on restart)
- Activity events (thinking, tool use) are ephemeral — only the final assistant_message is persisted
- File attachments: text files embedded in message content, images as base64 data URIs
- Light/dark theme via CSS custom properties (--bg-primary, --text-primary, etc.)
- Session tokens use `remo_` prefix + 32 random bytes (base64url), stored as SHA-256 hashes
- The hub serves the built web SPA as static files (no separate web server in production)
- Subscription quota (5h + 7d Anthropic utilization) is polled by the **local agent**, not the hub — the OAuth access token lives only in `~/.Codex/.credentials.json` on the dev machine and never leaves it. Hub keeps a per-user in-memory snapshot (`hub/src/usage/store.ts`) and rebroadcasts to web clients via WS event `subscription_usage`. See [docs/agent.md](docs/agent.md).

## Environment Variables

**hub/.env**: `DATABASE_URL` (PostgreSQL connection string), `JWT_SECRET` (min 32 chars), `PORT` (3040), `HUB_ALLOWED_ORIGINS`

**web/.env**: `VITE_HUB_URL`

**Agent config**: CLI args, env vars (`REMO_HUB_URL`, `REMO_API_KEY`), or `~/.config/remo-code/config.json`

**Scheduled tasks (optional):**
- `REMO_PUBLIC_URL` — prefix for `{{run_url}}` template var in post-run actions (default `https://app.remo-code.com`).
- `COOLIFY_TOKEN` — required only if `log_check` tasks are configured.
- `E4A_API_KEY`, `E4A_BASE_URL`, `E4A_INBOX_ID` — required only if `notify_email` post-run actions are configured. Email notifications always use emails4agents per the global rule.
- `REMO_E2E_DB_URL` — disposable Postgres URL for the e2e test in `hub/test/scheduled-tasks.e2e.test.ts` (tests skip if unset).

## Scheduled Tasks

Hub-side cron scheduler that fires user-defined tasks against connected agents/supervisors on a recurring cadence. Full architecture in [docs/scheduled-tasks.md](docs/scheduled-tasks.md).

- **Module:** `hub/src/scheduler/` (V2 dispatcher) — the legacy v0 scheduler at `hub/src/scheduler/index.ts` is still wired during the transition and will be removed in a follow-up.
- **Key files:** `cron.ts` (croner wrapper + presets), `dispatcher.ts` (cost-cap + fan-out + route), `targets.ts` (resolve target_kind), `session-queue.ts` (1 in-flight + 1 waiter), `catchup.ts` (boot replay), `grace.ts` (10-min offline buffer), `senders/{agent,supervisor,coolify}.ts`, `post-run/{dispatcher,schema,template,aggregator,chain,email,telegram,webpush,webhook}.ts`.
- **Agent sender directive:** `hub/src/scheduler/senders/agent.ts` appends a `Summary:` directive to the content sent to Codex's stdin (forces a 1-line summary at the end of every scheduled run). The content **stored** in `messages` is unchanged — `[scheduled: <task name>]\n\n<prompt>` — only the sent string carries the directive.
- **Web mirror:** `web/src/lib/cron.ts` keeps the "next 3 runs" preview API-compatible with the hub.
- **Web UI files:** `web/src/components/CronBuilder.tsx` (dropdown cron composer, 8 modes), `web/src/lib/cron-humanize.ts` (`humanizeCron` plain-English renderer shared by builder + list row), `web/src/lib/format.ts` (`formatDuration`, `formatCostUsd`, `formatRelativeAgo`), `web/src/lib/scheduled-message.ts` (`parseScheduledPrefix` → indigo `Scheduled:` pill in `MessageBubble`).
- **List + drawer:** `web/src/components/SchedulesPage.tsx` (search + status + task-type filters; last-run cost/duration chips; tz-aware `Next:` + `Fired Xm ago`), `web/src/components/ScheduleRunsDrawer.tsx` (status filter chips with live counts + summary stats banner).
- **API shape:** list + single-task endpoints include `last_run_cost_usd` and `last_run_duration_ms` (LATERAL JOIN on `scheduled_task_runs` keyed by `task_id`, most recent finalized run).
- **REST:** `hub/src/api/scheduled-tasks.ts`, `hub/src/api/scheduled-task-runs.ts`. WS events extend `hub/src/ws/protocol.ts`.
- **Tests:** `hub/test/scheduler.test.ts` (41 unit tests, no DB needed), `hub/test/scheduled-tasks.e2e.test.ts` (skipped without `REMO_E2E_DB_URL`).

When adding a new task type, post-run action, or any scheduler change: update `docs/scheduled-tasks.md` and `hub/test/scheduler.test.ts` in the same commit. The unit-test file is the contract — keep it green.

## Error Capture

Sentry-style error intake routed back into the Codex session bound to each repo. Full architecture in [docs/error-capture.md](docs/error-capture.md).

- **Module:** `hub/src/error-capture/` (Phase 06). Public intake endpoint at `hub/src/api/sentry-intake.ts` mounted OUTSIDE the `/api/*` JWT catch-all — `sentry_key` in `X-Sentry-Auth` IS the credential.
- **Key files:** `auth.ts` (header parser), `envelope.ts` (gunzip + multi-line JSON), `fingerprint.ts` (sha-256 of project + type + value + top-3 frames), `record.ts` (3 gates: dedupe → rate-limit → daily-cap), `notify.ts` (silent-skip emails via emails4agents, throttled), `prompt.ts` (dispatch prompt builder), `dispatcher.ts` (per-session queue claim + agent socket send — reuses `scheduler/session-queue.ts` verbatim), `run-lifecycle.ts` (finalize on next `assistant_message`), `grace.ts` (10-min offline buffer), `setup/{detect,snippet,coolify-env}.ts`.
- **REST:** `hub/src/api/{sentry-intake,error-projects,errors,error-runs,error-setup}.ts`. WS events extend `hub/src/ws/protocol.ts` (`error_received`, `error_dispatched`, `error_run_finished`, `error_skipped`).
- **DB tables** (`hub/src/db/schema.sql`, idempotent `CREATE TABLE IF NOT EXISTS`): `error_projects(id, user_id, name, sentry_key UNIQUE, session_id, dedupe_window_seconds=60, rate_limit_per_hour=20, daily_dispatch_cap=50, enabled)`, `errors(id, project_id, fingerprint, error_type, error_value, stacktrace_json, release, received_at, dispatch_status, dispatched_at, skip_reason)`, `error_runs(id, error_id, project_id, session_id, status, started_at, finished_at, output_snippet, error)`, `notifications_sent(id, kind, dedupe_key, sent_at)`.
- **Web UI:** `web/src/components/{ErrorCapturePage,ErrorProjectEditor,ErrorDetailDrawer,ErrorSetupModal}.tsx` — Settings → Error Capture tab. Per-project row launches `ErrorSetupModal` for one-shot SDK install.
- **Supported auto-install stacks** (`setup/detect.ts`, content-driven, no fs walk): Node+Express, Node+Next.js, Python+FastAPI, Python+Django. Order: nextjs > express > django > fastapi. Anything else → 422 + throttled `stack_not_detected` email with copy-paste snippet + DSN.
- **Coolify integration:** `setup/coolify-env.ts → setCoolifyEnv(app_uuid, 'SENTRY_DSN', dsn)` + optional `redeployCoolifyApp`. `COOLIFY_TOKEN` + `COOLIFY_URL` env required for the auto-install path.
- **Silent-skip emails always go through emails4agents** (per global rule #7). Throttle row is written BEFORE the send attempt to prevent retry storms.

When adding a new dispatch gate, supported stack, supervisor companion command, or any error-capture change: update `docs/error-capture.md` in the same commit.

## Grid View

Multichat grid view at `#/grid` and `#/grid/:tabId` — watch up to 12 Codex sessions in one browser frame. Full architecture in [docs/grid-view.md](docs/grid-view.md).

- **Components:** `web/src/components/GridPage.tsx` (tab bar + grid container + layout picker), `ChatSurface.tsx` (the chat surface — three densities: `full`, `cell`, `mobile-expanded`), `MobileAccordion.tsx` (mobile branch, single ChatSurface mounted at a time, unmount-on-collapse), `SessionPicker.tsx` (add/remove tab membership).
- **REST:** `/api/chat-tabs` (list/create), `/api/chat-tabs/:id` (PATCH name/layout/position, DELETE cascade), `/api/chat-tabs/order` (bulk reorder), `/api/chat-tabs/:id/sessions` (POST add, PATCH bulk reorder), `/api/chat-tabs/:id/sessions/:sessionId` (DELETE remove). Batch initial-history: `GET /api/sessions/messages?ids=a,b,c&limit=30` returns `{ [sessionId]: Message[] }` in one round-trip. Hard cap of 12 ids server-side.
- **WS subscribe overload** (in `hub/src/ws/protocol.ts`) — back-compat: accepts EITHER shape, never both at once:
  ```ts
  // legacy single
  { type: 'subscribe', session_id: 'sess_abc' }
  // multi (new)
  { type: 'subscribe', session_ids: ['sess_a', 'sess_b', 'sess_c'] }
  ```
  Per-connection cap is 12 active session_ids. Violations get `{ type: 'subscribe_error', error: 'too_many_sessions', max: 12 }`. The hub holds a `Set<sessionId>` on the connection state and routes activity events by set membership.
- **DB tables** (both user-scoped, cascade FKs): `chat_tabs(id, user_id, name, layout, position, created_at, updated_at)` and `chat_tab_sessions(tab_id, session_id, position, created_at)` with composite PK `(tab_id, session_id)`. Migrations are idempotent `CREATE TABLE IF NOT EXISTS` in `hub/src/db/schema.sql`.
- **Performance design:** streaming `text_delta` events are RAF-coalesced in the ChatSurface (one React state update per frame; raw deltas accumulate in a ref). Hub-side throttling is FORBIDDEN — would break the scheduled-tasks event-ordering contract. Message lists are virtualized with `@tanstack/react-virtual` for all three densities.
- **Mobile auto-swap:** CSS-first via Tailwind `md:` breakpoint (768px). Below `md`, GridPage renders `<MobileAccordion>` instead of the grid regardless of route. Use `100dvh`/`100svh` — never `100vh` (iOS Safari keyboard collapses `vh`).
- **Active cell:** tracked per tab in `sessionStorage` (`grid:lastActiveCell:<tabId>`), NOT URL. Document-level paste/drop is scoped via `data-chat-surface-cell-id` so typing in cell A keeps paste routed to A even when focus drifts.

### Dependencies of note

- **`@tanstack/react-virtual`** (`web/package.json`) — virtualizes the message list in `ChatSurface` across all densities. The only new web dep added in Phase 03.

When adding a new ChatSurface density, layout mode, tab-membership op, or any grid behavior: update `docs/grid-view.md` in the same commit.

## Phase 05: Codex CLI + Rootless Ambient Sessions

Sessions can run either **Codex** or **Codex** (`sessions.cli_kind` — `'Codex' | 'codex'`, pinned at create time). Each agent can also host **rootless ambient sessions** (one per CLI per host, no `project_dir`) advertised via `auth` payload `rootless_sessions: ['Codex','codex']`. Partial unique index `idx_sessions_rootless_unique` enforces one-per-(user,host,cli). Rootless runners spawn lazily on first `user_message` with cwd `~/.remo-code/rootless/<cli>/`.

**Codex transport:** `codex app-server` over child-process stdio JSON-RPC (newline-delimited with LSP `Content-Length:` fallback auto-detected). `CodexRunner` translates Codex notifications into the same `RunnerEvent` union Codex emits, so the web UI renders both identically. **Spike status:** framing + method names per research §1.3 — not yet live-verified.

**Instructions sync (`seed_files` in `auth_ok`):** three `users.*` TEXT columns (`claude_global_md`, `codex_agents_md`, `codex_config_toml`) sync to the agent on connect. Agent writes each file **create-if-absent only** — it NEVER overwrites; on sha-256 drift it emits an `agent_log` warning. Edit blobs at Settings → Instructions. `PUT /api/instructions` strips secret-looking lines (`api_key`, `token`, `secret`, `password`) from `codex_config_toml`.

**File map** (see [docs/codex-and-rootless.md](docs/codex-and-rootless.md) for the full architecture):
- Agent: `agent/src/cli-runner.ts` (`CliRunner` interface + `RunnerEvent` union), `Codex-runner.ts`, `codex-runner.ts`, `codex-jsonrpc.ts`, `seed.ts`, `index.ts` (per-session runner `Map<sessionId, CliRunner>`)
- Hub: `hub/src/api/instructions.ts`, `hub/src/db/dal.ts` (`findOrCreateRootlessSession`, `getUserInstructions`, `updateUserInstructions`), `hub/src/ws/agent.ts` (auth handler builds `cli_kind` + `rootless_session_ids` + `seed_files`)
- Web: `web/src/components/SettingsPage.tsx` (Instructions tab), `Sidebar.tsx` (codex/ambient badges), `useSessions.ts` (`CodeSession.cli_kind`, `is_rootless`, `hostname`)

When adding a new CLI runner, modifying the Codex protocol mapping, changing seed semantics, or extending instruction blobs: update `docs/codex-and-rootless.md` in the same commit.

## Phase 06: Coolify Self-Heal Absorb

Absorbs the standalone `coolify-ai-monitor` Express service (port 3032, now retired) into the hub's scheduler + post-run pipeline. Public HMAC-signed Coolify webhook → `triage` run → structured `TriageResult` JSON → optional `github_issue` post-run action. Full architecture in [docs/scheduled-tasks.md](docs/scheduled-tasks.md) (sections "Coolify webhook ingress", "GitHub-issue post-run action", and the `triage` task_kind row) and the end-to-end migration plan in [docs/coolify-webhook-migration.md](docs/coolify-webhook-migration.md).

**File map (shipped on this branch):**

- `hub/src/api/coolify-webhook.ts` — public ingress with TWO routes: primary `POST /api/coolify/webhook/:user_id/:token` (URL-path token, constant-time compare — matches Coolify's URL-only webhook UI) and legacy `POST /api/coolify/webhook/:user_id` (HMAC headers, deprecated 30-day grace, returns `Deprecation: true` + `Sunset:`). Both flow through a shared `handleAuthenticated` pipeline: optional IP allowlist (`users.coolify_webhook_allowed_ips`) → Zod validate (event-name `EVENT_ALIAS` normalizes `deployment_success`/`deployment_failed` underscore forms emitted by Coolify's `SendWebhookJob` to the dotted internal canonical) → persist run → triage on failure → audit row in `coolify_webhook_attempts` (every hit, capped 100/user). CIDR helper at `hub/src/lib/cidr.ts`.
- `hub/src/api/account.ts` — `POST /api/account/coolify-webhook-secret/rotate` + `GET .../coolify-webhook-secret` (returns full URL with token embedded), `GET .../coolify-webhook-attempts?limit=10` (audit log), `GET`/`PUT .../coolify-webhook-allowed-ips`.
- `hub/src/lib/cidr.ts` — zero-dep IPv4/IPv6 + CIDR allowlist helper. `parseAllowlist`, `ipAllowed`, `sourceIpFromHeaders` (cf-connecting-ip → x-real-ip → first x-forwarded-for hop).
- `hub/src/scheduler/triage-schema.ts` — `TriageResult` Zod schema + `parseTriageOutput` (tolerates ```json fences, rejects bare prose).
- `hub/src/scheduler/triage-prompt.ts` — `renderTriagePrompt` template for `task_kind: 'triage'` runs.
- `hub/src/scheduler/post-run/schema.ts` — `github_issue` variant added to the discriminated union.
- `hub/src/scheduler/post-run/github-issue.ts` — `executeGithubIssue`: loads creds from gateway pair, renders body via `template.ts`, sha256 idempotency over `(repo, application_uuid, deployment_uuid)` in `github_issue_idempotency` (24h window). Failures are log-only.
- `hub/src/db/dal.ts` — `getUserCoolifyWebhookSecret`, `rotateUserCoolifyWebhookSecret`, `ensureInternalDeploymentTask`, `hasOpenIssueForHash`, `recordOpenIssueForHash`.
- `hub/src/db/schema.sql` — new nullable columns on `scheduled_task_runs` (`deployment_uuid`, `application_uuid`, `git_repository`, `commit_sha`), `users.coolify_webhook_secret`, `github_issue_idempotency` table.
- Tests: `hub/test/coolify-webhook.test.ts`, `coolify-webhook-secret.test.ts`, `triage-schema.test.ts`, `post-run-github-issue.test.ts`.

**Pending (NOT shipped on this branch — depends on Phase 04 plan 008):**

- `hub/src/scheduler/log-classifier.ts` (Phase 06 plans 002/003) — 16-pattern regex gate over `log_check` output before LLM spend.
- `hub/src/scheduler/senders/triage.ts` + the real body of `dispatchTriageStub` (Phase 06 plan 008) — routes synthesized triage runs through `pickSessionTarget` (which lives in unmerged Phase 04 plan 008). Until plan 008 lands, the webhook persists rows but does NOT dispatch to a session.

**Key invariants:**

- **Cost cap.** All triage runs flow through `hub/src/scheduler/dispatcher.ts` `enforceCostCap`. No new fan-out path bypasses the daily cap. The classifier (when wired) skips post-run actions when no errors detected — preserves the cap.
- **GitHub creds via gateway pair, ALWAYS.** Token fetched via `GET {GATEWAY_URL}/api/credentials/service/github`. There is no `GITHUB_TOKEN` env var on the hub. Per global AGENTS.md MCP server auth architecture.
- **Webhook HMAC.** `X-Coolify-Signature: sha256=<hex>` over `${X-Coolify-Timestamp}.${rawBody}`, constant-time compared; reject `>5 min` skew. Raw body must be read BEFORE any JSON parse.
- **Idempotency.** `github_issue` skips when `sha256(repo|application_uuid|deployment_uuid)` exists in `github_issue_idempotency` within 24h — no duplicate issues for the same failed deployment.
- **GitHub-issue failures never fail the parent run** — log-only; Octokit errors are swallowed.

When adding a new triage payload field, post-run action, or webhook event type: update `docs/scheduled-tasks.md` and `docs/coolify-webhook-migration.md` in the same commit.

## Phase 07: Titanium Licensing Auth Cutover

Replaces bcrypt + JWT user-auth with **Titanium Licensing** (Keygen-backed) magic-link login + opaque cookie sessions, and gates feature endpoints on a synced `license_status` mirror. The legacy path stays alive behind `ALLOW_LEGACY_LOGIN` for one release as the rollback. Full architecture in [docs/auth.md](docs/auth.md).

**File map (hub):**

- `hub/src/config.ts` — typed `config.titanium.*`, `config.magicLinkSecret`, `config.sessionSecret`, `config.allowLegacyLogin` parsed from env at boot. Missing required vars = fatal.
- `hub/src/titanium-client.ts` — JWKS-cached EdDSA verifier for Keygen tokens + license `validate` calls. Tests live in `hub/test/titanium-client.test.ts` (offline vectors at `hub/test/fixtures/titanium-vectors.json`).
- `hub/src/session.ts` — opaque cookie sessions (random token, sha-256 in DB, sliding refresh). `createAuthSession`, `verifyAuthSessionCookie`, `revokeAuthSession`. Persists to the `auth_sessions` table.
- `hub/src/csrf.ts` — double-submit cookie + `X-CSRF-Token` header check on all state-changing routes.
- `hub/src/license-gate.ts` — middleware factory. Reads `license_status` from `users` via `getUserLicenseFields`, refreshes through `titanium-client` if stale (TTL `TITANIUM_LICENSE_CACHE_TTL_SECONDS`), 402s when not `active`. **Exclusion list** (NEVER license-gated): `/api/auth/*`, `/api/profile/license`, `/api/profile`, `/healthz`, the Sentry intake, the Coolify webhook, the Titanium license-changed webhook, and `/ws/agent` (agent traffic is keyed by `api_keys`, not user license).
- `hub/src/auth/middleware.ts` — dual-auth. Tries cookie first, falls back to `Authorization: Bearer <jwt>` ONLY when `config.allowLegacyLogin === true`. Sets `c.set('userId')` and `c.set('authMethod')` (`session_cookie` | `legacy_jwt`).
- `hub/src/auth/reauth.ts` — short-window step-up gate. Required by sensitive ops (api-key creation, email change, account delete).
- `hub/src/api/auth.ts` — new routes: `POST /request-link`, `GET /callback`, `POST /logout`. Legacy `POST /login` + `POST /register` are still mounted but return 410 when `!config.allowLegacyLogin`.
- `hub/src/api/profile.ts` — plain Hono. Excluded from license gate.
- `hub/src/api/_openapi.ts` — `GET /api/profile/cost-today` and `GET /api/profile/license` are OpenAPI-aware (zod schemas). Both are mounted ahead of the plain `profile.ts` twin and excluded from license gating.
- `hub/src/api/webhooks-titanium.ts` — `POST /webhooks/titanium/license-changed`. HMAC over `${ts}.${rawBody}`, raw body read BEFORE JSON parse. Returns 503 when `TITANIUM_WEBHOOK_SECRET` is unset.
- `hub/scripts/migrate-users-to-titanium.ts` — one-shot script: looks up each user in the Titanium portal, writes `titanium_subject` + initial `license_status`, marks unmatched rows `titanium_link_status='pending_verify'`.
- `hub/src/db/schema.sql` — additive only this phase: `users.titanium_subject`, `users.license_status`, `users.license_id`, `users.license_checked_at`, `users.titanium_link_status`, `users.candidate_subject`; new `auth_sessions` table; new `auth_events` audit table. `password_hash` STAYS.
- `hub/src/db/dal.ts` — `getUserByTitaniumSubject`, `linkTitaniumSubject`, `setPendingVerify`, `promoteCandidateSubject`, `getUserLicenseFields`, `updateLicenseStatus`, `updateUserEmail`, `createAuthSession`, `getAuthSessionByToken`, `touchAuthSession`, `deleteAuthSession`, `purgeExpiredAuthSessions`, `recordAuthEvent`.

**File map (web):**

- `web/src/lib/auth.ts` — cookie-aware fetch helpers; magic-link `requestLink` + `completeCallback`; portal URL helper reading `VITE_TITANIUM_PORTAL_URL`.
- `web/src/hooks/useLicense.ts` — polls `GET /api/profile/license` every 5 min; returns `'active' | 'expired' | 'suspended' | 'banned' | 'none' | 'unknown'`. 404 is treated silently as `unknown` (back-compat with pre-endpoint deploys); 402 maps to `expired`.
- `web/src/components/Layout.tsx` — renders the license badge (color + tooltip) from `useLicense`.
- `web/src/App.tsx` — magic-link request page + callback route; "Manage account" link to the Titanium portal.

**Key invariants:**

- **Legacy path is gated, NOT deleted this phase.** `ALLOW_LEGACY_LOGIN`, `password_hash`, `bcrypt`, `hub/src/auth/password.ts`, and `JWT_SECRET` all stay alive through the soak. Phase 07.5 deletes them.
- **`SESSION_SECRET` is never rotated as part of a routine cutover** — that would log out every Titanium-cookie user. D14's force-reissue rotates `JWT_SECRET` (kills legacy bearer JWTs) and leaves `SESSION_SECRET` alone.
- **`/api/profile/license` is auth-gated, NOT license-gated** — it IS the license-status endpoint; gating it on itself is a circular dep. Same exclusion applies to `/api/auth/*`, `/healthz`, and webhooks.
- **`/ws/agent` traffic is keyed by `api_keys`, never by user license.** A user with `license_status='expired'` can still observe agent traffic in read-only mode; only user-initiated mutations are blocked.
- **Magic-link jti single-use.** `TITANIUM_REQUIRE_REDIS=true` (default) hard-fails boot when Redis is absent, preventing silent replay-protection degradation. Set `false` only for local dev.
- **Webhook HMAC and raw-body discipline mirror the Coolify webhook** (Phase 06): raw body MUST be read before JSON parse, signature over `${ts}.${rawBody}`, constant-time compare, reject >5 min skew. Unset secret → 503.
- **Per-stack rules #16, #17, #18 from global AGENTS.md apply.** This phase is the implementation of #16 (auth/billing → Titanium) on this app.

When adding a new license-gated endpoint, exclusion-list entry, magic-link claim, webhook event, session-lifecycle hook, or any Phase 07 surface: update `docs/auth.md` in the same commit. Phase 07.5 cleanup items (password/JWT removal) get appended to `docs/auth.md`'s "07.5 follow-up" section so the cutover plan is preserved alongside the doc.

## Hub shared dispatch + webhook-intake modules (hub-deepening, 2026-05-28)

Two **deep modules** extracted to replace copied-N-times patterns. Currently FOUNDATION ONLY — landed and tested, wired into nothing yet. Round-2 migrations move each subsystem onto them and delete the copies. **Do NOT hand-roll the old per-subsystem versions.**

- **`hub/src/dispatch/`** — the session-dispatch pipeline that scheduler / error-capture / revanote / telegram each used to re-implement (gates → queue → grace → finalize). `dispatch(req, deps)` (`pipeline.ts`) runs `deps.gates[]` in order (first block wins → `{kind:'skipped'}`) → claims the per-session queue (`dispatched` / `queued` / `dropped_busy`) → if the agent is offline, releases the slot and parks `deps.replay` in grace (`parked_offline`) → else sends the `user_message` via `deps.send` and registers a finalize hook. `onSessionReply(sessionId, content)` is the single fan-in from the agent `assistant_message` branch: it finalizes the active hook, then promotes the queue waiter and re-dispatches it through the FULL gate list again. Pieces: `SessionQueue` (`session-queue.ts` — instance class, 1 in-flight + 1 waiter, `markFinished` returns the promoted token, no global `setOnPromote` seam); `getGraceBuffer()` (`grace.ts` — singleton, `register(key, replay, { ttlMs, onExpire })`, `drain(key)`, 10-min `DEFAULT_TTL_MS` + 60s `unref`'d sweep, `onExpire` fires exactly once at drain- or sweep-time); `gates.ts` (`thresholdGate`, `dailyCostCapGate` — wraps the single-source-of-truth `isOverCostCap` SQL — and `concurrencyGate(supervisorId)`). `hub/src/scheduler/session-queue.ts` is now a back-compat shim delegating to a shared `SessionQueue` (keeps `setOnPromote` scoped to the un-migrated scheduler) — keep `hub/test/scheduler.test.ts` green (it is the contract). **Promotion behaviour change:** legacy silently stranded the 2nd same-session message; the pipeline releases the slot then re-dispatches through every gate (IR-2), so a user who crossed the cost cap while queued is skipped — migrations must heed this. Known accepted gap: cross-source same-session ordering is best-effort across the await between release and re-enqueue.
- **`hub/src/webhooks/intake.ts`** — the public-webhook auth gate that coolify / sentry / revanote / telegram each repeated. `runIntake(c, cfg)` does raw-body-before-parse (`c.req.text()`) → resolve presented/expected secret via `cfg.resolveSecret` → constant-time compare → optional HMAC over `${ts}.${rawBody}` (or `rawBody` alone when no `hmacTimestampHeader`) → skew → optional per-owner IP allowlist → audit per `cfg.audit` policy, returning `{ ok:true, ownerId, rawBody }` or a uniform non-leaky `401` (`403` for IP rejection, after a valid credential). Per-webhook differences (sentry header-cred / no-HMAC / no-audit-on-fail, coolify URL-token + IP allowlist, revanote HMAC-when-present, telegram global secret + no-audit-on-fail) are CONFIG (`IntakeConfig`), not new code paths. `constantTimeEqual` / `verifyHmacSig` live here once. Migrating a route: parse `result.rawBody` — never re-read `c.req.text()` (preserves the raw-body-before-parse contract).
- **Mount-order invariant:** `hub/src/index.ts` has a `MOUNT-ORDER INVARIANT CONTRACT` block (4 relations); `hub/test/mount-order.test.ts` enforces it (public webhooks mount before the `/api/*` JWT/auth catch-all; license gate after auth; CSRF allowlist skips webhook subpaths; `/ws/agent` keyed by `api_keys`, never license). Don't reorder mounts blindly.
- **CI gate:** the QC baseline (`tools/check-baseline.ts`, `bun run check-baseline`) now runs each `hub/test/*.test.ts` file in its OWN `bun test <file>` process and aggregates the junit totals (order-independent) — Bun `mock.module` is process-global + first-write-wins, so spread real exports in partial mocks (`{ ...await import(real), override }`). Baseline `tools/regression-baseline.json`: pass `771` / total `900`, `tolerance.fail_max:0`.

## API docs convention

The hub exposes OpenAPI 3.1 at `/openapi.json` and a Scalar UI at `/docs`. The spec is assembled in `hub/src/api/_openapi.ts` using `@hono/zod-openapi` `createRoute` declarations. Currently covers `/api/profile/cost-today` and `/api/profile/license` — the rest of the hub is plain Hono and gets migrated incrementally.

When migrating a route:
1. Add a `createRoute` declaration to `hub/src/api/_openapi.ts` (or a sibling `OpenAPIHono` subrouter mounted ahead of the plain twin in `hub/src/index.ts`).
2. Delete the plain-Hono twin so it doesn't double-mount.
3. Run `bun run docs:sync` from repo root; commit the updated `docs/openapi.json` and `docs/api.md`.
4. CI workflow `.github/workflows/docs-drift.yml` fails PRs that change `hub/src/**` without a matching spec update.

The dump script (`hub/scripts/dump-openapi.ts`) loads the OpenAPIHono sub-app in-process — no `Bun.serve`, no port, no DB. It needs placeholder `JWT_SECRET` + `DATABASE_URL` env vars to satisfy module-load-time validation; the npm script sets harmless values.

## PR Hygiene

Periodically check for open PRs with `gh pr list`. Review them for conflicts with current work, stale branches, or changes that have already been applied to main. Flag any that should be closed or merged.

## Deployment

Docker multi-stage build (see `Dockerfile`): installs deps → builds web → copies into production image with non-root user. Runs on Coolify at `app.remo-code.com`, port 3040.

The agent runs locally on the dev machine — it is NOT deployed to the server. The agent may host multiple CLI subprocesses per process (one Codex project session + ambient Codex + ambient Codex).

## Releases

**Supervisor (Tauri tray app):** push a `supervisor-v*.*.*` tag — `.github/workflows/release-supervisor.yml` builds the MSI on `windows-latest`, signs it with the Tauri updater key, and publishes a GitHub Release with `latest.json` for the in-app auto-updater. Local builds: `pwsh -File supervisor/tauri/scripts/build-and-update.ps1`. First-time signing-key setup: `supervisor/tauri/UPDATER-SETUP.md`.

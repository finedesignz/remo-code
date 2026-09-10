# External Integrations

**Analysis Date:** 2026-07-12

Every external system the hub or supervisor actually talks to, where it's wired, which env
vars gate it, and its live prod state. Flag defaults are read from `hub/src/config.ts`
(`parseBool` — second arg is the default).

## APIs & External Services

### PostgreSQL (Coolify-hosted) — **ON**
- Purpose: the only datastore. Users, auth sessions, sessions, messages, api_keys, scheduled tasks/runs, `token_usage`/`token_usage_daily`, `orchestrator_rows`, `routine_queue`/`routine_run_log`, `repo_groups`, `feedback_keys`, `orchestrator_autospawn_allowlist`.
- Wired: `hub/src/db/` (client + DALs), schema in `hub/src/db/schema.sql`.
- Client: `postgres ^3.4.9` (tagged templates, no ORM).
- Env: `DATABASE_URL` (Coolify internal network only; never in repo).
- Invariant: `schema.sql` re-runs **in full every hub boot** — idempotent DDL only. Backfills are one-shot scripts in `hub/scripts/`.

### Redis (Titanium) — **ON (hard-fail)**
- Purpose: magic-link `jti` single-use replay protection (`magic_link:used:{jti}` EX 900) + license blocklist.
- Wired: `hub/src/api/auth.ts` (ioredis), probed by `hub/src/api/introspect.ts`.
- Env: `TITANIUM_REDIS_URL`, `TITANIUM_REQUIRE_REDIS` (default require; set `false` only for local dev).
- No Redis = no magic-link auth, by design (replay protection is load-bearing).

### Titanium Licensing (auth + license) — **BYPASSED in prod**
- Purpose: magic-link identity + subscription/license state; JWKS-verified Ed25519 license JWTs mirrored into `users.license_status`.
- Wired: `hub/src/titanium-client.ts`, `hub/src/auth/`, `hub/src/api/auth.ts`, `hub/src/api/webhooks-titanium.ts`, `hub/src/license-gate.ts`.
- Env: `TITANIUM_KEYGEN_API_URL`, `TITANIUM_KEYGEN_ACCOUNT_ID`, `TITANIUM_KEYGEN_PRODUCT_ID`, `TITANIUM_KEYGEN_PORTAL_TOKEN`, `TITANIUM_KEYGEN_ADMIN_TOKEN`, `TITANIUM_WEBHOOK_SECRET`, `TITANIUM_LICENSE_CACHE_TTL_SECONDS`, `MAGIC_LINK_SECRET`.
- Flags: **`TITANIUM_BYPASS`** (code default `false`; **`true` in prod**) — disables JWKS warm + the license gate. **`LICENSE_REQUIRED`** (default `true`). **`ALLOW_LEGACY_LOGIN`** (default `true`).
- Prod reality: under bypass, magic-link 503s — the **legacy bcrypt email/password path is the only working prod login**. Single account.
- Docs: `docs/auth.md`.

### Anthropic Claude CLI + Codex CLI (subprocesses) — **ON**
- Purpose: the actual agent. One persistent CLI process per session on the supervisor host.
- Two distinct paths:
  - **Human / interactive (PTY):** genuine `claude`/`codex` TUI over the Rust ConPTY. `supervisor/src/runners/backend-selector.ts` → `ClaudePtyBridge` → `supervisor/tauri/src-tauri/src/pty_host.rs`. **Raw bytes, NO stream-json, NO provider API key, ever.** Argv is an allowlist-of-one (only the optional operator-blessed `--dangerously-skip-permissions`). Env scrubbed through `supervisor/src/runners/env-sanitize.ts`.
  - **Programmatic (stream-json):** `--input-format stream-json --output-format stream-json`, preserved for unattended automation only, behind the cost cap.
- Flags: **`REMO_PTY_INTERACTIVE`** (`=== "1"`, code default OFF; **ON in prod** since 2026-06-04) — hub returns it via `GET /api/client-config`; SPA renders `TerminalSurface` instead of `ChatSurface`. Supervisor reads its own copy from process env. Requires supervisor ≥ 0.9.0. **`REMO_CLAUDE_INTERACTIVE_CONFIRMED`** / config `claude_interactive_confirmed` selects the Claude backend; **`REMO_DEFAULT_HUMAN_BACKEND`** overrides. The fail-safe selector resolves only to `claude-pty` / `codex-pty` — never the legacy stream-json runner.
- Gate: `tools/cutover-deletion-gate.mjs` — ChatSurface deletion blocked pending on-device attestations (`docs/cutover-gate-june15.md`).
- No API key is ever serialized to the hub. Enforced by `supervisor/test/no-api-key-no-streamjson-pty.test.ts` + `no-apikey-fallback-guard.test.ts`.

### Claude OAuth subscription quota — **ON (supervisor-side only)**
- Purpose: 4 quota windows (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_oauth_apps`).
- Wired: `supervisor/src/usage/oauth-poll.ts` (5-min poll of `~/.claude/.credentials.json` on the dev machine) → hub in-memory snapshot `hub/src/usage/store.ts` → WS `subscription_usage` → `UsageStrip`/`UsageTab`.
- The OAuth token **never** leaves the dev machine — only parsed util% / `resets_at`. Ships with supervisor ≥ 0.7.0.

### Coolify API — **ON**
- Purpose: (a) self-heal webhook intake on failed deploys → triage run; (b) push `SENTRY_DSN` into an app's env + redeploy during error-capture setup; (c) fetch app logs for `log_check` tasks; (d) the orchestrator verify-tail redeploy.
- Wired: `hub/src/api/coolify-webhook.ts`, `hub/src/error-capture/setup/coolify-env.ts`, `hub/src/scheduler/senders/` (`log_check`), `hub/src/orchestrator/verify-tail.ts`.
- Env: `COOLIFY_TOKEN`, `COOLIFY_BASE_URL` (`coolify.titaniumlabs.us`). Verify-tail also uses `REMO_VERIFY_APP_UUID`, `REMO_VERIFY_BASE_URL`, `REMO_VERIFY_ROUTES` (default `/api/sessions,/openapi.json,/docs`) — all no-op when unset.
- `log_check` with no resolvable Coolify app finalizes **`skipped`**, not `failed` (uuid resolved from `payload.application_uuid` → session `repo_key` → `coolify_app_repo`).
- Docs: `docs/coolify-webhook-migration.md`.

### GitHub (App + Octokit) — **ON**
- Purpose: create issues from failed runs, poll PR/CI state for the orchestrator CI gate, repo-scoped jobs.
- Wired: `hub/src/auth/github-app.ts`, `hub/src/lib/github-scope.ts`, `hub/src/lib/github-repo-job.ts`, `hub/src/scheduler/post-run/github-issue.ts`, `hub/src/api/github.ts`.
- Env: `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`; CI-gate knobs `CI_GATE_POLL_MS`, `CI_GATE_TIMEOUT_MS`, `CI_GATE_NOCI_GRACE_MS`.
- Also reachable via an MCP gateway fallback: `GATEWAY_URL` / `GATEWAY_API_KEY` and `FALLBACK_GATEWAY_URL` / `FALLBACK_GATEWAY_API_KEY` (`hub/src/lib/github-scope.ts`).

### Telegram bridge — **ON (bot), transcript-tail OFF**
- Purpose: bidirectional Telegram ↔ session. Inbound webhook → session; outbound re-sourced from the host-agnostic stream-json event bus. Fail-closed permission / `user_question` keystroke injection keyed by `(sessionId, requestId)`; per-session PTY write-arbitration turn lock; human-only guard.
- Wired: `hub/src/telegram/`, `hub/src/api/telegram.ts`, `hub/src/api/telegram-webhook.ts`.
- Env: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_SUMMARIZED_STREAMING`.
- Flag: **`REMO_TELEGRAM_TRANSCRIPT_TAIL`** (`=== "1"`, default OFF; **keep OFF in Coolify**) — gates the on-disk-transcript outbound source, which cannot work in the hub container. Decoupled from `REMO_PTY_INTERACTIVE` (#247).
- Docs: `docs/telegram-bridge.md`.

### emails4agents (E4A) — **ON**
- Purpose: all outbound email — scheduled-task run summaries (default `on: always`), Revanote PR notifications, orchestrator notify fan-out.
- Wired: `hub/src/scheduler/` email summary path, `hub/src/orchestrator/notify.ts`.
- Env: `E4A_API_KEY`, `E4A_BASE_URL` (`https://api.emails4agents.com`), `E4A_INBOX_ID`.
- **Send field is `from_inbox_id`, NOT `inbox_id`** — the wrong field 422s every send (fixed #340).

### OpenAI Whisper (transcription) — **optional, ON if keyed**
- Purpose: voice-to-text for the chat composer mic.
- Wired: `hub/src/api/transcribe.ts` (`POST /api/transcribe`); config in `hub/src/config.ts` (`openaiApiKey`).
- Env: `OPENAI_API_KEY` (absent ⇒ endpoint returns a clear "not configured" error), `OPENAI_TRANSCRIBE_MODEL`.
- The **only** direct provider-API call in the codebase — and it is nowhere near the agent path.

### Revanote — **ON**
- Purpose: visual-annotation webhook → session dispatch → `<<JSON>>` callback (with retry curve).
- Wired: `hub/src/revanote/`, `hub/src/api/revanote-webhook.ts`, `revanote-annotations.ts`, `revanote-mappings.ts`.
- Env: `REVANOTE_LOCAL_REPOS_ROOT`, `REVANOTE_DEPLOY_BRANCH`, `REVANOTE_STAGING_BRANCH`, `REVANOTE_AUTOMERGE_BRANCH`, `REVANOTE_PR_NOTIFY_EMAIL`.
- Docs: `docs/revanote.md`.

### Error capture (Sentry-compatible intake) — **ON**
- Purpose: self-hosted Sentry-style intake → dispatch the error into the repo-bound session. Includes SDK auto-install for 4 stacks + pushing `SENTRY_DSN` into Coolify env.
- Wired: `hub/src/error-capture/`, `hub/src/api/sentry-intake.ts`, `errors.ts`, `error-projects.ts`, `error-runs.ts`, `error-setup.ts`.
- Env: `SENTRY_DSN` (the value the hub *emits* to target apps, not one it consumes), `REMO_SPAWN_ON_ERROR`, `REMO_SPAWN_ON_ERROR_TIMEOUT_MS`, `REMO_PUBLIC_URL`.
- Known break: `hub/src/error-capture/setup/snippet.ts` emits a Sentry-SDK snippet, but the SDK wants integer project ids while the hub uses UUIDs → `BadDsn` crash loop. Use a dependency-free reporter instead.
- Docs: `docs/error-capture.md`.

### Feedback intake (public widget) — **ON**
- Purpose: public per-app end-user feedback (`POST /api/feedback/:token`) → screenshot + comment dispatched into the bound session. Embeddable `feedback-widget.js`.
- Wired: `hub/src/feedback/`, `hub/src/api/feedback-webhook.ts`, `feedback-keys.ts`. Table `feedback_keys`.
- Bounded by per-token/per-IP rate limit + the non-bypassable cost cap. Not Revanote.
- Docs: `docs/feedback-intake.md`.

### TEAB — Titanium Edge AutoBuilder — **release-gated**
- Purpose: `task_type: 'teab'` scheduled task runs `teab run --repo <X>` on the supervisor host; hub-driven background poll-to-terminal → `finalizeRun` → post-run actions.
- Wired: hub `hub/src/scheduler/senders/teab.ts` + `hub/src/scheduler/dispatcher.ts`; supervisor `supervisor/src/commands/teab-run.ts` (allowlisted `teab_run`/`teab_status` in `supervisor/src/commands/index.ts`). Columns `teab_repo_ident`, `teab_last_status`.
- Env (hub): `REMO_TEAB_POLL_INTERVAL_MS` (default 30000), `REMO_TEAB_MAX_RUN_MS` (default 21600000 = 6h). Env (supervisor process): `TEAB_BIN`, `TEAB_CLAUDE_BIN`, `TEAB_GUARD_HOOK_PATH`.
- State: preflight fails closed; the `teab_run` capability only exists on hosts running a **new signed MSI** — so it's effectively OFF on any older install. No `bypassPermissions`, no programmatic claude flags.
- Docs: `docs/teab-tasks.md`.

### Mobile Tauri client — **PAUSED**
- Env present but dormant: `MOBILE_TAURI_ORIGINS_ENABLED`, `MOBILE_BUNDLE_ID`, `MOBILE_APPLE_TEAM_ID`, `MOBILE_ANDROID_SHA256_FINGERPRINT`; `hub/src/api/well-known.ts` serves the assetlinks/AASA files.
- Paused 2026-05-28 (`docs/phase-12-pause-state.md`). iOS never built.

## Auto-Dev Orchestrator flags (all OFF in prod)

The orchestrator is the most heavily gated subsystem. `hub/src/orchestrator/`, injects via `hub/src/orchestrator/inject.ts`, docs `docs/auto-dev-orchestrator.md`.

| Env | Default | Prod | Effect |
|---|---|---|---|
| `REMO_ORCHESTRATOR_ENABLED` | **OFF** (`'0'`) | **OFF** | Master gate. When OFF, `registerCycleRunnerIfEnabled()` is a no-op — nothing registered/enqueued/injected. Turned OFF after the 2026-07 token-burn incident. |
| `REMO_ORCHESTRATOR_AUTOSPAWN` | **OFF** | **OFF** | Build-session autospawn (milestone BSA). Carries `REMO_ORCHESTRATOR_ENABLED` — both must be ON. Also needs a non-empty `orchestrator_autospawn_allowlist` (default EMPTY). |
| `REMO_ORCHESTRATOR_LEGACY_WAVES` | OFF | OFF | Rollback path to the pre-TMAC per-micro-row wave runner. Macro path (`runMacroCycle`) is the default. |
| `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP` | 50_000_000 | active | Non-bypassable daily **token** ceiling (`dailyTokenCapGate`, `hub/src/dispatch/gates.ts`). Counts **all four buckets** — input + output + cache_creation + cache_read. Cache-read exclusion is what let a wedged tick loop burn 2.83B tokens. |
| `REMO_ORCHESTRATOR_MAX_INJECTS_PER_HOUR` | 4 | active | Per-session inject-rate ceiling (`sessionInjectRateGate`), counted from `routine_run_log`. |
| `REMO_ORCHESTRATOR_AUTOSPAWN_DAILY_LAUNCHES` | 20 | — | Per-day autospawn launch cap. |
| `REMO_ORCHESTRATOR_GLOBAL_CONCURRENCY` | 2 | — | Concurrent-cycle cap. |
| `REMO_ORCHESTRATOR_TICK_INTERVAL_MS` | 60000 | — | Due-scan enqueue interval. |
| `REMO_ORCHESTRATOR_DRAIN_INTERVAL_MS` | 1000 | — | Queue drain interval. |
| `REMO_ORCHESTRATOR_STALE_LOCK_MS` | 14_400_000 (4h) | — | Stale-lock reaper threshold (`stale-lock-reaper.ts`). |
| `REMO_ORCHESTRATOR_REAP_NOTIFY_COOLDOWN_MS` | 3_600_000 (1h) | — | Min gap between repeat reap notifies. |
| `REMO_ORCHESTRATOR_CAP_ALERT_PCT` | — | — | Cap-approach alert threshold. |
| `REMO_ORCHESTRATOR_AUTOLAUNCH` | ON | ON | Unrelated to the auto-dev engine — auto-launches the coordinator session (`hub/src/orchestrator/auto-launch.ts`). |

## Lifecycle reapers (all ON)

- **Idle teardown** — `hub/src/ws/idle-teardown.ts`. `REMO_SESSION_IDLE_GRACE_SECONDS` (default 14400 = 4h; `0` disables). Orchestrator session exempt.
- **Ghost-session reaper** — `hub/src/ws/ghost-reaper.ts`. `REMO_GHOST_GRACE_MS` (120000), `REMO_GHOST_SWEEP_INTERVAL_MS` (60000), `REMO_GHOST_REAPER_DISABLED`.
- **Stale-run reaper** — `hub/src/scheduler/run-reaper.ts`. `REMO_RUN_MAX_MS` (21600000 = 6h), `REMO_RUN_REAPER_INTERVAL_MS` (300000), `REMO_RUN_REAPER_DISABLED`.

## Data Storage

- **Database:** PostgreSQL 16, self-hosted on Coolify. `DATABASE_URL` (Coolify internal only). All queries scoped by `user_id`.
- **Cache/ephemeral:** Redis (Titanium) — magic-link jti + license blocklist only.
- **File storage:** none. Attachments are inlined into message content (text) or base64 data URIs (images), 10MB WS limit.
- **Supervisor local state:** `%LOCALAPPDATA%\remo-code-supervisor\config.json`, `session-breadcrumbs/<sessionId>.json`, `audit.jsonl`.

## Authentication & Identity

- Titanium magic-link (bypassed in prod) + opaque cookie sessions (`auth_sessions`; token = `remo_` + 32 random bytes base64url, stored as SHA-256).
- Legacy bcrypt login behind `ALLOW_LEGACY_LOGIN` — the live prod path.
- `/ws/agent` is keyed by the `api_keys` table (SHA-256 hash), **never** by user license.
- CSRF: `hub/src/csrf.ts`. Envs: `JWT_SECRET` (≥32), `SESSION_SECRET`, `HUB_ALLOWED_ORIGINS`.

## Monitoring & Observability

- `hub/src/observability/` + `hub/src/api/introspect.ts` — `/healthz`, `/healthz/deep` (probes Postgres + Redis), gated by `HUB_INTROSPECT_TOKEN`. `GIT_SHA` stamped into responses.
- Error tracking of the hub itself: none (the Sentry-style intake is a *service the hub provides*, not one it consumes).
- Logs: `console.*` → Docker/Coolify log stream.

## Webhooks & Callbacks

**Incoming (mounted BEFORE the `/api/*` auth catch-all — `hub/test/mount-order.test.ts` enforces):**
- `POST /api/telegram/webhook` — `TELEGRAM_WEBHOOK_SECRET`
- `POST /api/coolify/webhook` — deploy-failure self-heal
- `POST /api/webhooks/titanium` — `TITANIUM_WEBHOOK_SECRET` (license state)
- `POST /api/revanote/webhook` — annotation intake
- `POST /api/feedback/:token` — public end-user feedback (rate-limited)
- Sentry-compatible error-intake endpoint (`hub/src/api/sentry-intake.ts`)
- `/.well-known/*` — mobile deep-link association files

All public webhooks: **raw body captured BEFORE JSON parse**, constant-time secret compare, HMAC over `${ts}.${rawBody}`, reject >5min skew.

**Outgoing:**
- Revanote `<<JSON>>` completion callback (retry curve)
- E4A email sends
- Coolify deploy/env API calls
- GitHub issue/PR API calls

## Cross-cutting invariant

Every inbound user→session dispatch flows through the shared gate chain in `hub/src/dispatch/gates.ts` — `dailyCostCapGate` (real accumulated cost from `token_usage`, user-tz day) and, on the orchestrator inject path, `dailyTokenCapGate`. Manual/interactive chat **is** capped. Do not hand-roll per-subsystem dispatch/queue/grace — use `hub/src/dispatch/` and `hub/src/webhooks/intake.ts`.

---

*Integration audit: 2026-07-12*

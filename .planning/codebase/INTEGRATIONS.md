# External Integrations

**Analysis Date:** 2026-05-28

## APIs & External Services

### Identity / Auth — Titanium Licensing (Keygen-backed)

- **Service:** Titanium Licensing magic-link + license verification (Keygen.sh under the hood)
- **Used for:** all user auth (Phase 07 cutover); replaces bcrypt + JWT
- **Endpoints called:** `${TITANIUM_KEYGEN_API_URL}` — license `validate` + JWKS (EdDSA)
- **Client:** `hub/src/titanium-client.ts` — uses `jose` ^6.2 for JWKS verify, in-memory cache (TTL `TITANIUM_LICENSE_CACHE_TTL_SECONDS`)
- **Auth:** `TITANIUM_KEYGEN_PORTAL_TOKEN`, `TITANIUM_KEYGEN_ADMIN_TOKEN`, `TITANIUM_KEYGEN_ACCOUNT_ID`, `TITANIUM_KEYGEN_PRODUCT_ID`
- **Webhook in:** `POST /webhooks/titanium/license-changed` (HMAC over `${ts}.${rawBody}`, `TITANIUM_WEBHOOK_SECRET`, 503 if unset) — `hub/src/api/webhooks-titanium.ts`
- **Replay protection:** Redis (ioredis) stores magic-link JTIs; hard-fails boot when `TITANIUM_REQUIRE_REDIS=true` and `TITANIUM_REDIS_URL` missing
- **Bypass:** `TITANIUM_BYPASS=true` disables JWKS warm + license gate + magic-link (dev/test only — see commit `098a35c`)

### GitHub — App + Octokit + Gateway-brokered token

- **GitHub App auth (preferred):** `hub/src/auth/github-app.ts` — installation tokens via `https://api.github.com/app/installations/.../access_tokens` using `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` + `GITHUB_APP_SLUG`
- **Gateway-brokered PAT (fallback / scoped ops):** `hub/src/lib/github-repo-job.ts`, `hub/src/lib/github-scope.ts` — `GET ${GATEWAY_URL}/api/credentials/service/github` with `GATEWAY_API_KEY`; falls back to `FALLBACK_GATEWAY_URL`/`FALLBACK_GATEWAY_API_KEY`. Per global rule #21 — no `GITHUB_TOKEN` env on hub.
- **Used for:** issue creation in `scheduler/post-run/github-issue.ts` (Phase 06 Coolify webhook → triage); revanote PR notify (`revanote/notify-pr.ts`), merge gate (`revanote/merge-gate.ts`), CI gate (`revanote/ci-gate.ts`)
- **Client:** `@octokit/rest` ^22

### Coolify

- **Used for:**
  - Hub itself is deployed on Coolify (`coolify.titaniumlabs.us`)
  - Webhook IN: `POST /api/coolify/webhook/:user_id/:token` (URL-path token, constant-time) + legacy HMAC route (deprecated 30d grace) — `hub/src/api/coolify-webhook.ts`
  - Webhook → triage run → optional `github_issue` post-run action
  - Error-capture SDK auto-install: PATCH Coolify env var `SENTRY_DSN`, optional redeploy — `hub/src/error-capture/setup/coolify-env.ts`
  - Scheduler `log_check` task type pulls deploy logs
  - Revanote deploy policy (`revanote/deploy-policy.ts`) drives staging/prod branch promotion
- **Auth:** `COOLIFY_TOKEN` + `COOLIFY_BASE_URL`
- **App UUID:** Per-project (stored on `error_projects.coolify_app_uuid`)

### Anthropic (revanote LLM escalator only)

- **Direct API calls:** `hub/src/revanote/llm-escalator.ts` — `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_BASE_URL`
- **Cache TTL:** `LLM_ESCALATOR_CACHE_TTL_MS`
- **Note:** Claude Code CLI subprocess (the main "AI" path) does NOT use this — supervisor spawns `claude` locally and that CLI handles its own OAuth via `~/.claude/.credentials.json` on the dev machine. No Anthropic key on hub for chat.

### Codex CLI (OpenAI)

- **Spawned by supervisor** (`supervisor/src/runners/`) — `codex app-server` over child-process stdio JSON-RPC (newline-delimited + LSP `Content-Length:` framing fallback)
- **Auth:** Codex CLI handles its own auth locally on dev machine
- **Translated to:** common `RunnerEvent` union so the web UI renders Claude + Codex identically

### OpenAI (transcription)

- **Endpoint:** `POST /api/transcribe` — `hub/src/api/transcribe.ts`
- **Used for:** voice-message transcription in web UI
- **Auth:** `OPENAI_API_KEY`; model from `OPENAI_TRANSCRIBE_MODEL`

### Telegram

- **Bot:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`
- **Outbound:** `https://api.telegram.org` — `hub/src/telegram/client.ts` (MarkdownV2 escape + chunk splitter, see PR #120)
- **Inbound webhook:** `POST /api/telegram/webhook` (`hub/src/api/telegram-webhook.ts`) — `TELEGRAM_WEBHOOK_SECRET` validates `X-Telegram-Bot-Api-Secret-Token` header
- **Used for:** Phase 12 telegram chat bridge (PR #114), `/list` inline-keyboard session picker (#127), `/doctor` + auto-heal on `agent_offline` (#134)
- **Bridge logic:** `hub/src/telegram/bridge.ts`

### emails4agents (E4A)

- **Used for:** all email — silent-skip notifications (`error-capture/notify.ts`), post-run `notify_email` action (`scheduler/post-run/email.ts`), revanote PR notify (`revanote/notify-pr.ts`)
- **Helper:** `hub/src/lib/email.ts`
- **Auth:** `E4A_API_KEY`, `E4A_BASE_URL` (`https://api.emails4agents.com`), `E4A_INBOX_ID`
- **Header:** `X-API-Key`
- **Endpoint:** `POST /v1/messages/send`
- **Note:** AWS SES / SendGrid / Resend NEVER used (global rule #7)

### Gateway pair (Ottolax + Claude Gateway)

- **Primary:** Ottolax `${GATEWAY_URL}` with `GATEWAY_API_KEY` (`olx_…`)
- **Fallback:** Claude Gateway `${FALLBACK_GATEWAY_URL}` with `FALLBACK_GATEWAY_API_KEY` (`cgw_…`)
- **Used for:** GitHub creds brokerage (only path that consumes the gateway pair currently)
- **Files:** `hub/src/lib/github-repo-job.ts`, `hub/src/lib/github-scope.ts`

### KIE.ai

- **Not used** in this repo. (Global rule #6 reserves it for image/video generation; remo-code does not generate media.)

### ngrok

- **Not used** in this repo. (Hub runs at `app.remo-code.com` behind Coolify TLS; no tunnel needed. ngrok is only for the `openclaw-hooks` service per global port map.)

## Data Storage

**Databases:**
- **Postgres** (Coolify-hosted) — `DATABASE_URL`; client `postgres` ^3.4 — `hub/src/db/`
- **Redis** (optional) — `TITANIUM_REDIS_URL`, `ioredis` ^5.10 — JTI replay-protect only

**File Storage:**
- Local filesystem only. Attachments are inline in messages (text embedded, images as base64 data URIs over WS, 10MB limit).
- Supervisor logs: `%LOCALAPPDATA%\remo-code-supervisor\supervisor.log` (5MB rotate → `.log.1`).

**Caching:**
- In-memory only (Titanium license cache, JWKS cache, LLM escalator cache, gateway creds).
- No Redis cache — Redis is JTI-only.

## Authentication & Identity

**Users (web/api):** Titanium Licensing magic-link → opaque cookie session (`hub/src/session.ts`); double-submit CSRF (`hub/src/csrf.ts`); license-status gate (`hub/src/license-gate.ts`). Legacy bearer JWT only when `ALLOW_LEGACY_LOGIN=true`. Phase 07.5 deletes legacy.

**Supervisors:** SHA-256-hashed API key in `api_keys` table; authed at WS `auth` frame on `/ws/agent`. NOT license-gated (rule: agent traffic keyed by `api_keys`, not user license).

**Web clients:** JWT (legacy) OR session cookie at WS `/ws/client` auth frame; 5s auth timeout.

## Monitoring & Observability

**Error tracking (incoming, third-party apps → hub):**
- Sentry-style intake at `POST /api/sentry/:project_id/envelope/` — `hub/src/api/sentry-intake.ts`
- `X-Sentry-Auth` header with `sentry_key` IS the credential (mounted outside JWT catch-all)
- Fingerprint → dedupe → rate-limit → daily-cap → dispatch as `user_message` to bound Claude session

**Hub's own errors:** stdout/stderr only — no external APM. `SENTRY_DSN` env consumed by `error-capture/notify.ts` only for diagnostic logging.

**Logs:** Coolify container logs (hub); rotating file log (supervisor).

## CI/CD & Deployment

**Hosting:**
- Hub → Coolify (`coolify.titaniumlabs.us`)
- Supervisor → end-user Windows machines via GH Release MSI
- Web → served as static assets from hub

**CI:**
- GitHub Actions (`docs-drift`, `release-supervisor`, `mobile-shell-typecheck`)
- Coolify Git auto-deploys hub on `main` push

## Environment Configuration

**Required at hub boot (fatal if missing):** `DATABASE_URL`, `JWT_SECRET`, `MAGIC_LINK_SECRET`, `SESSION_SECRET`, all `TITANIUM_KEYGEN_*` unless `TITANIUM_BYPASS=true`.

**Secrets location:** Coolify env (hub prod); `.env` files (dev); `~/.claude/secrets/services.json` (gateway tokens, external service creds per global rule).

## Webhooks & Callbacks

**Incoming:**
| Path | Auth | Purpose |
|------|------|---------|
| `POST /api/coolify/webhook/:user_id/:token` | URL-path token (constant-time) | Coolify deploy events → triage |
| `POST /api/coolify/webhook/:user_id` | HMAC `X-Coolify-Signature` (deprecated 30d) | Legacy route |
| `POST /webhooks/titanium/license-changed` | HMAC `${ts}.${rawBody}`, `TITANIUM_WEBHOOK_SECRET` | License state sync |
| `POST /api/telegram/webhook` | `X-Telegram-Bot-Api-Secret-Token` | Telegram updates |
| `POST /api/sentry/:project_id/envelope/` | `X-Sentry-Auth` `sentry_key` | Sentry-style error envelopes |
| `POST /api/revanote/webhook` | (see `revanote-webhook.ts`) | Revanote ingress |

**Outgoing:** GitHub App API, Coolify API, Telegram Bot API, emails4agents, Anthropic (revanote only), OpenAI (transcribe only), Titanium Keygen API, Ottolax/Claude-Gateway pair.

---

*Integration audit: 2026-05-28*

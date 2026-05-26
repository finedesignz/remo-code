# External Integrations

> **Note (Phase 09, 2026-05-26):** The agent/ workspace and channel/ plugin are retired. The local CLI runner now lives in supervisor/src/ and ships exclusively as a Tauri MSI desktop app. The hub /ws/agent route is unchanged. References below to agent/, npx remo-code-agent, claude-remote, or /ws/channel are historical. See .planning/phases/09-retire-npm-packages/.


**Analysis Date:** 2026-05-22

## APIs & External Services

**AI / Subprocess:**
- Claude Code CLI — spawned as a long-lived child process by the local agent (`agent/src/index.ts`, `agent/src/claude-runner.ts`)
  - Invocation: `claude --input-format stream-json --output-format stream-json --verbose`
  - Pre-flight check: `spawnSync('claude', ['--version'])` at `agent/src/index.ts:12`
  - Communication: JSON-per-line over stdin/stdout; one persistent process per agent session
  - Install required: https://claude.ai/code (no SDK — direct CLI integration)

**No third-party SaaS SDKs detected** (post-Supabase migration). Recent commits:
- `2117dae chore: remove @supabase/* from web, update env examples`
- `3450ad7 feat: replace supabase auth UI with custom JWT login form`

## Data Storage

**Databases:**
- PostgreSQL (self-hosted)
  - Connection: `DATABASE_URL` env var (`hub/src/config.ts`)
  - Client: `postgres` ^3.4.9 (`hub/src/db/postgres.ts`)
  - Schema: `hub/src/db/schema.sql` — tables: `users`, `sessions`, `messages`, `api_keys`
  - Data access layer: `hub/src/db/dal.ts` (all queries scoped by `user_id`)
  - Default for local dev: `postgresql://postgres:postgres@localhost:5432/remocode`

**File Storage:**
- Local filesystem only. Web SPA static assets served from `web/dist` by Bun (`hub/src/index.ts:82-156`)
- File attachments: text files embedded inline in message content; images as base64 data URIs (10 MB WS payload limit)

**Caching:**
- None — in-memory only (`wsConnectionsPerIp` Map, WS registry)

## Authentication & Identity

**User Auth:**
- Custom JWT — `jsonwebtoken` ^9.0.3
  - Issuer: `hub/src/auth/jwt.ts`
  - Middleware: `hub/src/auth/middleware.ts` (gates `/api/*`)
  - Secret: `JWT_SECRET` env (min 32 chars per CLAUDE.md)
  - Passwords: bcrypt (`hub/src/auth/password.ts`) stored on `users` table
  - Login UI: custom form (replaced Supabase Auth UI in commit `3450ad7`)

**Agent Auth:**
- API key — `hub/src/auth/api-key-middleware.ts`
  - Format: `remo_` prefix + 32 random bytes base64url
  - Stored as SHA-256 hash in `api_keys` table
  - Used by agent over `/ws/agent` and by plugin REST routes (`/api/plugin/*`)
  - Token utility: `hub/src/utils/token.ts`

## Monitoring & Observability

**Error Tracking:**
- None — global error handler logs to console only (`hub/src/index.ts:29-32`)

**Logs:**
- stdout/stderr via `console.log` / `console.error`
- Agent forwards log messages to hub as `agent_log` WS frames, persisted/relayed per session

## CI/CD & Deployment

**Hosting:**
- Coolify at `app.remo-code.com`, port 3040 (see global CLAUDE.md and project CLAUDE.md)
- npm: agent published as `remo-code-agent` (v0.3.6) via trusted publishing

**CI Pipeline:**
- Not detected in repo (no `.github/workflows` inspected here)

**Container:**
- `Dockerfile` — multi-stage Bun build, runs as non-root `appuser`, `CMD ["bun", "hub/src/index.ts"]`

## Environment Configuration

**Required env vars (hub):**
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — min 32 chars, required for JWT sign/verify
- `PORT` — defaults to 3040
- `HUB_ALLOWED_ORIGINS` — comma-separated list, defaults to `http://localhost:5173`; used for CORS and `/ws/client` origin check

**Required env vars (web, build-time):**
- `VITE_HUB_URL` — baked into bundle via Vite

**Required env vars (agent):**
- `REMO_HUB_URL` (optional, defaults to production hub)
- `REMO_API_KEY`
- Or CLI args: `--hub-url`, `--api-key`, `--local-output`
- Or config file: `~/.config/remo-code/config.json`

**Secrets location:**
- `.env` files (not committed); Coolify env vars in production. No `.env*` present at inspection time.

## Webhooks & Callbacks

**Incoming:**
- None — communication is WebSocket-based

**Outgoing:**
- None

## WebSocket Endpoints

All on hub at port 3040, upgraded by `Bun.serve` in `hub/src/index.ts:103-136`.

| Path | Purpose | Auth | Handler |
|------|---------|------|---------|
| `/ws/agent` | Local agent connection (streams Claude CLI activity) | API key (`{type:"auth", api_key, project_dir, hostname}`) | `hub/src/ws/agent.ts` |
| `/ws/client` | Browser SPA chat connection | JWT (`{type:"auth", token}`) + Origin allowlist | `hub/src/ws/client.ts` |
| `/ws/channel` | Legacy Claude Code channel plugin | API key | `hub/src/ws/channel.ts` |

**Common protocol traits:**
- Zod-validated frames (`hub/src/ws/protocol.ts`, `hub/src/ws/agent-protocol.ts`)
- 5s auth timeout
- 30s heartbeat ping/pong
- Per-IP connection limit: 100 (`MAX_WS_CONNECTIONS_PER_IP` in `hub/src/index.ts:88`)
- Max payload: 10 MB (image attachments)
- Per-connection message rate limits (`hub/src/middleware/rate-limit.ts`)

**Agent → Hub events:** `thinking`, `text_delta`, `tool_use`, `tool_result`, `status`, `assistant_message`, `agent_log`
**Hub → Agent events:** `auth_ok`, `user_message` (with `images`/`attachments`), `cancel`, `ping`, `permission_response`, `question_response`
**Hub → Client events:** `message`, `session_status`, `session_list`, plus activity passthrough

## REST API Surface

Mounted in `hub/src/index.ts`:
- `/api/auth/*` — login/signup (no auth)
- `/api/setup/*` — first-user provisioning (gated by user count)
- `/api/plugin/*` — API-key auth, rate-limited 30/min
- `/api/sessions/*`, `/api/api-keys/*`, `/api/messages/*`, `/api/profile/*` — JWT-auth, rate-limited 120/min/user
- `/health` — liveness probe

---

*Integration audit: 2026-05-22*

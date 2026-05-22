# Codebase Structure

**Analysis Date:** 2026-05-22

## Directory Layout

```
remo-code/
├── hub/                       # Bun + Hono HTTP/WS server (port 3040)
│   └── src/
│       ├── index.ts           # Entry: Bun.serve, Hono mount, WS upgrade routing, static SPA
│       ├── config.ts          # Env loader (DATABASE_URL, JWT_SECRET, PORT, allowed origins)
│       ├── api/               # REST route modules (Hono routers)
│       │   ├── auth.ts        # /api/auth — login, logout, register-if-allowed
│       │   ├── setup.ts       # /api/setup — first-run admin bootstrap
│       │   ├── sessions.ts    # /api/sessions — list/get/delete sessions
│       │   ├── messages.ts    # /api/messages — message history per session
│       │   ├── api-keys.ts    # /api/api-keys — issue/revoke agent keys
│       │   ├── profile.ts     # /api/profile — current user
│       │   └── plugin.ts      # /api/plugin/* — legacy channel-plugin REST
│       ├── auth/
│       │   ├── jwt.ts         # sign/verify HS256 JWT
│       │   ├── middleware.ts  # JWT bearer middleware, attaches userId to context
│       │   ├── api-key-middleware.ts  # SHA-256 hash compare for /api/plugin
│       │   └── password.ts    # bcrypt hash/verify
│       ├── middleware/
│       │   └── rate-limit.ts  # Token-bucket / sliding-window per key
│       ├── utils/
│       │   └── token.ts       # generateToken(prefix) — base64url 32-byte random
│       ├── db/
│       │   ├── schema.sql     # Run-once init for fresh Postgres DB
│       │   ├── postgres.ts    # pg Pool from DATABASE_URL
│       │   └── dal.ts         # All SQL queries (user_id-scoped)
│       └── ws/
│           ├── protocol.ts        # Zod schemas for /ws/client
│           ├── agent-protocol.ts  # Zod schemas for /ws/agent
│           ├── client.ts          # Browser WS handler (JWT auth, subscribe, send_message)
│           ├── agent.ts           # Local-agent WS handler (API key auth, relay activity)
│           ├── channel.ts         # Legacy plugin WS handler + hashToken util
│           └── registry.ts        # In-memory channel + client registries, broadcast helpers
│
├── agent/                     # Local streaming agent (runs on dev machine)
│   └── src/
│       ├── index.ts           # Entry: pre-flight, wire hub<->runner, SIGINT handling
│       ├── config.ts          # CLI args > env > ~/.config/remo-code/config.json
│       ├── types.ts           # CliEvent + HubToAgent message types
│       ├── hub-client.ts      # WS client to hub, auth payload, reconnect
│       ├── claude-runner.ts   # Persistent Claude CLI subprocess, stream-json parser
│       └── local-ui.ts        # ANSI banner + activity printing for --local-output
│
├── web/                       # React 19 + Vite + Tailwind 4 SPA
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── main.tsx           # React root mount
│       ├── App.tsx            # Top-level routes/layout, auth gate
│       ├── index.css          # Tailwind + CSS custom-property theme tokens
│       ├── lib/
│       │   └── auth.ts        # Fetch wrapper, token storage
│       ├── hooks/
│       │   ├── useAuth.ts     # Login state, JWT in localStorage
│       │   ├── useWebSocket.ts# /ws/client connection, reconnect
│       │   ├── useChat.ts     # Send message, hold streaming buffer
│       │   ├── useActivity.ts # Aggregate thinking/tool_use/tool_result events
│       │   ├── useSessions.ts # Session list + status
│       │   ├── useApiKey.ts   # Agent key issuance
│       │   ├── useProfile.ts  # Current user fetch
│       │   └── useTheme.ts    # Light/dark toggle
│       └── components/
│           ├── Layout.tsx, Sidebar.tsx, SessionDropdown.tsx, SessionTooltip.tsx
│           ├── AuthForm.tsx, SetupForm.tsx, SettingsPage.tsx
│           ├── ChatPanel.tsx, MessageBubble.tsx, ActivityFeed.tsx
│           ├── ThinkingBlock.tsx, ToolUseBlock.tsx
│           ├── PermissionBlock.tsx, QuestionBlock.tsx
│           ├── FileAttachmentBar.tsx, UnreadBadge.tsx
│           ├── ApiKeyModal.tsx, ConnectModal.tsx
│           └── …
│
├── docs/                      # Long-form docs (incl. superpowers/plans/*)
├── supabase/                  # Legacy Supabase artifacts (migration to Postgres complete)
├── Dockerfile                 # Multi-stage: install → build web → production runtime
├── package.json               # Bun workspaces (hub, web, agent)
├── bun.lock
├── CLAUDE.md                  # Project guidance for Claude Code
└── README.md
```

## Directory Purposes

**`hub/src/`**
- Purpose: Server-side everything — HTTP, WS, auth, DB, broadcast.
- Contains: Hono app, WS handlers, DAL, Zod schemas.
- Key files: `index.ts`, `ws/registry.ts`, `db/dal.ts`, `db/schema.sql`.

**`hub/src/api/`**
- Purpose: REST routers, one Hono `Hono()` instance per concern.
- Pattern: Each file exports a router mounted under `/api/<name>` from `index.ts`.
- Auth: `/api/auth` and `/api/setup` are unauthenticated; `/api/plugin/*` uses API key; everything else uses JWT.

**`hub/src/ws/`**
- Purpose: WebSocket protocol definitions and handlers, one per endpoint.
- Pattern: `create{X}WsData()` + `handle{X}Open/Message/Close` exported per endpoint, wired from `index.ts`.
- Validation: All inbound messages parsed with Zod from `protocol.ts` / `agent-protocol.ts`.

**`hub/src/db/`**
- Purpose: PostgreSQL only.
- Pattern: `dal.ts` is the only place SQL is written; everything else imports named functions. All queries take `userId` and include explicit `WHERE user_id = $1`.

**`agent/src/`**
- Purpose: Runs on the developer's machine — never deployed to the server.
- Pattern: Three singletons (config, hub client, runner) created at module load.
- Key files: `claude-runner.ts` (subprocess + stream-json parser, the hardest file in the repo), `index.ts` (wiring), `hub-client.ts` (WS).

**`web/src/hooks/`**
- Purpose: One hook per concern. Hooks own all network/WS interaction.
- Pattern: Components never call fetch / WS directly — they consume hooks.

**`web/src/components/`**
- Purpose: Presentational + small container components.
- Pattern: Flat structure (no nested feature folders). Each block of the chat surface has its own component (`ThinkingBlock`, `ToolUseBlock`, `PermissionBlock`, `QuestionBlock`).

**`supabase/`**
- Purpose: Legacy from pre-Postgres migration. Schema authoritative file is now `hub/src/db/schema.sql`.

**`docs/superpowers/plans/`**
- Purpose: Long-form planning docs (e.g. `2026-04-27-migrate-supabase-to-postgres.md`).
- Not consumed at runtime.

## Key File Locations

**Entry Points:**
- `hub/src/index.ts` — hub HTTP + WS server.
- `agent/src/index.ts` — local agent CLI.
- `web/src/main.tsx` → `web/src/App.tsx` — browser app.

**Configuration:**
- `hub/src/config.ts` — server env vars (`DATABASE_URL`, `JWT_SECRET`, `PORT`, `HUB_ALLOWED_ORIGINS`).
- `agent/src/config.ts` — agent CLI args / env / `~/.config/remo-code/config.json`.
- `web/.env` — `VITE_HUB_URL`.
- `Dockerfile` — production image (non-root user, multi-stage).
- `package.json` (root) — Bun workspaces + top-level scripts (`dev:hub`, `dev:web`, `build:web`).

**Core Logic:**
- `hub/src/ws/registry.ts` — the only place live socket state lives.
- `hub/src/ws/agent.ts` — agent auth + activity relay.
- `hub/src/ws/client.ts` — browser auth + message routing.
- `hub/src/db/dal.ts` — every SQL statement.
- `agent/src/claude-runner.ts` — Claude CLI subprocess lifecycle and stream-json parser.

**Database:**
- `hub/src/db/schema.sql` — authoritative schema (run once).
- `hub/src/db/postgres.ts` — `pg` Pool.

**Auth:**
- `hub/src/auth/jwt.ts`, `hub/src/auth/middleware.ts` — user JWT.
- `hub/src/auth/api-key-middleware.ts` — agent API key.
- `hub/src/auth/password.ts` — bcrypt.
- `hub/src/utils/token.ts` — token generation; `hashToken` lives in `hub/src/ws/channel.ts` and is reused.

**Testing:**
- None in tree. Smoke testing is manual.

## Naming Conventions

**Files:**
- TS source: `kebab-case.ts` (e.g. `api-key-middleware.ts`, `claude-runner.ts`).
- React components: `PascalCase.tsx` (e.g. `ChatPanel.tsx`).
- React hooks: `useCamelCase.ts` (e.g. `useWebSocket.ts`).
- SQL: lowercase (`schema.sql`).

**Directories:**
- Lowercase single word (`hub`, `web`, `agent`, `api`, `ws`, `db`, `auth`).

**Identifiers:**
- Functions/vars: camelCase.
- Types/interfaces: PascalCase (`AgentWsData`, `ClientEntry`, `RunnerEvent`).
- Zod schemas: PascalCase, often namespaced (`AgentInbound`, `ClientInbound`).
- DB columns: `snake_case` (`user_id`, `project_dir`, `key_hash`).

## Where to Add New Code

**New REST endpoint:**
- File: new `hub/src/api/<name>.ts` exporting a `Hono()` router.
- Mount: `app.route('/api/<name>', <name>)` in `hub/src/index.ts` after the JWT `authMiddleware` block (or before, if unauthenticated).
- Validation: Zod schema inline at the route boundary.

**New WS message type:**
- Schema: extend the discriminated union in `hub/src/ws/protocol.ts` (client) or `hub/src/ws/agent-protocol.ts` (agent).
- Handler: add a branch in `hub/src/ws/client.ts` or `hub/src/ws/agent.ts`.
- Broadcast: use `broadcastToSubscribers` / `broadcastToUser` from `hub/src/ws/registry.ts` — never iterate `clients` directly.
- Agent side: update `agent/src/types.ts` (HubToAgent / agent outbound) and wire through `agent/src/index.ts`.

**New DB query:**
- File: `hub/src/db/dal.ts` — add a named exported async function.
- Rule: every query that touches `sessions`, `messages`, or `api_keys` must include `WHERE user_id = $1` (or join through such a row). Pass `userId` as the first parameter.

**New schema change:**
- Edit `hub/src/db/schema.sql` and create a migration script (no formal migration tool — manual `psql -f`). Document in `docs/superpowers/plans/`.

**New React component:**
- File: `web/src/components/<Name>.tsx`. Keep components flat — no nested feature folders.
- Networking: do not call fetch / WS directly. Create or extend a hook in `web/src/hooks/`.
- Styling: Tailwind 4 classes; theme colors via CSS variables (`var(--bg-primary)` etc.), not hex literals.

**New hook:**
- File: `web/src/hooks/use<Name>.ts`.
- Pattern: hook owns its own subscription/cleanup and returns a small typed surface.

**New Claude CLI event handling:**
- File: `agent/src/claude-runner.ts` — extend `RunnerEvent` union and the `handleEvent` switch.
- Wire-up: emit via `this.listener?.(...)`. `agent/src/index.ts:handleRunnerEvent` will relay to the hub. Add a matching schema entry in `hub/src/ws/agent-protocol.ts` and broadcast in `hub/src/ws/agent.ts`.

**New environment variable:**
- Server: add to `hub/src/config.ts`, document in root `CLAUDE.md` and `Dockerfile`.
- Agent: add to `agent/src/config.ts` (CLI flag, env var, config-file key — all three).
- Web: prefix with `VITE_` and add to `web/.env`.

**Tests:**
- No test harness currently. Manual smoke from `bun run dev:hub` + `bun run dev:web` + `claude-remote --hub-url http://localhost:3040 ...`.

## Special Directories

**`node_modules/`**
- Purpose: Bun workspace dependencies.
- Generated: Yes (`bun install`).
- Committed: No.

**`web/dist/`**
- Purpose: Production SPA bundle, served by hub static handler (`hub/src/index.ts:83`).
- Generated: Yes (`bun run build:web`).
- Committed: No.

**`supabase/`**
- Purpose: Legacy artifacts from prior Supabase backend.
- Generated: No.
- Committed: Yes (kept for history; not used at runtime).

**`docs/superpowers/plans/`**
- Purpose: Long-form planning documents.
- Generated: No.
- Committed: Yes.

**`.planning/codebase/`**
- Purpose: GSD codebase map (this document and siblings).
- Generated: Yes (by `/gsd-map-codebase`).
- Committed: Project-dependent.

---

*Structure analysis: 2026-05-22*

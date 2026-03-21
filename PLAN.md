# Remo Code — Implementation Plan

## Context

You have 25+ Claude Code sessions running across different projects. You want a single web app to chat with any of them remotely from your phone or any browser. Eventually this becomes a SaaS product, so we build multi-tenant architecture now but only implement what you need as a single user.

## Architecture

```
Browser (React SPA)
    ↕ WebSocket /ws/client  +  REST /api/*
Hub Server (Bun + Hono on Coolify, port 3040)
    ↕ WebSocket /ws/channel (outbound from each channel server)
Channel Server 1 ... Channel Server N  (local MCP plugin per session)
    ↕ stdio (MCP)
Claude Code 1  ... Claude Code N
```

## Project: `C:\Users\artic\GitHub\remo-code.com\`

```
remo-code.com/
  package.json              # workspace root
  Dockerfile
  .env.example

  hub/                      # Hub Server (Bun + Hono)
    package.json
    src/
      index.ts              # entry: Hono app on port 3040
      config.ts             # env vars
      db/
        schema.ts           # Drizzle schema
        index.ts            # bun:sqlite + drizzle
      auth/
        password.ts         # bcrypt hash/verify
        middleware.ts       # session cookie validation
        routes.ts           # register, login, logout
      ws/
        channel.ts          # /ws/channel — channel servers connect here
        client.ts           # /ws/client — browsers connect here
        protocol.ts         # shared message types
        registry.ts         # in-memory Map<sessionId, WebSocket>
      api/
        sessions.ts         # CRUD + token generation
        messages.ts         # paginated history

  channel/                  # Channel Plugin (MCP server)
    package.json
    .claude-plugin/
      plugin.json
    server.ts               # MCP server + WS client to hub
    skills/
      configure/
        SKILL.md            # /hub:configure <token>

  web/                      # React SPA
    package.json
    vite.config.ts
    index.html
    src/
      main.tsx
      App.tsx
      hooks/
        useWebSocket.ts
        useAuth.ts
        useSessions.ts
        useChat.ts
      components/
        Layout.tsx          # sidebar + chat panel
        Sidebar.tsx         # session list, online/offline
        ChatPanel.tsx       # messages + input
        MessageBubble.tsx
        LoginForm.tsx
```

## Database Schema (SQLite + Drizzle)

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  project_dir TEXT,
  status TEXT NOT NULL DEFAULT 'offline',
  registration_token_hash TEXT NOT NULL,
  last_activity INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,        -- 'user' | 'assistant'
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_messages_session ON messages(session_id, created_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
```

## WebSocket Protocol

### Channel <-> Hub (`/ws/channel`)

```jsonc
// Channel -> Hub: first message
{ "type": "auth", "session_id": "my-project", "token": "<raw_token>" }

// Hub -> Channel: auth result
{ "type": "auth_ok" }
{ "type": "auth_error", "error": "invalid token" }

// Hub -> Channel: user sent a message from web UI
{ "type": "user_message", "id": "<msg_id>", "content": "...", "ts": "..." }

// Channel -> Hub: Claude replied via the reply tool
{ "type": "assistant_message", "id": "<msg_id>", "content": "...", "ts": "..." }

// Channel -> Hub: status
{ "type": "status", "status": "thinking" | "idle" }

// Heartbeat (both)
{ "type": "ping" } / { "type": "pong" }
```

### Client <-> Hub (`/ws/client`)

```jsonc
// Client -> Hub: send message to a session
{ "type": "send_message", "session_id": "...", "content": "...", "id": "<uuid>" }

// Client -> Hub: subscribe to session updates
{ "type": "subscribe", "session_ids": ["..."] }

// Hub -> Client: new/updated message
{ "type": "message", "session_id": "...", "message": { "id", "role", "content", "created_at" } }

// Hub -> Client: session status change
{ "type": "session_status", "session_id": "...", "status": "online"|"offline"|"thinking" }

// Hub -> Client: full session list
{ "type": "session_list", "sessions": [...] }
```

## Channel Server (`channel/server.ts`)

Follows the exact Telegram plugin pattern:
- MCP Server with `experimental: { 'claude/channel': {} }` + `tools: {}`
- Connects to hub via WebSocket (outbound, `wss://`)
- On `user_message` from hub -> `mcp.notification()` to push into Claude
- Exposes `reply` tool -> sends `assistant_message` back to hub via WS
- Reads config from `~/.claude/channels/hub/.env` (HUB_URL, TOKEN, SESSION_ID)
- Auto-reconnects on disconnect (5s backoff)
- Session ID defaults to `process.cwd()` basename

Reference: Telegram plugin at `~/.claude/plugins/cache/claude-plugins-official/telegram/0.0.1/server.ts`

## Auth (build now)

- Password only for v1 (passkeys added later for SaaS)
- bcrypt hash, session cookie (httpOnly, secure, sameSite=lax, 30-day)
- Registration creates first user account
- Session tokens for channel servers: generated on session create, stored hashed

## SaaS-Ready Architecture (don't build yet)

These are baked into the data model but not exposed in UI:
- Multi-tenant: all tables have `user_id`, queries always filter by it
- Session isolation enforced at hub level
- Auth sessions table supports multiple devices
- Schema supports WebAuthn credentials table (add later)
- Future: billing, team accounts, public signup, admin panel, usage limits

## Deployment

- **Port**: 3040 (safe range)
- **Domain**: `remo-code.com` (Cloudflare DNS)
- **Coolify**: Dockerfile-based deploy, volume `/data` for SQLite
- **Env vars**: `HUB_SECRET`, `DATABASE_PATH=/data/hub.db`, `WEBAUTHN_RP_ID` (later)

## Build Order

1. **Hub server core** -- DB schema, password auth, REST API for sessions + messages, both WS endpoints, session registry
2. **Channel plugin** -- MCP server + WS client, reply tool, plugin packaging, /hub:configure skill
3. **Web UI** -- Login, session sidebar, chat panel, real-time messages
4. **Deploy** -- Dockerfile, Coolify deploy, Cloudflare DNS

## Verification

1. Start hub locally on port 3040
2. Create account via `POST /api/auth/register`
3. Create a session via `POST /api/sessions` -> get token
4. Start Claude Code with channel: `claude --dangerously-load-development-channels server:hub`
5. Open web UI, select session, send message -> appears in Claude Code terminal
6. Claude replies via `reply` tool -> appears in web UI
7. Deploy to Coolify, repeat from browser/phone

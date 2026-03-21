# Remo Code

Remote access to your Claude Code sessions from any browser or phone.

Remo Code connects your local Claude Code terminals to a central hub server, giving you a real-time chat interface to interact with any session from anywhere. It uses the [Claude Code channels](https://code.claude.com/docs/en/channels) system — the same contract as the official Telegram, Discord, and fakechat plugins.

## Architecture

```
Browser (React SPA)
    ↕ WebSocket + REST API
Hub Server (Bun + Hono)
    ↕ WebSocket
Channel Plugin (MCP server per session)
    ↕ stdio
Claude Code
```

- **Hub** — Central server that relays messages between web clients and Claude Code sessions. Handles auth via Supabase, message storage, and real-time delivery.
- **Web** — React chat UI with session management, online/offline status, and markdown rendering.
- **Channel** — [Claude Code channel plugin](https://code.claude.com/docs/en/channels-reference) (MCP server) that bridges each Claude Code session to the hub.

## Prerequisites

- [Bun](https://bun.sh) runtime
- A [Supabase](https://supabase.com/) project (for auth and database)
- [Claude Code](https://claude.ai/code) v2.1.80+ (channels require this version)

## Setup

### 1. Install dependencies

```bash
bun install
```

### 2. Configure Supabase

Create a Supabase project and run the migration in `supabase/migrations/001_initial.sql` via the SQL Editor.

### 3. Set environment variables

```bash
# Hub config
cp .env.example hub/.env
# Edit: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, HUB_ALLOWED_ORIGINS

# Web config
cp .env.example web/.env
# Edit: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_HUB_URL
```

### 4. Start the servers

```bash
# Terminal 1 — Hub server (port 3040)
bun run dev:hub

# Terminal 2 — Web dev server (port 5173)
bun run dev:web
```

### 5. Create your account

Open `http://localhost:5173`. On first visit you'll see the setup form — create your admin account.

### 6. Connect a Claude Code session

Create a session in the web UI and follow the connect instructions:

```bash
# In Claude Code — install the channel plugin
/plugin install remo-code@claude-plugins-official

# Configure the connection
/remo-code:configure http://localhost:3040 remo_YOUR_TOKEN

# Restart with channels enabled (development mode until approved)
claude --dangerously-load-development-channels plugin:remo-code@claude-plugins-official
```

Or configure manually by saving to `~/.claude/channels/remo-code/.env`:
```
HUB_URL=http://localhost:3040
HUB_TOKEN=remo_YOUR_TOKEN
SESSION_ID=your-session-name
```

Once connected, messages sent in the web UI appear in your Claude Code terminal as `<channel source="hub">` events, and Claude's replies show up in the browser via the `reply` tool.

## How It Works

The channel plugin follows the [Claude Code channels contract](https://code.claude.com/docs/en/channels-reference):

1. Claude Code spawns the channel as an MCP subprocess (stdio transport)
2. The channel connects outbound to the hub via WebSocket and authenticates with a hashed token
3. When a user sends a message in the web UI, the hub forwards it to the channel
4. The channel emits a `notifications/claude/channel` event into the Claude Code session
5. Claude reads the message and calls the `reply` tool to send a response back
6. The reply flows back through the hub WebSocket to all connected browsers

## Production Deployment

Build and deploy with Docker:

```bash
docker build -t remo-code .
docker run -p 3040:3040 \
  -e SUPABASE_URL=... \
  -e SUPABASE_ANON_KEY=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  -e HUB_ALLOWED_ORIGINS=https://your-domain.com \
  remo-code
```

The Docker image builds the web frontend and serves it from the hub server — no separate web server needed.

## Project Structure

```
remo-code.com/
├── hub/                # Bun + Hono server (HTTP, WebSocket, auth)
│   └── src/
│       ├── api/        # REST endpoints (sessions, messages, setup)
│       ├── auth/       # JWT verification middleware
│       ├── db/         # Supabase clients and data access layer
│       ├── middleware/  # Rate limiting
│       └── ws/         # WebSocket handlers + Zod protocol schemas
├── web/                # React 19 + Vite + Tailwind CSS 4 SPA
│   └── src/
│       ├── components/ # Layout, Sidebar, ChatPanel, AuthForm, etc.
│       └── hooks/      # useAuth, useWebSocket, useSessions, useChat
├── channel/            # Claude Code channel plugin (MCP server)
│   ├── server.ts       # MCP server + WebSocket client to hub
│   ├── .claude-plugin/ # Plugin metadata (plugin.json)
│   ├── .mcp.json       # MCP server config for Claude Code
│   └── skills/         # /remo-code:configure skill
├── supabase/           # Database migrations
└── Dockerfile          # Multi-stage production build
```

## Security

- Supabase JWT auth on all API and WebSocket endpoints
- Row-Level Security on all database tables
- Session tokens stored as SHA-256 hashes with timing-safe comparison
- CSP, HSTS, and security headers on all responses
- Rate limiting on API routes, setup endpoints, and WebSocket messages
- Per-IP connection limits on WebSocket endpoints
- Path traversal protection on static file serving
- Non-root Docker user
- Setup endpoint race condition protection (mutex)

## License

Private

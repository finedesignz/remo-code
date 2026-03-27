<p align="center">
  <img src="web/public/logo.png" alt="Remo Code" width="360" />
</p>

<h3 align="center">The open-source, self-hosted alternative to OpenClaw</h3>

<p align="center">Chat with your Claude Code sessions from any browser or phone — without giving a third party access to your machine.</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#why-remo-code">Why Remo Code</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#production-deployment">Deploy</a>
</p>

---

## Why Remo Code?

**[OpenClaw](https://openclaw.ai/)** popularized the idea of talking to an AI agent from your phone. But it requires you to trust a third-party runtime with shell access to your machine, and [security researchers have already found real data exfiltration in community-contributed OpenClaw skills](https://medium.com/@cognidownunder/claude-code-remote-control-vs-openclaw-one-is-secure-and-the-other-is-a-liability-3cd936cc58b3).

**Remo Code** gives you the same "chat with your agent from anywhere" workflow, but:

| | OpenClaw | Claude Code Remote Control | **Remo Code** |
|---|---|---|---|
| Self-hosted | Partial (local agent, cloud relay) | No (Anthropic relay) | **Yes, fully** |
| Open source | Yes | No | **Yes (MIT)** |
| Web UI | No (messaging apps only) | Yes (claude.ai) | **Yes (your own domain)** |
| Multi-session | No | No | **Yes** |
| Built on official API | No (custom runtime) | Yes | **Yes (Channels contract)** |
| Works when laptop sleeps | No | No | No* |
| Auth & data storage | Third-party servers | Anthropic servers | **Your Supabase instance** |

> *All three require the Claude Code process to be running. The difference is who controls the relay infrastructure — with Remo Code, you do.

### Who is this for?

- **Developers** who want to check on long-running Claude Code tasks from their phone
- **Teams** who want a shared dashboard for multiple Claude Code sessions
- **Security-conscious users** who don't want third-party tools with shell access to their machines
- **Self-hosters** who want full control over their data and infrastructure

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- A [Supabase](https://supabase.com/) project (free tier works)
- [Claude Code](https://claude.ai/code) v2.1.80+

### 1. Clone and install

```bash
git clone https://github.com/anthropics/remo-code.git
cd remo-code
bun install
```

### 2. Configure Supabase

Create a Supabase project and run the migration in `supabase/migrations/001_initial.sql` via the SQL Editor.

### 3. Set environment variables

```bash
cp hub/.env.example hub/.env
# Edit: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, HUB_ALLOWED_ORIGINS

cp web/.env.example web/.env
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

Open `http://localhost:5173` and create your account on the setup form.

### 6. Connect a Claude Code session

Create a session in the web UI, then in your terminal:

```bash
# Install the channel plugin
/plugin install remo-code@claude-plugins-official

# Configure the connection
/remo-code:configure http://localhost:3040 remo_YOUR_TOKEN

# Restart with channels enabled
claude --dangerously-load-development-channels plugin:remo-code@claude-plugins-official
```

That's it. Messages you send in the browser appear in Claude Code, and replies flow back in real time.

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

Three packages in a Bun workspace:

- **hub/** — Bun + Hono server handling auth (Supabase JWT), message relay, and session management via WebSocket and REST.
- **web/** — React 19 + Vite + Tailwind CSS 4 chat UI with session switching, online/offline status, and markdown rendering.
- **channel/** — Claude Code [channel plugin](https://code.claude.com/docs/en/channels-reference) (MCP server) that bridges each terminal session to the hub. Same contract as the official Telegram and Discord plugins.

## How It Works

The channel plugin follows the [Claude Code channels contract](https://code.claude.com/docs/en/channels-reference) — the same official API that powers Anthropic's own Telegram and Discord integrations:

1. Claude Code spawns the channel as an MCP subprocess (stdio transport)
2. The channel connects outbound to your hub via WebSocket and authenticates with a hashed token
3. When you send a message in the web UI, the hub forwards it to the channel
4. The channel emits a `notifications/claude/channel` event into Claude Code
5. Claude processes the message and calls the `reply` tool to respond
6. The reply flows back through the hub to all connected browsers

No custom runtime. No monkey-patching. Just the official channels API.

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

The Docker image builds the web frontend and serves it from the hub — one container, one port.

## Project Structure

```
├── hub/                # Bun + Hono server (HTTP, WebSocket, auth)
│   └── src/
│       ├── api/        # REST endpoints (sessions, messages, profile, setup)
│       ├── auth/       # JWT verification middleware
│       ├── db/         # Supabase clients and data access layer
│       ├── middleware/  # Rate limiting
│       ├── utils/      # Shared utilities (token generation)
│       └── ws/         # WebSocket handlers + Zod protocol schemas
├── web/                # React 19 + Vite + Tailwind CSS 4 SPA
│   └── src/
│       ├── components/ # Layout, Sidebar, ChatPanel, AuthForm, etc.
│       └── hooks/      # useAuth, useWebSocket, useSessions, useChat
├── channel/            # Claude Code channel plugin (MCP server)
│   ├── server.ts       # MCP server + WebSocket client to hub
│   ├── .claude-plugin/ # Plugin metadata (plugin.json)
│   └── skills/         # /remo-code:configure skill
├── supabase/           # Database migrations
└── Dockerfile          # Multi-stage production build
```

## Security

Remo Code is designed with a security-first approach — the opposite of "just give this npm package shell access and hope for the best":

- **Supabase JWT auth** on all API and WebSocket endpoints
- **Row-Level Security** on all database tables — multi-tenant by default
- **Session tokens** stored as SHA-256 hashes with timing-safe comparison
- **CSP, HSTS, and security headers** on all responses
- **Rate limiting** on API routes, setup endpoints, and WebSocket messages
- **Per-IP connection limits** on WebSocket endpoints
- **Path traversal protection** on static file serving
- **Non-root Docker user** in production
- **Setup endpoint mutex** preventing race conditions

Your data stays in your Supabase instance. Your Claude Code sessions stay on your machine. The hub is just a relay — and you own it.

## License

MIT

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Remo Code is a web app that lets you chat with your Claude Code sessions remotely from any browser or phone. It bridges local Claude Code terminals to a central hub via WebSocket, with a React chat UI on the frontend. The channel plugin follows the Claude Code [channels contract](https://code.claude.com/docs/en/channels-reference) — the same pattern as fakechat, Telegram, and Discord plugins.

## Architecture

```
Browser (React SPA)
    ↕ WebSocket /ws/client  +  REST /api/*
Hub Server (Bun + Hono, port 3040)
    ↕ WebSocket /ws/channel
Channel Plugin (MCP server, one per Claude Code session)
    ↕ stdio (MCP notifications + tools)
Claude Code terminal
```

Three packages in a Bun workspace:
- **hub/** — Bun + Hono HTTP/WS server. Authenticates users via Supabase JWT, manages sessions, relays messages between web clients and channel plugins.
- **web/** — React 19 + Vite + Tailwind CSS 4 SPA. Connects to hub via WebSocket for real-time chat.
- **channel/** — Claude Code channel plugin (MCP server). Declares `experimental: { 'claude/channel': {} }` capability, connects outbound to hub via WebSocket, exposes `reply`/`react`/`edit_message` tools, receives user messages as `notifications/claude/channel` events.

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

# Run channel plugin standalone (needs ~/.claude/channels/remo-code/.env)
cd channel && bun run start
```

## Channel Plugin (Claude Code Integration)

The channel plugin (`channel/server.ts`) follows the [Claude Code channels reference](https://code.claude.com/docs/en/channels-reference). It is structured identically to the official [fakechat plugin](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat):

- **Plugin metadata**: `.claude-plugin/plugin.json` (name, description, version)
- **MCP config**: `.mcp.json` — tells Claude Code how to spawn the server (`bun run start`)
- **Config skill**: `skills/configure/SKILL.md` — `/remo-code:configure <hub_url> <token>`

**How it works:**
1. Claude Code spawns the channel as an MCP subprocess via stdio
2. Channel reads `~/.claude/channels/remo-code/.env` for HUB_URL, HUB_TOKEN, SESSION_ID
3. Channel connects outbound to hub WebSocket at `/ws/channel`, authenticates with token
4. User messages from the web UI arrive as `notifications/claude/channel` events
5. Claude processes and calls the `reply` tool, which sends `assistant_message` back to hub

**Installing and running:**
```bash
# In Claude Code:
/plugin install remo-code@claude-plugins-official
/remo-code:configure <hub_url> <token>

# Then restart:
claude --channels plugin:remo-code@claude-plugins-official

# For development (not on approved allowlist yet):
claude --dangerously-load-development-channels plugin:remo-code@claude-plugins-official
```

## Database

Uses **Supabase** (hosted PostgreSQL + Auth). Schema in `supabase/migrations/001_initial.sql`.

Two tables: `sessions` (Claude Code sessions with hashed tokens) and `messages` (chat history). Both have RLS policies scoping data to `auth.uid()`.

The hub uses two Supabase clients:
- `supabaseAdmin` (service role key) — bypasses RLS for channel auth, status updates, message insertion
- `supabaseForUser(jwt)` — per-request client with user's JWT, RLS enforced automatically

## WebSocket Protocol

**`/ws/channel`** (channel plugin connects here):
- Auth: `{ type: "auth", session_id, token: "remo_..." }` → token verified via SHA-256 hash + `timingSafeEqual`
- Hub sends `user_message`, channel sends `assistant_message` and `status` updates
- 30s heartbeat ping/pong

**`/ws/client`** (browser connects here):
- Auth: `{ type: "auth", token: "<supabase_jwt>" }` → verified via `supabaseAdmin.auth.getUser()`
- Client sends `send_message` and `subscribe`, hub sends `message`, `session_status`, `session_list`
- Both endpoints have 5s auth timeout, per-IP connection limits (20), per-connection message rate limits

All WS messages validated with Zod schemas in `hub/src/ws/protocol.ts`.

## Key Design Decisions

- Channel follows the Claude Code channels contract: `experimental: { 'claude/channel': {} }` capability + `notifications/claude/channel` events + reply tools
- Session tokens use `remo_` prefix + 32 random bytes (base64url), stored as SHA-256 hashes
- The hub serves the built web SPA as static files (no separate web server in production)
- In-memory registries (`hub/src/ws/registry.ts`) track connected channels and clients — rebuilt on restart from reconnections
- Multi-tenant by design (all queries filter by user_id/RLS) but currently single-user

## Environment Variables

**hub/.env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT` (3040), `HUB_ALLOWED_ORIGINS`

**web/.env**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_HUB_URL`

**~/.claude/channels/remo-code/.env** (channel config): `HUB_URL`, `HUB_TOKEN`, `SESSION_ID`

## PR Hygiene

Periodically check for open PRs with `gh pr list`. Review them for conflicts with current work, stale branches, or changes that have already been applied to main. Flag any that should be closed or merged.

## Deployment

Docker multi-stage build (see `Dockerfile`): installs deps → builds web → copies into production image with non-root user. Runs on Coolify at `remo-code.com`, port 3040.

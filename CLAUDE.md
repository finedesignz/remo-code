# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Remo Code is a web app that lets you chat with Claude Code sessions remotely from any browser or phone. A local agent spawns Claude Code CLI with `--input-format stream-json --output-format stream-json`, giving the web UI full visibility into Claude's activity: thinking, tool calls, and streaming text responses.

## Architecture

```
Browser (React SPA)
    ↕ WebSocket /ws/client  +  REST /api/*
Hub Server (Bun + Hono, port 3040)
    ↕ WebSocket /ws/agent
Local Agent (Bun, runs on dev machine)
    ↕ subprocess stdin/stdout (stream-json)
Claude Code CLI (persistent interactive process)
```

Four packages in a Bun workspace:
- **hub/** — Bun + Hono HTTP/WS server. Authenticates users via Supabase JWT, manages sessions, relays messages and activity events between web clients and agents.
- **web/** — React 19 + Vite + Tailwind CSS 4 SPA. Connects to hub via WebSocket for real-time chat with activity feed (thinking blocks, tool call indicators, streaming text).
- **agent/** — Local streaming agent. Runs on the dev machine, spawns a persistent Claude Code CLI process, parses stream-json events, and relays them to the hub. Authenticates with an API key.
- **channel/** — (Legacy) Claude Code channel plugin. Kept for backward compatibility but no longer the recommended connection method.

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
# alias claude-remote='npx remo-code-agent --api-key <your_api_key> --local-output'
claude-remote

# Or run directly (connects to production hub, output to terminal + web)
npx remo-code-agent --api-key <your_api_key> --local-output

# Connect to local hub for development
npx remo-code-agent --hub-url http://localhost:3040 --api-key <your_api_key> --local-output

# Web UI only (no terminal output)
npx remo-code-agent --api-key <your_api_key>
```

## Local Agent (Recommended Connection Method)

The agent (`agent/src/index.ts`) runs on the same machine as Claude Code. It:

1. Connects to the hub via WebSocket at `/ws/agent`, authenticates with an API key
2. Spawns Claude Code CLI: `claude --input-format stream-json --output-format stream-json --verbose`
3. Keeps a single persistent Claude process alive (full conversation memory)
4. Receives user messages from the hub, writes them to Claude's stdin as JSON
5. Parses Claude's stdout stream-json events and relays to the hub in real-time
6. Hub broadcasts activity events (thinking, text_delta, tool_use, tool_result) to subscribed browsers

**Session resume:** The agent reuses existing sessions by matching `project_dir`. Restarting the agent in the same directory reconnects to the same session with full message history.

**Config priority:** CLI args > env vars (`REMO_HUB_URL`, `REMO_API_KEY`) > config file (`~/.config/remo-code/config.json`)

## Database

Uses **Supabase** (hosted PostgreSQL + Auth). Schema in `supabase/migrations/`.

Tables: `sessions` (Claude Code sessions with hashed tokens), `messages` (chat history), `api_keys` (plugin/agent authentication). All have RLS policies scoping data to `auth.uid()`.

The hub uses two Supabase clients:
- `supabaseAdmin` (service role key) — bypasses RLS for agent auth, status updates, message insertion
- `supabaseForUser(jwt)` — per-request client with user's JWT, RLS enforced automatically

## WebSocket Protocol

**`/ws/agent`** (local agent connects here):
- Auth: `{ type: "auth", api_key, project_dir, hostname }` → API key verified via SHA-256 hash, session found-or-created by project_dir
- Agent sends: `thinking`, `text_delta`, `tool_use`, `tool_result`, `status`, `assistant_message`
- Hub sends: `user_message` (with optional `images`/`attachments`), `cancel`, `ping`
- 30s heartbeat ping/pong

**`/ws/client`** (browser connects here):
- Auth: `{ type: "auth", token: "<supabase_jwt>" }` → verified via `supabaseAdmin.auth.getUser()`
- Client sends `send_message` (with optional `images`/`attachments`) and `subscribe`
- Hub sends `message`, `session_status`, `session_list`, plus activity events (`thinking`, `text_delta`, `tool_use`, `tool_result`, `status`)
- Both endpoints have 5s auth timeout, per-IP connection limits (20), per-connection message rate limits

**`/ws/channel`** (legacy channel plugin):
- Kept for backward compatibility. Same protocol as before.

All WS messages validated with Zod schemas in `hub/src/ws/protocol.ts` and `hub/src/ws/agent-protocol.ts`.

## Key Design Decisions

- Agent spawns Claude CLI with `--input-format stream-json --output-format stream-json` for full activity streaming
- Persistent Claude process per agent (conversation memory preserved across messages)
- Session resume by project_dir (agent reconnects to existing session on restart)
- Activity events (thinking, tool use) are ephemeral — only the final assistant_message is persisted
- File attachments: text files embedded in message content, images as base64 data URIs
- Light/dark theme via CSS custom properties (--bg-primary, --text-primary, etc.)
- Session tokens use `remo_` prefix + 32 random bytes (base64url), stored as SHA-256 hashes
- The hub serves the built web SPA as static files (no separate web server in production)

## Environment Variables

**hub/.env**: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `PORT` (3040), `HUB_ALLOWED_ORIGINS`

**web/.env**: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_HUB_URL`

**Agent config**: CLI args, env vars (`REMO_HUB_URL`, `REMO_API_KEY`), or `~/.config/remo-code/config.json`

## PR Hygiene

Periodically check for open PRs with `gh pr list`. Review them for conflicts with current work, stale branches, or changes that have already been applied to main. Flag any that should be closed or merged.

## Deployment

Docker multi-stage build (see `Dockerfile`): installs deps → builds web → copies into production image with non-root user. Runs on Coolify at `app.remo-code.com`, port 3040.

The agent runs locally on the dev machine — it is NOT deployed to the server.

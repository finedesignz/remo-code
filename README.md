<p align="center">
  <img src="web/public/logo.png" alt="Remo Code" width="360" />
</p>

<h3 align="center">Chat with Claude Code from any browser or phone</h3>

<p align="center">Full activity streaming — thinking, tool calls, and responses in real-time. Self-hosted, open-source.</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> &bull;
  <a href="#why-remo-code">Why Remo Code</a> &bull;
  <a href="#architecture">Architecture</a> &bull;
  <a href="#production-deployment">Deploy</a>
</p>

---

## Why Remo Code?

**[OpenClaw](https://openclaw.ai/)** popularized the idea of talking to an AI agent from your phone. But it requires you to trust a third-party runtime with shell access to your machine, and [security researchers have already found real data exfiltration in community-contributed OpenClaw skills](https://medium.com/@cognidownunder/claude-code-remote-control-vs-openclaw-one-is-secure-and-the-other-is-a-liability-3cd936cc58b3).

**Remo Code** gives you the same "chat with your agent from anywhere" workflow, but with full activity streaming and complete control:

| | OpenClaw | Claude Code Remote Control | **Remo Code** |
|---|---|---|---|
| Self-hosted | Partial (local agent, cloud relay) | No (Anthropic relay) | **Yes, fully** |
| Open source | Yes | No | **Yes (MIT)** |
| Activity streaming | No | No | **Yes (thinking, tool calls, text)** |
| Web UI | No (messaging apps only) | Yes (claude.ai) | **Yes (your own domain)** |
| Multi-session | No | No | **Yes** |
| File attachments | No | No | **Yes (images + text files)** |
| Auth & data storage | Third-party servers | Anthropic servers | **Your Supabase instance** |

### Who is this for?

- **Developers** who want to check on long-running Claude Code tasks from their phone
- **Teams** who want a shared dashboard for multiple Claude Code sessions
- **Security-conscious users** who don't want third-party tools with shell access to their machines
- **Self-hosters** who want full control over their data and infrastructure

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Claude Code](https://claude.ai/code) CLI installed
- A [Supabase](https://supabase.com/) project (free tier works)

### 1. Clone and install

```bash
git clone https://github.com/finedesignz/remo-code.git
cd remo-code
bun install
```

### 2. Configure Supabase

Create a Supabase project and run the migrations in `supabase/migrations/` via the SQL Editor.

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

### 6. Connect Claude Code

Generate an API key in Settings, then install the **Remo Code Supervisor** desktop app on the Windows machine you want to control:

- Download the latest `.msi` from [GitHub Releases](https://github.com/finedesignz/remo-code/releases/latest).
- Run the installer.
- Paste the API key into the first-run wizard. Pick the repo roots the supervisor should scan (typically `C:\Users\you\GitHub`).

The supervisor auto-starts at login, watches your repo roots, and lets you launch Claude Code (or Codex) sessions remotely from the web UI. One supervisor connects all your repos — sessions auto-register and auto-resume by repo.

> The legacy `npx remo-code-agent` / `claude-remote` shell-alias flow has been retired as of 2026-05-26. The Tauri Supervisor desktop app is the only supported local app.

### Using the hosted version

If you don't want to self-host, use the hosted hub at [app.remo-code.com](https://app.remo-code.com). Sign up, generate an API key in Settings, then install the [Remo Code Supervisor desktop app](https://github.com/finedesignz/remo-code/releases/latest) — same flow as above. The supervisor's default hub URL is `https://app.remo-code.com`.

## Architecture

```
Browser (React SPA)
    ↕ WebSocket + REST API
Hub Server (Bun + Hono)
    ↕ WebSocket /ws/agent
Supervisor desktop app (Tauri MSI — one per host)
    ↕ subprocess stdin/stdout (stream-json)
Claude Code CLI / Codex CLI (one process per session)
```

Three packages in a Bun workspace:

- **hub/** — Bun + Hono server handling auth (Titanium Licensing magic-link + opaque cookie sessions — see [docs/auth.md](docs/auth.md)), message relay, and session management. Broadcasts Claude's activity events (thinking, tool use, text) to subscribed browsers.
- **web/** — React 19 + Vite + Tailwind CSS 4 chat UI with activity feed, session switching, file attachments, light/dark theme, and unread badges.
- **supervisor/** — Local supervisor source. `supervisor/src/` is compiled by `bun build --compile` into the sidecar binary that `supervisor/tauri/` bundles into a Windows MSI installer (Rust + WebView2 tray app). Each running host has exactly one supervisor; the supervisor hosts every session for that machine.

## How It Works

1. You install the Remo Code Supervisor MSI on the Windows machine you want to control, paste your API key into the first-run wizard, and pick repo roots.
2. The supervisor connects to the hub via WebSocket (`/ws/agent`) and registers as an agent for your account.
3. When you click "Start session" for a repo from the web UI, the supervisor spawns `claude --input-format stream-json --output-format stream-json --verbose` (or `codex app-server` for Codex sessions) in that repo directory.
4. When you send a message in the web UI, the hub forwards it to the supervisor.
5. The supervisor writes the message to the CLI's stdin as JSON.
6. The CLI responds — thinking, tool calls, text stream out via stdout.
7. The supervisor parses the stream-json events and relays them to the hub.
8. The hub broadcasts to all subscribed browsers in real-time.

**Session resume:** The supervisor reuses existing sessions by matching the repo directory. Restart the supervisor and it reconnects to the same sessions with full message history.

**Conversation memory:** The supervisor keeps each session's CLI process alive between messages — full conversation context is maintained across messages, just like the terminal.

## Features

- **Activity streaming** — see Claude's thinking, tool calls, and text responses in real-time
- **File attachments** — paste images (Ctrl+V) or attach text files in the chat
- **Multi-session** — run agents in multiple project directories, switch between them
- **Session resume** — restart the agent and reconnect to the same session
- **Scheduled tasks** — fire prompts, skills, or supervisor commands on a cron cadence against one session, one supervisor, or all of either. Dropdown cron builder (every N min/hour/day/month, daily, weekly multi-select, monthly with "Last day", custom) with plain-English summary + next-3-runs preview. Schedules list has name search + enabled/disabled + task-type filters and last-run cost/duration chips per row. Runs drawer has status filter chips + summary stats (success rate, total cost, avg duration). Every scheduled run ends with a one-line `Summary:` from Claude, and the chat shows the trigger as a `Scheduled: <task name>` pill above the prompt. Per-target run history, daily cost cap, offline-grace replay, and post-run actions (chain, email, telegram, web push, webhook). See [docs/scheduled-tasks.md](docs/scheduled-tasks.md).
- **Error capture** — Sentry-style intake at `/api/sentry/:project_id/envelope/` that fingerprints + dedupes + rate-limits + caps runtime errors from your deployed apps, then routes them as a structured `user_message` into the Claude session bound to that repo so Claude can investigate, fix, commit, and push in-session. Includes one-click Sentry SDK auto-install for Node+Express / Node+Next.js / Python+FastAPI / Python+Django (supervisor git-ops + Coolify env PATCH). See [docs/error-capture.md](docs/error-capture.md).
- **Grid View** — watch up to 12 Claude Code sessions side-by-side at `#/grid`. User-named tabs persist per account (`chat_tabs` + `chat_tab_sessions`), each with a layout mode (`3x3`, `4x3`, or `auto-fit`). One WebSocket subscribes to many sessions in one frame, message lists are virtualized, and streaming text is RAF-coalesced. On phones the grid auto-swaps to a single-pane accordion (only one chat mounted at a time). See [docs/grid-view.md](docs/grid-view.md). <!-- screenshot: docs/img/grid-view.png -->
- **Coolify deployment self-heal (Phase 06, partial)** — a public HMAC-signed webhook endpoint (`POST /api/coolify/webhook/:user_id`) turns `deployment.failed` events into structured `triage` runs that ask Claude to emit a typed `TriageResult` (error_type, severity, root_cause, suggested_fix, confidence). A `github_issue` post-run action then files a labelled issue on the failing repo via the gateway-pair credentials (no `GITHUB_TOKEN` on the hub) with 24-hour idempotency. Webhook ingress, secret rotation, triage schema, and the GitHub-issue action are shipped; the final session-routing wire-up (`pickSessionTarget`) is pending the Phase 04 self-heal-routing plan landing. See [docs/coolify-webhook-migration.md](docs/coolify-webhook-migration.md) and the "Coolify webhook ingress" / "GitHub-issue post-run action" sections in [docs/scheduled-tasks.md](docs/scheduled-tasks.md).
- **Codex CLI + rootless ambient sessions** — sessions can run either Claude Code or [Codex](https://github.com/openai/codex) (`cli_kind` column). Each agent can also host "ambient" rootless sessions (one Claude + one Codex per host) with no project directory required, lazy-spawned on first message. Global instruction files (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.codex/config.toml`) sync from the hub on connect via `create_if_absent` — the agent never overwrites local files. Edit blobs in Settings → Instructions. See [docs/codex-and-rootless.md](docs/codex-and-rootless.md). Requires `npm i -g @openai/codex` + `codex login` (or `OPENAI_API_KEY`).
- **Subscription quota strip** — the header shows live Anthropic Claude subscription utilization (5-hour + 7-day windows) reported by the supervisor's poll of `/api/oauth/usage`. Hover for exact %, reset countdowns, and Opus / OAuth-app sub-quotas when present.
- **Unread badges** — know when sessions have new messages
- **Light/dark theme** — toggle in the header
- **Mobile-first** — responsive design with safe-area support for notched devices

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

The Docker image builds the web frontend and serves it from the hub — one container, one port. The supervisor runs on your dev machine, not on the server.

## Project Structure

```
├── hub/                # Bun + Hono server (HTTP, WebSocket, auth)
│   └── src/
│       ├── api/        # REST endpoints (sessions, messages, profile, setup)
│       ├── auth/       # JWT + API key verification middleware
│       ├── db/         # Supabase clients and data access layer
│       ├── middleware/  # Rate limiting
│       ├── utils/      # Shared utilities (token generation)
│       └── ws/         # WebSocket handlers (agent, client) + Zod schemas
├── web/                # React 19 + Vite + Tailwind CSS 4 SPA
│   └── src/
│       ├── components/ # Layout, ChatPanel, ActivityFeed, Sidebar, etc.
│       └── hooks/      # useAuth, useWebSocket, useSessions, useChat, useActivity
├── supervisor/         # Local supervisor — Tauri 2 desktop tray app
│   ├── src/            # Bun TypeScript source (compiled to sidecar binary by Tauri)
│   └── tauri/          # Windows tray shell (Rust + WebView2) → MSI installer
├── supabase/           # Database migrations
└── Dockerfile          # Multi-stage production build
```

## Security

- **Titanium Licensing magic-link auth** on all user-facing API and WebSocket endpoints (see [docs/auth.md](docs/auth.md)). Agent endpoints (`/ws/agent`) use API keys.
- **Row-Level Security** on all database tables — multi-tenant by default
- **API keys** stored as SHA-256 hashes with timing-safe comparison
- **CSP, HSTS, and security headers** on all responses
- **Rate limiting** on API routes, setup endpoints, and WebSocket messages
- **Per-IP connection limits** on WebSocket endpoints
- **Path traversal protection** on static file serving
- **Non-root Docker user** in production
- **Setup endpoint mutex** preventing race conditions

Your data stays in your Supabase instance. Your Claude Code sessions stay on your machine. The hub is just a relay — and you own it.

## API docs

The hub exposes its REST surface as an OpenAPI 3.1 spec at `/openapi.json` and a Scalar-rendered reference UI at `/docs` (e.g. `http://localhost:3040/docs`). The committed snapshots live at `docs/openapi.json` (machine) and `docs/api.md` (human). Regenerate after touching the OpenAPI sample route:

```bash
bun run docs:sync
```

CI fails PRs that drift the snapshots — see `.github/workflows/docs-drift.yml`. Only `/api/profile/cost-today` is in the spec today; other routes will be migrated incrementally.

## License

Apache-2.0

# CLAUDE.md

Guidance for Claude Code working in this repo. **Durable rules + a map only.** Deep
per-subsystem and per-phase detail lives in `docs/` (context-mode indexed, read on
demand) — see the Docs map below. Full historical rollups: [docs/claude-architecture-notes.md](docs/claude-architecture-notes.md).

## Preferences (global, not duplicated here)

- UI/UX (color, spacing, font, layout, theme) → `~/.claude/design-preferences.md`
- Stack / components / data-flow / persistence → `~/.claude/architecture-preferences.md`
- Ports / Coolify / infra → `~/.claude/infrastructure.md`

Read those before any design or architecture decision. Never restate their contents here.

## Workflow: always use git worktrees for new features

**Mandatory.** New feature/phase/non-trivial refactor → create a worktree off `origin/main`
and do ALL work there. Never build on the primary checkout — parallel sessions wipe
uncommitted/untracked files when they switch branches or `git clean`.

```bash
cd C:/Users/artic/GitHub/remo-code
git fetch origin
git worktree add ../remo-code-feat-<slug> -b feat/<slug> origin/main
cd ../remo-code-feat-<slug>          # all work, commits, .planning/ docs happen here
```

PR `feat/<slug>` → `main`. After merge: `git worktree remove ../remo-code-feat-<slug> && git branch -D feat/<slug>`.
Exceptions: trivial single-file bugfixes, doc edits.

## What This Is

Web app to chat with Claude Code / Codex sessions remotely from any browser or phone.
A local supervisor spawns the CLI with `--input-format stream-json --output-format
stream-json`, giving the web UI full visibility into thinking, tool calls, and streaming
text. Also ships scheduled tasks, error capture, grid view, an orchestrator session, a
Telegram bridge, and Revanote annotation intake (see Docs map).

## Architecture

```
Browser (React SPA)
    ↕ WebSocket /ws/client  +  REST /api/*
Hub Server (Bun + Hono, port 3040)
    ↕ WebSocket /ws/agent
Remo Code Supervisor desktop app (Tauri MSI, one per host)
    ↕ subprocess stdin/stdout (stream-json)
Claude Code CLI / Codex CLI (one persistent process per session)
```

Three packages in a Bun workspace:
- **hub/** — Bun + Hono HTTP/WS server. Titanium magic-link + opaque-cookie auth, session
  management, relays messages + activity events between web clients and supervisors. Serves
  the built SPA as static files in prod.
- **web/** — React 19 + Vite + Tailwind CSS 4 SPA. WebSocket to hub for real-time chat.
- **supervisor/** — Local tray app. `supervisor/src/` is Bun TS source; `supervisor/tauri/`
  compiles it via `bun build --compile` into a sidecar binary + Windows MSI. One per host.
  Connects to `/ws/agent` with an API key, spawns Claude/Codex CLIs on demand, relays
  stream-json events to the hub.

## Commands

```bash
bun install                                  # deps (repo root)
bun run dev:hub                              # hub server (3040)
bun run dev:web                              # web dev server (5173)
bun run build:web                            # build web for prod
bun run check-baseline                       # QC gate (per-file test isolation; tools/regression-baseline.json)
bun run docs:sync                            # regenerate docs/openapi.json + docs/api.md
cd supervisor/tauri && cargo tauri build     # build supervisor MSI
```

Legacy `npx remo-code-agent` / `claude-remote` is retired (2026-05-26) — install the Tauri
Supervisor MSI from https://github.com/finedesignz/remo-code/releases/latest. The legacy spawn
path is hard-disabled in the supervisor (Phase 09): `session.start` finalizes as
`stopped`/`legacy_agent_spawn_disabled` instead of respawn-looping; backoff caps at
`MAX_RESTART_COUNT=10`. Canary test `supervisor/test/no-legacy-agent-spawn.test.ts` fails the
build if the retired package name or `--append-system-prompt` reappears.

## Local Supervisor (only supported connection)

`supervisor/src/index.ts`, compiled into the Tauri sidecar, runs as a tray app on the dev
machine. Connects to `/ws/agent` with an API key; hosts one CLI subprocess per active session
(spawned lazily on first user message), kept alive between messages for full conversation memory.

- **Session resume** by matching `project_dir` — restart reconnects with full history.
- **Session inventory push** (supervisor ≥0.5.7): `session_inventory` every 10s, hub stores it
  in `hub/src/ws/supervisor-registry.ts` and folds it into `GET /api/sessions`'s `active` flag.
- **Idle teardown** (`hub/src/ws/idle-teardown.ts`): subscriber count → 0 starts a
  `REMO_SESSION_IDLE_GRACE_SECONDS` timer → `shutdown`/`idle_no_subscribers`. Orchestrator
  session is exempt.
- **Config:** `%LOCALAPPDATA%\remo-code-supervisor\config.json` (Tauri first-run wizard).

## Database

**PostgreSQL** (self-hosted, on Coolify). Schema in `hub/src/db/schema.sql` — idempotent DDL
only; **it re-runs in full every hub boot**, so data backfills MUST be one-shot scripts in
`hub/scripts/`, never inline in schema.sql. Core tables: `users` (identity + Titanium
`license_status` mirror; legacy `password_hash` behind `ALLOW_LEGACY_LOGIN`), `auth_sessions`
(opaque cookie sessions), `sessions`, `messages`, `api_keys`. All queries scoped by `user_id`.
Subsystem tables are documented in their respective `docs/*.md`.

## WebSocket Protocol

`/ws/agent` (supervisor) and `/ws/client` (browser). All messages Zod-validated in
`hub/src/ws/protocol.ts` + `agent-protocol.ts`.

- **`/ws/agent`** — auth `{ api_key, project_dir, hostname }` (SHA-256 hash); supervisor sends
  `thinking`/`text_delta`/`tool_use`/`tool_result`/`status`/`assistant_message`; hub sends
  `user_message`/`cancel`/`ping`; 30s heartbeat. Keyed by `api_keys`, **never** user license.
- **`/ws/client`** — auth `{ token }` (opaque session cookie; legacy JWT only when
  `ALLOW_LEGACY_LOGIN=true`); client sends `send_message`/`subscribe`; hub sends
  `message`/`session_status`/`session_list` + activity events.
- Both: 5s auth timeout, 20 conns/IP, per-conn rate limits. `subscribe` accepts single
  `session_id` or multi `session_ids` (cap 12, for grid view).

## Key Design Decisions

- Persistent CLI process per session; resume by `project_dir`.
- Activity events (thinking, tool use) are ephemeral — only the final `assistant_message` persists.
- File attachments: text inlined into message content; images as base64 data URIs.
- Theme via CSS custom properties (`--bg-primary`, `--text-primary`, …).
- Session tokens: `remo_` prefix + 32 random bytes (base64url), stored as SHA-256 hashes.
- Subscription quota (4 windows: `five_hour`, `seven_day`, + Max-only `seven_day_opus` /
  `seven_day_oauth_apps`) polled by the **supervisor** (`supervisor/src/usage/oauth-poll.ts`,
  5-min interval), not the hub — OAuth token stays in `~/.claude/.credentials.json` on the dev
  machine and is **never** serialized to the hub; only the parsed util%/`resets_at` windows are.
  Hub keeps an in-memory snapshot (`hub/src/usage/store.ts`), rebroadcasts via WS
  `subscription_usage`; web renders util + Opus pill + reset countdown (`UsageStrip`/`UsageTab`).
  The poll ships only with the supervisor MSI (≥0.7.0).

## Environment Variables

- **hub/.env:** `DATABASE_URL`, `JWT_SECRET` (min 32), `PORT` (3040), `HUB_ALLOWED_ORIGINS`.
  Titanium / Telegram / mobile / scheduler envs are documented in the relevant `docs/*.md`.
- **web/.env:** `VITE_HUB_URL`.
- **Supervisor:** Tauri wizard → `%LOCALAPPDATA%\remo-code-supervisor\config.json`.
- **Optional:** `REMO_SESSION_IDLE_GRACE_SECONDS` (default 300; `0` disables idle teardown),
  `REMO_ORCHESTRATOR_AUTOLAUNCH` (`false` disables auto-launch), `TITANIUM_BYPASS` (currently
  `true` in prod — see docs/auth.md), `COOLIFY_TOKEN`, `E4A_*`.

## Docs map — subsystems & phases

Each doc is the source of truth; **update it in the same commit** as a behavior change.
Cross-cutting prose + all historical phase rollups: [docs/claude-architecture-notes.md](docs/claude-architecture-notes.md).

| Subsystem / phase | Doc | One-liner |
|---|---|---|
| Scheduled tasks | [scheduled-tasks.md](docs/scheduled-tasks.md) | Hub cron scheduler (`hub/src/scheduler/`); fan-out, cost-cap, post-run actions, Phase-11 workflows. Contract test: `hub/test/scheduler.test.ts`. |
| Error capture | [error-capture.md](docs/error-capture.md) | Sentry-style intake (`hub/src/error-capture/`) → dispatch into repo-bound session; SDK auto-install for 4 stacks. |
| Grid view | [grid-view.md](docs/grid-view.md) | Multichat grid `#/grid` (up to 12 sessions); `ChatSurface` densities, `@tanstack/react-virtual`. |
| Chat UI architecture | [chat-ui-architecture.md](docs/chat-ui-architecture.md) | Reusable `ChatSurface` spec: component tree, hooks, the transport-adapter seam (portable core vs remo-code WS), attachments/mic/streaming/permissions/slash, theming. Canonical chat-UI pattern for all apps. |
| Codex + rootless | [codex-and-rootless.md](docs/codex-and-rootless.md) | Phase 05 — Codex CLI runner, rootless ambient sessions, instructions sync. |
| Coolify self-heal | [coolify-webhook-migration.md](docs/coolify-webhook-migration.md) | Phase 06 — Coolify webhook → triage run → optional `github_issue`. |
| Auth (Titanium) | [auth.md](docs/auth.md) | Phase 07 — magic-link + opaque cookie sessions + license gate. `TITANIUM_BYPASS` active in prod. |
| Revanote | [revanote.md](docs/revanote.md) | Phase 08 — visual-annotation webhook → session → `<<JSON>>` callback (retry curve). |
| Orchestrator session | [claude-architecture-notes.md](docs/claude-architecture-notes.md) | Auto-launching root-folder coordinator session; exactly one open per user. |
| Telegram bridge | [telegram-bridge.md](docs/telegram-bridge.md) | Phase 12 — bidirectional Telegram ↔ session; orchestrator is the preferred default. |
| Mobile Tauri client | [mobile-client.md](docs/mobile-client.md) · [phase-12-pause-state.md](docs/phase-12-pause-state.md) | Phase 12 — iOS/Android WebView shell + deep-link auth. **Paused 2026-05-28.** |
| Shared dispatch + intake | [claude-architecture-notes.md](docs/claude-architecture-notes.md) | `hub/src/dispatch/` (gates→queue→grace→finalize) + `hub/src/webhooks/intake.ts`. All inbound subsystems ride these. |
| Usage cost ledger | [usage-cost.md](docs/usage-cost.md) | P2 — per-turn token+cost capture (`usage_event`) → `token_usage` + `token_usage_daily` → `GET /api/usage/cost`. SDK `total_cost_usd` authoritative; `hub/src/usage/pricing.ts` is fallback only. Cost is a list-price ESTIMATE. Cap (P3) unaffected. Needs supervisor ≥0.8.0. |
| API docs | [api.md](docs/api.md) · `/openapi.json` · `/docs` | OpenAPI 3.1 assembled in `hub/src/api/_openapi.ts`; run `bun run docs:sync` after route changes (docs-drift CI enforces). |

## Cross-cutting invariants (do not violate)

- **Cost cap is non-bypassable.** Every inbound user→session dispatch flows through the shared
  `dailyCostCapGate` in `hub/src/dispatch/gates.ts` (single source of truth — `isOverCostCap`).
- **Public webhooks: raw body BEFORE JSON parse**, constant-time secret compare, HMAC over
  `${ts}.${rawBody}`, reject >5min skew. Webhooks mount BEFORE the `/api/*` auth catch-all;
  license gate after auth; `/ws/agent` keyed by `api_keys`. `hub/test/mount-order.test.ts` enforces.
- **Don't hand-roll per-subsystem dispatch/queue/grace.** Round-2 collapse is complete — use
  `hub/src/dispatch/` (the old `scheduler/session-queue.ts` shim is deleted).
- **schema.sql re-runs every boot** — idempotent DDL only; backfills → `hub/scripts/` one-shots.
- **Orchestrator:** exactly one open per user (`idx_sessions_orchestrator_unique`); never set
  `orchestrator_enabled=false` without also setting `orchestrator_disabled_explicitly=true`
  (the boot backfill re-enables otherwise). Detail in the architecture-notes archive.

## Deployment / Releases

- **Hub:** Docker multi-stage (`Dockerfile`) on Coolify at `app.remo-code.com`, port 3040.
  The supervisor runs locally on the dev machine — **not** deployed.
- **Supervisor:** push a `supervisor-v*.*.*` tag → `.github/workflows/release-supervisor.yml`
  builds + signs the MSI + publishes a Release with `latest.json` for the auto-updater. Local:
  `pwsh -File supervisor/tauri/scripts/build-and-update.ps1`. Key setup: `supervisor/tauri/UPDATER-SETUP.md`.

## PR Hygiene

Periodically `gh pr list` — review open PRs for conflicts, stale branches, or already-applied
changes; flag any to close or merge.

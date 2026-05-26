<!-- updated: 2026-05-24 -->
# Project State — remo-code

> **Note (Phase 09, 2026-05-26):** The agent/ workspace and channel/ plugin are retired. The local CLI runner now lives in supervisor/src/ and ships exclusively as a Tauri MSI desktop app. The hub /ws/agent route is unchanged. References below to agent/, npx remo-code-agent, claude-remote, or /ws/channel are historical. See .planning/phases/09-retire-npm-packages/.


## What it is

Remo Code is a web app that lets a user chat with their local Claude Code CLI sessions from any browser or phone. A local **agent** (`npx remo-code-agent`) spawns Claude Code with `--input-format stream-json --output-format stream-json` and relays activity (thinking, tool calls, streaming text, permission prompts) to a **hub** (Bun + Hono on port 3040) over a WebSocket. The browser subscribes to one or more sessions and renders the live activity feed.

Live in production at **https://app.remo-code.com** (Coolify, Docker). One canonical hub. Agent runs locally on each user's machine. Open-source on GitHub at `finedesignz/remo-code`; the agent ships as `remo-code-agent` on npm.

## Packages (Bun workspace)

- **hub/** — Bun + Hono HTTP + WS server. JWT auth (`/ws/client`), API-key auth (`/ws/agent`), Postgres-backed sessions/messages/api_keys/supervisors/scheduled_tasks. Serves the built web SPA as static files.
- **web/** — React 19 + Vite + Tailwind 4 SPA. Hash-based routing (`#/chat`, `#/settings`, `#/schedules`). Uses CSS custom properties for theming.
- **agent/** — Local streaming agent (`npm: remo-code-agent`, v0.3.x). Spawns Claude Code CLI as a persistent child process, resumes sessions by `project_dir`.
- **channel/** — Legacy Claude Code channel plugin. Kept for back-compat; no longer the recommended connection path.

## Recently shipped

Phase 06 (`error-capture`) — **shipped (PR #17 open)** at HEAD `9c614b7`. Sentry-style intake at `POST /api/sentry/:project_id/envelope/` (public, `sentry_key` is credential), fingerprint + 3 pre-dispatch gates (dedupe → rate-limit → daily-cap), then `user_message` into the Claude session bound to the repo for in-session investigate/fix/commit/push. One-shot SDK auto-install for Node+Express / Node+Next.js / Python+FastAPI / Python+Django via supervisor git-ops + Coolify env PATCH. Silent-skip emails via emails4agents (6 kinds, throttled). Lives at `hub/src/error-capture/` + `hub/src/api/{sentry-intake,error-projects,errors,error-runs,error-setup}.ts`. Replaces the standalone `claude-code-self-heal` service (decommission lands in a follow-up). Full docs at `docs/error-capture.md`.

Phase 02 (`scheduled-tasks`) — hub-side cron scheduler with per-target fan-out, daily cost cap, offline grace replay, boot catchup, and post-run actions (chain, email via emails4agents, telegram, web push, webhook with HMAC). Lives at `hub/src/scheduler/` (V2 dispatcher). V0 legacy at `hub/src/scheduler/index.ts` is still wired during transition. Full docs at `docs/scheduled-tasks.md`. 41 unit tests in `hub/test/scheduler.test.ts`; e2e smoke in `hub/test/scheduled-tasks.e2e.test.ts` (skipped without `REMO_E2E_DB_URL`).

Phase 01 (`merge-self-heal`) — resolved stale PR #1 (`upstream-fixes`, ~14 days, 126-file drift) by cherry-picking still-valid fixes, dropping the rest, closing the PR. Crypto-helpers extracted from `ws/channel.ts` to `hub/src/lib/crypto.ts`; web fetch helper `hubFetch` added; profile route shape fixed.

Recent commits (top 5 on `main`):
- `4f33fc8 docs: scheduled tasks architecture, README, CLAUDE.md`
- `436479e fix(sidebar): remove orphan inline tooltip (portal now handles it)`
- `b9b259e test(scheduler): e2e smoke for create/fire/delete lifecycle`
- `dae8454 test(scheduler): unit tests for cron, queue, resolver, post-run, aggregator`
- `5ebf689 fix(web): close fragment + render hovered session tooltip portal in Sidebar`

## Current shape (the bits that matter for new work)

- **WS protocol** (`hub/src/ws/protocol.ts`): `ClientSubscribe` already accepts `session_ids: z.array(z.string()).max(100)` — multi-session subscription is in the schema. What's NOT done: the web client only ever subscribes to ONE active session at a time. Any multi-cell view must drive the subscribe op with the full active set and tag inbound activity events by `session_id` for routing to the right cell.
- **Chat surface**: `web/src/components/ChatPanel.tsx` owns the message list, activity feed, input box, attachments. Tightly coupled to `Layout.tsx` which wires the active-session pointer. To render N at once we need a self-contained `<ChatSurface sessionId density>` that owns its subscription life-cycle.
- **Routing**: hash-based in `web/src/App.tsx` (`getRoute()` switches on `window.location.hash`). New routes must extend that switch — no react-router.
- **DB**: Postgres (Coolify-hosted), schema in `hub/src/db/schema.sql`. Idempotent migrations via `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`. No formal migration tool. All queries scoped by `user_id`.
- **REST**: one Hono sub-router per resource in `hub/src/api/<name>.ts`, mounted in `hub/src/index.ts`. Zod validation at handler boundary.
- **Styling**: canonical reference is `web/src/components/SettingsPage.tsx`. Soft `bg-secondary/60` cards, indigo accents (`indigo-600` solid, `indigo-300/400` text), `rounded-xl` cards, `rounded-lg` controls. No heavy borders.

## Active concerns relevant to next phase

- Per-IP WS connection cap is 20 (`hub/src/middleware/rate-limit.ts`). A grid of 12 cells still uses ONE connection (subscribe is per-connection, not per-session), so the cap is fine. Confirm this assumption survives.
- No test harness on the web side. Hub tests are Bun-native (`bun test`). New API endpoints get unit + integration coverage in `hub/test/`.
- `ChatPanel.tsx` is ~28KB and does too much. The refactor in this phase needs to be surgical — extract a `<ChatSurface>` with density props, do NOT rewrite features.
- Activity events on the WS (`thinking`, `text_delta`, `tool_use`, `tool_result`) are ephemeral by design. Cells must hold their own per-session ring buffer; switching tabs should not lose in-flight thinking.

## What's next

Phase 03 — `multichat-grid-view`. Spec in `.planning/REQUIREMENTS.md` and `.planning/ROADMAP.md`; plans under `.planning/phases/03-multichat-grid-view/`.

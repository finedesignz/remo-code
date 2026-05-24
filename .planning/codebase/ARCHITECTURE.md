<!-- refreshed: 2026-05-22 -->
# Architecture

**Analysis Date:** 2026-05-22

## System Overview

```text
┌──────────────────────────────────────────────────────────────┐
│                      Browser (React 19 SPA)                   │
│              `web/src/App.tsx` + `web/src/components/*`       │
│   WS client `useWebSocket.ts`  ·  REST client `lib/auth.ts`   │
└────────────┬───────────────────────────┬──────────────────────┘
             │ WS /ws/client (JWT)       │ HTTPS /api/*  (JWT)
             ▼                           ▼
┌──────────────────────────────────────────────────────────────┐
│              Hub Server — Bun + Hono (port 3040)              │
│   `hub/src/index.ts` (Bun.serve + Hono app + WS upgrades)     │
│ ┌──────────────┬──────────────┬─────────────────────────────┐│
│ │ REST API     │ WS endpoints │  In-memory registry         ││
│ │ `api/*.ts`   │ ws/client.ts │  `ws/registry.ts`           ││
│ │              │ ws/agent.ts  │  channels: sessionId→ws     ││
│ │              │ ws/channel.ts│  clients: Set<ClientEntry>  ││
│ └──────┬───────┴──────┬───────┴─────────────────────────────┘│
│        │              │                                       │
│        ▼              ▼                                       │
│   `db/dal.ts` → `db/postgres.ts` → PostgreSQL                 │
└────────────┬─────────────────────────────────────────────────┘
             │ WS /ws/agent (API key, SHA-256 hashed)
             ▼
┌──────────────────────────────────────────────────────────────┐
│         Local Agent — Bun (runs on dev machine)               │
│   `agent/src/index.ts`                                        │
│   ├─ `hub-client.ts` — WS to hub, auth + reconnect            │
│   └─ `claude-runner.ts` — persistent Claude CLI subprocess    │
└────────────┬─────────────────────────────────────────────────┘
             │ subprocess stdin/stdout (newline-delimited JSON)
             ▼
┌──────────────────────────────────────────────────────────────┐
│   Claude Code CLI                                             │
│   `claude --input-format stream-json --output-format          │
│    stream-json --verbose [--resume <id>]                      │
│           --dangerously-skip-permissions`                     │
└──────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Hub HTTP/WS server | Bun.serve entry, WS upgrade routing, static SPA serving | `hub/src/index.ts` |
| Hono app | REST routes, auth + rate limit middleware, security headers | `hub/src/index.ts` (`app = new Hono()`) |
| Agent WS handler | Auth via API key, session find-or-create, relay stream-json activity | `hub/src/ws/agent.ts` |
| Client WS handler | JWT auth, subscribe/send_message, relay activity to subscribers | `hub/src/ws/client.ts` |
| Legacy channel WS | Backward compat for older channel plugin | `hub/src/ws/channel.ts` |
| WS registry | In-memory `channels` (sessionId→ws) + `clients` (Set) | `hub/src/ws/registry.ts` |
| DAL | All Postgres queries, scoped by `user_id` | `hub/src/db/dal.ts` |
| Postgres pool | Connection pool, `DATABASE_URL` | `hub/src/db/postgres.ts` |
| JWT auth | Sign/verify session tokens | `hub/src/auth/jwt.ts`, `auth/middleware.ts` |
| API key auth | SHA-256 hash compare for agent + plugin endpoints | `hub/src/auth/api-key-middleware.ts` |
| Local agent entry | Pre-flight `claude --version`, wire hub↔runner | `agent/src/index.ts` |
| Claude runner | Persistent subprocess, stream-json parser, auto-restart | `agent/src/claude-runner.ts` |
| Hub client (agent side) | WS connect, auth payload, reconnect | `agent/src/hub-client.ts` |
| React app shell | Routes, theme, auth gate | `web/src/App.tsx` |
| Chat panel + activity feed | Messages + thinking/tool blocks | `web/src/components/ChatPanel.tsx`, `ActivityFeed.tsx` |

## Pattern Overview

**Overall:** Three-tier message relay with a persistent subprocess at the edge.

**Key Characteristics:**
- Hub is a stateless relay backed by Postgres for durable state and in-memory registries for live socket routing.
- Agent owns the only stateful long-lived resource: the Claude CLI subprocess (full conversation memory in-process).
- Browser is a thin view — never talks to the agent directly; everything passes through the hub.
- Activity events (thinking, text_delta, tool_use, tool_result) are ephemeral broadcast-only; only `assistant_message` is persisted.
- One Claude process per agent per project_dir; multiple browsers can subscribe to the same session.

## Layers

**Presentation (Browser):**
- Purpose: User interaction, render chat + activity stream.
- Location: `web/src/`
- Contains: React components, hooks, WS client.
- Depends on: Hub REST + `/ws/client`.
- Used by: End user.

**Edge / Transport (Hub):**
- Purpose: Auth, routing, broadcast, persistence.
- Location: `hub/src/`
- Contains: Hono routes, WS handlers, registries, DAL.
- Depends on: PostgreSQL.
- Used by: Browser clients and local agents.

**Execution (Agent):**
- Purpose: Spawn + drive Claude CLI, relay events.
- Location: `agent/src/`
- Contains: Subprocess manager, stream parser, hub WS client.
- Depends on: Local `claude` binary, hub `/ws/agent`.
- Used by: One developer machine per agent.

**Engine (Claude CLI):**
- Purpose: Reasoning, tool use.
- Location: External binary (`claude`).
- Stream-json over stdio.

## Data Flow

### Primary Request Path — Browser sends a message

1. User types in `ChatPanel.tsx`, hook `useChat.ts` calls `useWebSocket.ts` sender.
2. Browser sends `{type:"send_message", session_id, content, images?, attachments?}` over `/ws/client`.
3. Hub `handleClientMessage` (`hub/src/ws/client.ts`) validates Zod schema, persists user message via `insertMessage` (`db/dal.ts`), looks up the agent channel via `getChannel(sessionId)` (`ws/registry.ts`).
4. Hub forwards `{type:"user_message", ...}` to the agent ws.
5. Agent `handleMessage` (`agent/src/index.ts:54`) calls `runner.sendMessage()` (`claude-runner.ts:143`) → writes `{type:"user", message:{role:"user", content}}` JSON line to Claude stdin.
6. Claude stdout emits stream-json events; `ClaudeRunner.readStream` (`claude-runner.ts:250`) parses each line and invokes `handleEvent` (`claude-runner.ts:279`).
7. Each event becomes a `RunnerEvent` → agent relays `{...event, session_id}` to hub over `/ws/agent`.
8. Hub `handleAgentMessage` (`ws/agent.ts:44`) calls `broadcastToSubscribers(sessionId, ...)` (`ws/registry.ts:59`) → every browser subscribed to the session receives the activity event.
9. On `result` event, runner emits final `assistant_message`; hub persists via `insertMessage` and broadcasts `{type:"message", ...}` so the UI swaps the streaming buffer for the saved record.

### Session Resume Flow

1. Agent starts in a project directory, sends `{type:"auth", api_key, project_dir, hostname}`.
2. Hub hashes the API key (SHA-256 via `hashToken`), `verifyApiKey` returns `user_id`.
3. `findOrCreateAgentSession(userId, projectDir, tokenHash)` (`db/dal.ts`) — single source of truth for resume: looks up `sessions` row by `(user_id, project_dir)`, returns existing or creates new.
4. If reused, hub `unregisterChannel(sessionId)` to drop any stale socket entry.
5. Hub `registerChannel`, sets status `online`, broadcasts `session_list` to all of the user's browser clients and `session_status` to subscribers.
6. Claude CLI is spawned with `--resume <id>` only if the agent was started with the resume CLI flag (`config.resume` in `agent/src/index.ts`). Conversation memory is otherwise carried entirely by the live Claude process; restart of the agent re-spawns Claude with no resume id unless configured.

### Status / Activity Flow

1. Runner emits `status` events on transitions (`idle | thinking | tool_calling | writing`).
2. Hub maps `idle → online`, anything else → `thinking`, writes to `sessions.status` and broadcasts.
3. Closing the agent socket → hub `setSessionStatus(sessionId, 'offline')` + broadcast.
4. On hub boot, `setOfflineStaleAgentSessions()` (`hub/src/index.ts:184`) marks every session offline because in-memory registries are empty on restart.

**State Management:**
- Durable: PostgreSQL (`users`, `sessions`, `messages`, `api_keys`).
- Ephemeral live routing: in-memory `Map`/`Set` in `ws/registry.ts` (lost on restart, rebuilt as sockets reconnect).
- Conversation memory: lives in the Claude CLI subprocess on the agent host. Not in the hub.

## Key Abstractions

**Session:**
- Purpose: One Claude conversation, scoped by `(user_id, project_dir)`.
- Examples: rows in `sessions` table; `ChannelEntry` in `ws/registry.ts`.
- Pattern: Find-or-create by `project_dir`; one live agent ws per session.

**Channel (agent socket):**
- Purpose: The single live WS through which a session is driven.
- Examples: `channels: Map<sessionId, ChannelEntry>` in `ws/registry.ts`.
- Pattern: `registerChannel` closes any pre-existing socket with code 4003 ("replaced") — one connection per session, last writer wins.

**Subscription (client interest):**
- Purpose: A browser client opts in to receive activity for a set of sessions.
- Examples: `ClientEntry.subscriptions: Set<string>` in `ws/registry.ts`.
- Pattern: `subscribeClient` replaces the set (does not accumulate — M6 fix).

**RunnerEvent:**
- Purpose: Normalised activity event emitted by the runner, wire format shared with hub→browser broadcast.
- Examples: `RunnerEvent` union in `agent/src/claude-runner.ts:5`.
- Pattern: Discriminated union on `type`, validated on hub side via Zod (`ws/agent-protocol.ts`).

**Token:**
- Purpose: Secrets for auth (JWT for users, API keys for agents).
- Examples: `utils/token.ts` `generateToken('remo_')`; SHA-256 hashes stored in DB.
- Pattern: Raw token only ever shown once at issuance; only hash persisted.

## Entry Points

**Hub HTTP/WS server:**
- Location: `hub/src/index.ts`
- Triggers: `bun run dev:hub` or Docker `CMD`.
- Responsibilities: Boot Hono, mount routes, register WS upgrade for `/ws/{agent,client,channel}`, serve `web/dist` SPA.

**Local agent:**
- Location: `agent/src/index.ts`
- Triggers: `npx remo-code-agent` (shell alias `claude-remote`).
- Responsibilities: Pre-flight `claude --version`, load config, connect to hub, spawn Claude after 2s, wire runner↔hub events.

**Browser SPA:**
- Location: `web/src/main.tsx` → `web/src/App.tsx`
- Triggers: User loads page (served by hub static handler).
- Responsibilities: Auth flow, session list, chat panel, activity feed, settings.

## Architectural Constraints

- **Threading:** Single-threaded Bun event loop in both hub and agent. Claude CLI runs as a separate OS process via `Bun.spawn`. No worker threads.
- **Global state:**
  - Hub: `channels` Map and `clients` Set in `ws/registry.ts`; `wsConnectionsPerIp` Map in `hub/src/index.ts`. Module-level singletons.
  - Agent: `hub` and `runner` singletons created at module load in `agent/src/index.ts`.
- **One agent process owns one Claude subprocess.** Multi-project chat requires multiple agent invocations (one per `project_dir`).
- **One channel per session.** Reconnecting agent forcibly displaces the previous socket (`registerChannel` closes existing with code 4003).
- **Hub restart blows away live routing** — sessions show offline until each agent reconnects. Persisted state survives.
- **10 MB WebSocket payload limit** (`maxPayloadLength` in `hub/src/index.ts:159`) — bounds attachment / image data URI size.
- **Per-IP limits:** 100 WS connections per IP (`MAX_WS_CONNECTIONS_PER_IP`), 5s auth timeout, 120 msgs / 10s per agent connection rate limit (`hub/src/ws/agent.ts:10`).
- **Origin check** only enforced on `/ws/client`, not on `/ws/agent` or `/ws/channel` (those use API key).
- **`ANTHROPIC_API_KEY` stripped** from Claude CLI env (`claude-runner.ts:90`) — forces use of the user's OAuth subscription instead of a leaked project key.

## Anti-Patterns

### Persisting activity events

**What happens:** Storing every `thinking` / `text_delta` / `tool_use` event to the `messages` table.
**Why it's wrong:** They are deltas; the `messages` table holds finalized messages only. Storage would explode and replay would double-render.
**Do this instead:** Only `assistant_message` (assembled at `result` time, `claude-runner.ts:364`) and the user's outbound message are persisted by the hub. See `ws/agent.ts:164` and `ws/client.ts`.

### Calling Claude CLI directly from the hub

**What happens:** Spawning `claude` on the server.
**Why it's wrong:** The hub is a multi-tenant relay; spawning Claude per user kills horizontal scaling and breaks the "agent runs locally" model. Claude needs the user's project directory and OAuth credentials, both of which live on the dev machine.
**Do this instead:** All Claude execution happens in `agent/src/claude-runner.ts` on the user's host.

### Broadcasting to all clients

**What happens:** `for (client of clients) ws.send(...)` without filtering.
**Why it's wrong:** Leaks one user's session traffic to other users.
**Do this instead:** Use `broadcastToSubscribers(sessionId, ...)` (filters by `client.subscriptions`) or `broadcastToUser(userId, ...)` (filters by `client.userId`) from `ws/registry.ts`.

### Storing raw tokens

**What happens:** Saving the literal `remo_…` token or API key in the DB.
**Why it's wrong:** DB compromise leaks all live credentials.
**Do this instead:** Hash via `hashToken` (SHA-256, `ws/channel.ts`) before storing. Compare hashes on auth. See `verifyApiKey` in `db/dal.ts`.

### Accumulating subscriptions

**What happens:** `entry.subscriptions.add(sessionId)` on every `subscribe` message.
**Why it's wrong:** Old subscriptions linger, leaking events for sessions the user closed.
**Do this instead:** Replace the set, do not accumulate — see `subscribeClient` in `ws/registry.ts:54` (the "M6 fix").

## Error Handling

**Strategy:** Fail-closed at boundaries, swallow inside hot loops, log everything to stdout.

**Patterns:**
- Hono global `app.onError` returns `{error: 'internal error'}` 500 and logs message only — never leak stack (`hub/src/index.ts:29`).
- WS handlers: malformed JSON → silent return; Zod parse failure → silent return; auth failure → `auth_error` then close with 4001.
- Agent runner: `proc.exited` triggers auto-restart after 3s unless `stop()` was called (which nulls `listener` to prevent loop) — `claude-runner.ts:122`.
- Agent stream reader: per-line `try/catch` skips malformed JSON (`claude-runner.ts:269`).
- Browser: WS reconnect with backoff in `useWebSocket.ts`.

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` with bracketed source tag (`[agent]`, `[runner]`, `[runner:stderr]`, `[error]`, `[startup]`). No structured logger.

**Validation:** Zod schemas at every WS boundary — `hub/src/ws/protocol.ts` (client) and `hub/src/ws/agent-protocol.ts` (agent). REST routes validate per-route inside `hub/src/api/*.ts`.

**Authentication:**
- Browser → hub: JWT in `Authorization: Bearer` (REST) or `{type:"auth", token}` first WS message. Verified via `JWT_SECRET` (`hub/src/auth/jwt.ts`).
- Agent → hub: API key, hashed SHA-256, compared against `api_keys.key_hash` (`hub/src/auth/api-key-middleware.ts`, also re-used inline in `ws/agent.ts:70`).
- Plugin/channel: API key (legacy path).

**Authorization:** All DAL queries take `user_id` and include explicit `WHERE user_id = $1`. Sessions and messages are never queried without user scoping.

**Rate limiting:** Per-route middleware `hub/src/middleware/rate-limit.ts` (keyed by userId or auth prefix); per-WS message counters in each WS handler.

**Security headers:** CSP, HSTS, X-Frame-Options DENY, Permissions-Policy, Referrer-Policy set in a Hono middleware in `hub/src/index.ts:35`.

**Theming:** CSS custom properties (`--bg-primary`, `--text-primary`, …) in `web/src/index.css`, toggled by `useTheme.ts`.

**Scheduled Tasks subsystem:** Cron-driven dispatcher under `hub/src/scheduler/` (added 2026-05). Croner-backed `Map<task_id, Cron>` registry; dispatcher resolves `target_kind` to sockets via the same `ws/registry.ts` + `ws/supervisor-registry.ts` used by the live chat path; per-session FIFO with 1 in-flight + 1 waiter; 10-min offline grace replay on reconnect; daily cost cap enforced via `sumTodayCostForUser` at fire time. Post-run action framework (`post-run/`) is a separate dispatcher with its own Zod schema, cycle detector (DFS), template renderer, and fan-out aggregator. See `docs/scheduled-tasks.md`.

---

*Architecture analysis: 2026-05-22 (scheduled-tasks subsystem added 2026-05-24)*

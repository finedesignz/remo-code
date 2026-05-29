<!-- refreshed: 2026-05-28 -->
# Architecture

**Analysis Date:** 2026-05-28

## System Overview

```text
┌──────────────────────────────────────────────────────────────────────────┐
│  Browser SPA (web/, React 19 + Vite + Tailwind 4, hash-router)           │
│                                                                          │
│  3 top-level routes (Phase 12):                                          │
│    #/         Home     → Tabs: List | Grid                               │
│    #/tasks    Tasks    → Tabs: Upcoming | Activity | Schedule            │
│    #/settings Settings → Tabs: Connections | Credentials | Prompts |     │
│                                  Usage | Profile                          │
│                                                                          │
│  Mobile:  PWA + Capacitor wrapper (mobile/), MobileAccordion surface     │
└────────────────────┬──────────────────────────────┬──────────────────────┘
                     │ REST /api/*                  │ WS /ws/client
                     │ (cookie session OR JWT)      │ (jwt OR session cookie)
                     ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  Hub (hub/, Bun + Hono, port 3040, single process)                       │
│  `hub/src/index.ts` — composition root                                   │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ HTTP/REST: api/*                                                  │    │
│  │  auth, profile, account, sessions, messages, api-keys,            │    │
│  │  scheduled-tasks, scheduled-task-runs,                            │    │
│  │  sentry-intake (public), errors, error-projects, error-runs,      │    │
│  │  error-setup, coolify-webhook (public), webhooks-titanium (pub),  │    │
│  │  revanote-webhook (public), revanote-mappings, revanote-annot.,   │    │
│  │  telegram-webhook (public), telegram, chat-tabs, instructions,    │    │
│  │  supervisors, github, transcribe, commands, tasks, usage,         │    │
│  │  orchestrator, plugin, setup, admin, well-known, _openapi         │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ WebSocket:  /ws/client (browser)   /ws/agent (supervisor)         │    │
│  │  ws/client.ts, ws/agent.ts, ws/registry.ts,                       │    │
│  │  ws/supervisor-registry.ts, ws/send-dedupe.ts,                    │    │
│  │  ws/idle-teardown.ts, ws/protocol.ts (Zod schemas)                │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Subsystems                                                        │    │
│  │  scheduler/   — croner-driven dispatch + post-run actions         │    │
│  │  error-capture/ — Sentry intake → fingerprint → dispatch          │    │
│  │  revanote/    — annotations webhook → diff sandbox → CI gate      │    │
│  │  telegram/    — bridge, link codes, dispatch, doctor              │    │
│  │  orchestrator/ — multi-session orchestration + orphan resume      │    │
│  │  usage/       — Anthropic quota snapshot + threshold gating       │    │
│  │  sessions/    — budget + routing helpers                          │    │
│  │  events/      — internal EventEmitter (assistant_message:final)   │    │
│  │  auth/        — middleware, JWT, password (legacy), reauth, admin │    │
│  │  license-gate.ts — Titanium license_status gate                   │    │
│  │  titanium-client.ts — JWKS verifier + license validate            │    │
│  └──────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐    │
│  │ Data: PostgreSQL (Coolify-hosted)                                 │    │
│  │  db/postgres.ts (postgres.js client), db/schema.sql,              │    │
│  │  db/migrate.ts, db/dal.ts + per-domain DALs                       │    │
│  └──────────────────────────────────────────────────────────────────┘    │
└────────────────────┬───────────────────────────────┬─────────────────────┘
                     │ WS /ws/agent                  │ outbound HTTP
                     │ (api_key + project_dir)       │ (Titanium, Coolify,
                     ▼                               │  GitHub gateway,
┌─────────────────────────────────────────────┐     │  emails4agents,
│ Supervisor (supervisor/, Tauri tray app)    │     │  Telegram, KIE)
│  supervisor/src/index.ts — Bun runtime,     │     │
│  compiled to sidecar binary by Tauri.       │     ▼
│  supervisor/tauri/src-tauri/ — Rust shell.  │    External APIs
│  supervisor/tauri/ui/ — React settings UI.  │
│                                              │
│  One per dev host. Connects /ws/agent,        │
│  spawns CLIs lazily per session.              │
└────────────────────┬─────────────────────────┘
                     │ stdio JSON
                     ▼
┌─────────────────────────────────────────────┐
│ CLIs (one persistent process per session)   │
│  Claude Code: claude --input-format          │
│    stream-json --output-format stream-json   │
│    --verbose   (supervisor/src/runners/      │
│                 claude-runner.ts)            │
│  Codex (spike): codex app-server JSON-RPC    │
└─────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Hub HTTP root | App composition, middleware order, WS upgrades | `hub/src/index.ts` |
| Hub WS — client | Browser session, subscribe set ≤12, broadcast routing | `hub/src/ws/client.ts` |
| Hub WS — agent | Supervisor auth, stream-json relay, message persistence | `hub/src/ws/agent.ts` |
| Hub WS protocols | Zod schemas for inbound/outbound messages | `hub/src/ws/protocol.ts`, `agent-protocol.ts`, `supervisor-protocol.ts` |
| Auth middleware | Dual-auth (cookie + legacy JWT) | `hub/src/auth/middleware.ts` |
| License gate | Per-route license_status check w/ exclusion list | `hub/src/license-gate.ts` |
| Titanium client | JWKS-cached EdDSA verify + license validate | `hub/src/titanium-client.ts` |
| Scheduler dispatcher | Croner trigger → cost cap → fan-out → sender | `hub/src/scheduler/dispatcher.ts` |
| Scheduler senders | agent / supervisor / coolify / triage transports | `hub/src/scheduler/senders/*.ts` |
| Post-run actions | email / telegram / webpush / webhook / github-issue | `hub/src/scheduler/post-run/*.ts` |
| Error capture intake | Public Sentry envelope endpoint | `hub/src/api/sentry-intake.ts` |
| Error capture pipeline | auth → envelope → fingerprint → record → dispatch | `hub/src/error-capture/*.ts` |
| Revanote intake | Public annotations webhook | `hub/src/api/revanote-webhook.ts` |
| Revanote pipeline | dispatch → sandbox → CI gate → merge gate → callback | `hub/src/revanote/*.ts` |
| Telegram bridge | Outbound `assistant_message:final` → Telegram chat | `hub/src/telegram/bridge.ts` |
| Coolify webhook | URL-token + legacy HMAC, triage on failure | `hub/src/api/coolify-webhook.ts` |
| Supervisor runtime | WS to hub, spawn CLI per session, relay events | `supervisor/src/index.ts`, `hub-client.ts`, `runners/*.ts` |
| Tauri shell | Tray icon, MSI installer, sidecar lifecycle | `supervisor/tauri/src-tauri/src/*.rs` |
| Web app root | Hash router, auth state, page mounting | `web/src/App.tsx` |
| AppShell | Header + nav + footer scaffold (Phase 12) | `web/src/components/ui/AppShell.tsx` |
| Nav helpers | Active route + tab param parsing | `web/src/lib/ui/nav.ts` |

## Pattern Overview

**Overall:** layered monolith hub (Hono) + thin desktop sidecar (Tauri+Bun) + SPA (React). Hub is the only network service; supervisor and web both speak to it via WS+REST.

**Key Characteristics:**
- Single-binary hub; all subsystems live in one Bun process and share a Postgres pool.
- WebSocket-first for real-time (no polling, no SSE for hub→browser activity).
- Public, unauthenticated webhook intakes (Sentry, Coolify, Revanote, Telegram, Titanium) are mounted OUTSIDE the `/api/*` JWT catch-all; each owns its own credential model.
- Stream-json subprocess is the universal CLI transport; Codex spike maps JSON-RPC notifications onto the same `RunnerEvent` union as Claude.
- Per-session in-memory state (`streamingBySession`, `session-queue`) backed by Postgres flushes.

## Layers

**`web/` (presentation):**
- Purpose: SPA delivered to browser/PWA.
- Location: `web/src/`
- Pages under `web/src/pages/`, primitives under `web/src/components/ui/`, feature components under `web/src/components/`, hooks under `web/src/hooks/`, helpers under `web/src/lib/`.
- Depends on: hub REST + WS only.

**`hub/api/` (HTTP):**
- Purpose: REST endpoints, OpenAPI surface.
- Location: `hub/src/api/`
- Mounted in `hub/src/index.ts`; public webhooks mounted BEFORE auth, license-gated routes mounted AFTER `requireActiveLicense`.

**`hub/ws/` (real-time):**
- Purpose: bidirectional WS for browser and supervisor.
- Location: `hub/src/ws/`
- Owns subscribe set, per-conn rate limiting, broadcast registry.

**`hub/{scheduler,error-capture,revanote,telegram,orchestrator,usage,sessions}/` (domain):**
- Purpose: subsystem logic. Each owns its own DAL slice and prompt/template files.
- Depends on: db, ws/registry, events, lib helpers.

**`hub/db/` (data):**
- Purpose: Postgres access. Per-subsystem DAL files all import the shared `sql` from `db/postgres.ts`.
- Schema: `hub/src/db/schema.sql` — idempotent `CREATE TABLE IF NOT EXISTS`, applied by `db/migrate.ts` on boot.

**`supervisor/` (host runtime):**
- Purpose: spawns + relays CLIs.
- Bun source under `supervisor/src/`, Rust+Tauri shell under `supervisor/tauri/src-tauri/`, settings UI under `supervisor/tauri/ui/`.

## Data Flow

### Magic-link login (Phase 07)

1. Browser POST `/api/auth/login/request-link` with email (`hub/src/api/auth.ts`) — rate-limited 3/min/IP + 5/hr/email, silent.
2. Hub asks Titanium for a magic-link JWT; emails the link via emails4agents.
3. User clicks → `#/auth/callback?token=…` → SPA POST `/api/auth/callback`.
4. Hub verifies JWT via `titanium-client.ts` (JWKS-cached EdDSA), links/promotes the user row (`dal.ts`), creates opaque session in `auth_sessions` (`session.ts`), sets cookie + CSRF pair (`csrf.ts`).
5. SPA reloads, `useAuth` reads cookie, `useLicense` polls `/api/profile/license` every 5 min.

### Session start + message round-trip

1. Supervisor opens `/ws/agent`, sends `{type:'auth', api_key, project_dir, hostname, rootless_sessions, agent_info}` (`supervisor/src/hub-client.ts` → `hub/src/ws/agent.ts`).
2. Hub verifies api_key (sha-256 hash in `api_keys`), calls `findOrCreateAgentSessionV2` / `findOrCreateRootlessSession`, sends `auth_ok` with `seed_files` (instructions sync).
3. Browser opens `/ws/client`, authenticates via cookie or JWT, sends `subscribe` with up to 12 session_ids.
4. Browser POSTs `/api/messages` or sends WS `send_message` (`hub/src/ws/client.ts`).
5. Hub `insertMessage`, broadcasts to subscribers, ships `user_message` down `/ws/agent`.
6. Supervisor writes JSON to CLI stdin; CLI emits stream-json events.
7. Supervisor relays `thinking` / `text_delta` / `tool_use` / `tool_result` / `assistant_message` → hub → browser.
8. Hub coalesces deltas into a single message row (`streamingBySession` + `appendToMessage`), finalizes on `assistant_message`, emits `assistant_message:final` on the internal event bus (`hub/src/events/assistant-events.ts`).

### Scheduled task dispatch

1. Croner ticker in `hub/src/scheduler/dispatcher.ts` fires from registry (`registry.ts`).
2. `enforceCostCap` checks daily quota; `targets.ts` resolves `target_kind` (session / supervisor / coolify / all).
3. Sender chosen: `senders/agent.ts` (CLI prompt with `Summary:` directive), `senders/supervisor.ts` (supervisor command), `senders/coolify.ts` (log_check), `senders/triage.ts` (coolify-webhook synth).
4. Run row inserted, sent through `session-queue.ts` (1 in-flight + 1 waiter per session).
5. On `assistant_message:final`, finalize run row; post-run dispatcher fires email / telegram / webpush / webhook / github-issue actions.
6. Offline supervisor → `grace.ts` buffers up to 10 min, replays via `catchup.ts` on reconnect.

### Error capture intake

1. App SDK POSTs envelope to `/api/sentry/:project_id/envelope/` (`hub/src/api/sentry-intake.ts`) — OUTSIDE `/api/*` JWT scope.
2. `error-capture/auth.ts` parses `X-Sentry-Auth`, looks up `error_projects.sentry_key`.
3. `envelope.ts` gunzips multi-line JSON; `fingerprint.ts` sha-256 of project + type + value + top-3 frames.
4. `record.ts` applies 3 gates: dedupe (60s) → rate-limit (20/hr) → daily cap (50).
5. `notify.ts` throttled silent-skip emails (via emails4agents) when gates trip.
6. On pass, `dispatcher.ts` claims session via `scheduler/session-queue.ts`, builds prompt (`prompt.ts`), ships to `/ws/agent`.
7. `run-lifecycle.ts` finalizes on next `assistant_message`; offline → `grace.ts` 10-min buffer.

### Revanote dispatch (Phase 08)

1. Browser-extension annotation POSTs `/api/revanote/webhook` (`hub/src/api/revanote-webhook.ts`).
2. `revanote/dispatcher.ts` resolves mapping (host → repo/session) via `revanote-dal.ts`, gates on per-user daily cost + per-source budget.
3. Prompt rendered (`prompt.ts`), sandboxed if needed (`diff-sandbox.ts`, `sandbox.ts`), risk-classified (`risk-classifier.ts`).
4. Dispatched via `session-queue.ts`; CI gate (`ci-gate.ts`) + merge gate (`merge-gate.ts`) + deploy policy (`deploy-policy.ts`) enforced.
5. `callback.ts` POSTs result back to revanote; `notify-pr.ts` adds PR comment.

### Coolify webhook triage (Phase 06)

1. Coolify POSTs `/api/coolify/webhook/:user_id/:token` (or legacy HMAC route) — `hub/src/api/coolify-webhook.ts`.
2. IP allowlist (`lib/cidr.ts`) → Zod validate → audit row in `coolify_webhook_attempts`.
3. On `deployment.failed`, `triage` task synthesized through scheduler; result parsed by `triage-schema.ts`.
4. `post-run/github-issue.ts` opens issue (24h idempotency via `github_issue_idempotency`), credentials from gateway pair.

### Telegram chat bridge (Phase 12 W3)

1. Inbound: Telegram POSTs `/api/telegram/webhook` → `telegram/commands.ts` (link, switch, status) or `telegram/dispatch.ts` (free text → session).
2. Outbound: `telegram/bridge.ts` subscribes to `assistant_message:final`, per-chat serialized `Map<chatId, Promise>` to respect Telegram 1 msg/sec.
3. Bridge is feature-gated on `config.telegram.botToken`; no-op when unset.

## Key Abstractions

**`CliRunner` (supervisor):**
- Purpose: uniform interface over Claude Code + Codex CLIs.
- Location: `supervisor/src/runners/types.ts`, implementations in `claude-runner.ts`, `session-bridge.ts`.
- Emits a normalized `RunnerEvent` union consumed by the hub.

**`session-queue` (hub):**
- Purpose: 1 in-flight + 1 waiter per session_id; reused by scheduler + error-capture + revanote.
- Location: `hub/src/scheduler/session-queue.ts`.

**Internal event bus:**
- Purpose: decouple WS finalization from downstream consumers (telegram bridge, run-lifecycle, post-run).
- Location: `hub/src/events/assistant-events.ts` — only fires on FINAL `assistant_message`, never streaming.

**AppShell + Tabs primitives:**
- Purpose: shared frame for all 3 top-level web routes.
- Location: `web/src/components/ui/AppShell.tsx`, `Tabs.tsx`, `HeaderRight.tsx`, `ErrorBoundary.tsx`.

## Entry Points

**Hub:**
- `hub/src/index.ts` — `Bun.serve` with Hono `app`, WS upgrade for `/ws/client` and `/ws/agent`. Runs migrations + scheduler boot + grace sweepers in same process.

**Web:**
- `web/src/main.tsx` → `web/src/App.tsx` — hash router, routes: `home | tasks | settings | privacy | terms | login | auth-callback | dev-chat-surface | dev-mobile-accordion`.

**Supervisor:**
- `supervisor/src/index.ts` — CLI with `run` / `scan` / `help` subcommands; `run` is what the Tauri sidecar invokes.
- `supervisor/tauri/src-tauri/src/main.rs` → `lib.rs` — Tauri app, tray, sidecar lifecycle, first-run wizard.

## Architectural Constraints

- **Single Bun event loop on the hub.** All subsystems share one process — no worker threads. CPU-heavy work (fingerprint, envelope gunzip) must stay sub-millisecond per request.
- **Hash router on web.** SPA fallback serves `index.html` for any pathname; `App.tsx` normalizes pathname to `/` on boot. Legacy hash redirects (`#/schedules`, `#/error-capture`, `#/revanote`, `#/supervisor`, `#/grid/:id`) are kept FOREVER — scheduled-task email links depend on them.
- **Subscribe set capped at 12.** `hub/src/ws/protocol.ts` `SUBSCRIBE_MAX = 12`; violations get `subscribe_error`. Grid view enforces same cap UI-side.
- **Cost cap is the universal fan-out gate.** All dispatch paths (scheduler, error-capture, revanote, coolify triage) flow through `scheduler/dispatcher.ts` `enforceCostCap`. No bypass paths.
- **Webhooks live outside `/api/*`.** Public intakes mount before the JWT catch-all in `hub/src/index.ts` and read raw body BEFORE JSON parse (HMAC needs bytes).
- **`SESSION_SECRET` is never rotated routinely.** Rotation logs out every Titanium-cookie user. D14 rotates `JWT_SECRET` instead.
- **`/api/profile/license` is auth-gated, never license-gated** (circular dep). Same exclusion for `/api/auth/*`, `/healthz`, public webhooks, `/ws/agent`.
- **Streaming throttle is web-side only.** Hub-side throttling would break scheduler event ordering. ChatSurface RAF-coalesces deltas.

## Anti-Patterns

### Mounting a license-gated route inside the webhook exclusion list

**What happens:** New webhook added under `/api/*` and forgotten in the exclusion list.
**Why it's wrong:** Third-party (Coolify, Sentry, Telegram) cannot send a cookie or JWT — license gate 402s the webhook and dispatches die silently.
**Do this instead:** mount the webhook route OUTSIDE `/api/*` (e.g. `/api/coolify/webhook/...` is added to the gate's exclusion array in `hub/src/license-gate.ts`).

### Throttling stream events server-side

**What happens:** Coalescing `text_delta` events in the hub to reduce browser load.
**Why it's wrong:** Breaks scheduler `assistant_message:final` ordering and the run-lifecycle finalize.
**Do this instead:** RAF-coalesce in `web/src/components/ChatSurface.tsx` using a ref accumulator.

### Reading req.json() before HMAC verify

**What happens:** Hono `c.req.json()` consumes the body; HMAC over a re-serialized body mismatches.
**Why it's wrong:** All signed webhooks (Coolify, Titanium, Sentry envelopes) fail signature verification.
**Do this instead:** call `c.req.raw.text()` (or arrayBuffer) FIRST, verify, then `JSON.parse`.

### New env var per third-party API

**What happens:** Adding `GITHUB_TOKEN`, `STRIPE_KEY`, etc. directly to hub env.
**Why it's wrong:** Violates the gateway-pair architecture (global rule).
**Do this instead:** fetch via `GATEWAY_URL` / `GATEWAY_API_KEY` (see `scheduler/post-run/github-issue.ts`).

## Error Handling

**Strategy:** never leak internals to clients.

**Patterns:**
- Global Hono handler in `hub/src/index.ts` returns `{error: 'internal error'}` 500.
- Webhooks return generic 200 on dedupe/skip to avoid revealing project state.
- Post-run action failures are log-only — never fail the parent run.
- WS auth failures close with a generic code after 5s timeout, no detail.

## Cross-Cutting Concerns

**Logging:** `console.log` / `console.error` with bracketed tags (`[agent]`, `[scheduler]`, etc.). Supervisor tees to file with 5MB rotation (`supervisor/src/index.ts` `setupFileLogging`).
**Validation:** Zod schemas at every boundary (WS protocols, scheduler payloads, post-run actions, triage result, revanote payload).
**Auth:** dual-mode middleware (cookie + legacy bearer) gated by `ALLOW_LEGACY_LOGIN`; api-key middleware for `/ws/agent`.
**Security headers:** `securityHeaders()` mounted first in `hub/src/index.ts` — HSTS 2yr+preload, CSP, COOP/CORP, Permissions-Policy.
**Rate limits:** per-IP WS connection cap 20, per-conn message rate, per-route REST rate-limit middleware (`hub/src/middleware/rate-limit.ts`).
**OpenAPI:** spec assembled in `hub/src/api/_openapi.ts`; CI `.github/workflows/docs-drift.yml` enforces.

---

*Architecture analysis: 2026-05-28*

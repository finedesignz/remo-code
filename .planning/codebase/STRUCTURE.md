# Codebase Structure

**Analysis Date:** 2026-05-28

> **Milestone v-settings-overhaul (2026-05-30):** Settings is now **4 tabs** — Connections · Credentials · Usage · Profile. `PromptsTab` and `OrchestratorTab` (plus `CommandsList`/`useCommands`/instruction blobs and the Profile Telegram card) are **deleted**; the orchestrator is a pinned top row in the Connections table and root-folder setup moved to the supervisor first-run wizard. App accent migrated **indigo→blue** (orange = CTA-only). New schema: `sessions.auto_nudge` (per-session override) + `user_grid_state` (active tab+cell). Default session falls back to the orchestrator.
> **Phase 12 (2026-05-28):** Web UI reorganized into 3 top-level pages (Home / Tasks / Settings) with tabs. New primitives live under `web/src/components/ui/`. Settings tabs live under `web/src/pages/settings/`, Tasks tabs under `web/src/pages/tasks/`.
> **Phase 09 (2026-05-26):** The legacy `agent/` workspace and `channel/` plugin are retired. The local CLI runner lives in `supervisor/src/` and ships exclusively as a Tauri MSI desktop app. References to `agent/`, `npx remo-code-agent`, `claude-remote`, or `/ws/channel` are historical.

## Monorepo Layout

Bun workspace (`package.json` `workspaces: ["hub", "web", "supervisor", "supervisor/tauri/ui"]`). Single `bun.lock` at the root; each workspace has its own `package.json`.

## Directory Layout

```
remo-code/
├── hub/                      # Backend: Bun + Hono server (port 3040)
│   ├── src/
│   │   ├── index.ts          # Composition root: Hono app, WS upgrades, boot
│   │   ├── config.ts         # Typed env parse (fatal on missing required)
│   │   ├── api/              # REST routes (one file per resource)
│   │   ├── ws/               # WebSocket handlers + Zod protocols + registry
│   │   ├── auth/             # Middleware, JWT, password, reauth, admin, github-app
│   │   ├── db/               # postgres.js client, schema.sql, migrate, per-domain DALs
│   │   ├── scheduler/        # Croner dispatch, senders, post-run actions, prompts
│   │   ├── error-capture/    # Sentry intake pipeline + auto-install
│   │   ├── revanote/         # Browser-annotation pipeline (Phase 08)
│   │   ├── telegram/         # Inbound webhook + outbound bridge (Phase 12 W3)
│   │   ├── orchestrator/     # Multi-session orchestration + orphan resume
│   │   ├── usage/            # Anthropic quota snapshot + threshold gating
│   │   ├── sessions/         # Budget + routing helpers
│   │   ├── events/           # Internal EventEmitter (assistant_message:final)
│   │   ├── dispatch/         # Shared session-dispatch pipeline (pipeline/session-queue/grace/gates) — foundation, unwired
│   │   ├── webhooks/         # Shared public-webhook auth-gate (intake.ts) — foundation, unwired
│   │   ├── middleware/       # Rate limit, security headers
│   │   ├── lib/              # Crypto, CIDR, email, github helpers, repo-key
│   │   ├── utils/            # Token gen + other small helpers
│   │   ├── csrf.ts           # Double-submit CSRF check
│   │   ├── session.ts        # Opaque cookie sessions
│   │   ├── license-gate.ts   # Titanium license_status middleware
│   │   └── titanium-client.ts# Keygen JWKS verify + license validate
│   ├── test/                 # Bun test runner; *.test.ts files
│   ├── scripts/              # dump-openapi.ts, migrate-users-to-titanium.ts
│   ├── package.json          # `bun run dev`, `bun run docs:dump`
│   └── tsconfig.json
│
├── web/                      # Frontend: React 19 + Vite + Tailwind 4 SPA
│   ├── src/
│   │   ├── main.tsx          # Vite entry
│   │   ├── App.tsx           # Hash-router (Home/Tasks/Settings + legacy redirects)
│   │   ├── pages/            # Top-level pages
│   │   │   ├── HomePage.tsx           # Tabs: List | Grid
│   │   │   ├── TasksPage.tsx          # Tabs: Upcoming | Activity | Schedule
│   │   │   ├── SettingsPage.tsx       # Tabs: Connections|Credentials|Usage|Profile
│   │   │   ├── Login.tsx, AuthCallback.tsx, Privacy.tsx, Terms.tsx
│   │   │   ├── settings/              # 4 tab modules (Prompts+Orchestrator removed: v-settings-overhaul)
│   │   │   │   ├── ConnectionsTab.tsx  # orchestrator = pinned top row; roots moved to supervisor wizard
│   │   │   │   ├── CredentialsTab.tsx
│   │   │   │   ├── UsageTab.tsx
│   │   │   │   └── ProfileTab.tsx       # no Telegram card; default session = orchestrator
│   │   │   └── tasks/                 # 3 tab modules
│   │   │       ├── UpcomingTab.tsx
│   │   │       ├── ActivityTab.tsx
│   │   │       └── ScheduleTab.tsx
│   │   ├── components/
│   │   │   ├── ui/           # Phase 12 primitives (shared across pages)
│   │   │   │   ├── AppShell.tsx      # header + main + footer scaffold
│   │   │   │   ├── Tabs.tsx          # tab nav for pages
│   │   │   │   ├── HeaderRight.tsx   # theme + profile menu slot
│   │   │   │   ├── ErrorBoundary.tsx
│   │   │   │   ├── Button.tsx, Card.tsx, Drawer.tsx, Modal.tsx,
│   │   │   │   ├── Field.tsx, EmptyState.tsx, LoadingState.tsx,
│   │   │   │   ├── StatusPill.tsx
│   │   │   │   └── index.ts          # barrel
│   │   │   └── (feature components)  # ChatSurface, GridPage, MobileAccordion,
│   │   │                             # MessageBubble, ThinkingBlock, ToolUseBlock,
│   │   │                             # CronBuilder, ScheduleEditor, etc.
│   │   ├── hooks/            # useAuth, useChat, useSessions, useLicense, etc.
│   │   ├── lib/              # api, auth, cron, format, push, raf-batch,
│   │   │   ├── ui/           #   cn, focus-trap, nav (top-route + tab helpers)
│   │   │   └── *.test.ts     # web vitest tests live next to source
│   │   ├── index.css         # Tailwind 4 + design tokens (--bg-primary etc.)
│   │   └── vite-env.d.ts
│   ├── public/
│   ├── index.html
│   ├── package.json          # `bun run dev`, `bun run build`
│   ├── vite.config.ts
│   └── tsconfig.json
│
├── supervisor/               # Local desktop tray app (Tauri MSI on Windows)
│   ├── src/                  # Bun TypeScript runtime (compiled to sidecar binary)
│   │   ├── index.ts          # CLI entry: run | scan | help
│   │   ├── config.ts         # %LOCALAPPDATA%\remo-code-supervisor\config.json
│   │   ├── hub-client.ts     # /ws/agent connection
│   │   ├── process-manager.ts# CLI subprocess lifecycle
│   │   ├── runners/          # Claude + Codex + bridge
│   │   │   ├── types.ts                # CliRunner interface + RunnerEvent union
│   │   │   ├── claude-runner.ts        # claude --input-format stream-json
│   │   │   └── session-bridge.ts
│   │   ├── repo-scanner.ts   # Discover repos under configured roots
│   │   ├── commands-scanner.ts, builtins.ts, commands/  # Supervisor commands
│   │   ├── git-introspect.ts, git-ops.ts                # Git helpers
│   │   ├── sandbox.ts, audit.ts                         # Safety
│   │   └── config.ts
│   ├── tauri/                # Rust shell + settings UI
│   │   ├── src-tauri/        # Rust Tauri 2 app
│   │   │   ├── src/
│   │   │   │   ├── main.rs, lib.rs              # entry
│   │   │   │   ├── tray.rs                       # tray icon + menu
│   │   │   │   ├── sidecar.rs                    # spawn + manage bun binary
│   │   │   │   ├── first_run.rs                  # API key wizard
│   │   │   │   ├── config_cmds.rs, runtime_cmds.rs # Tauri commands
│   │   │   │   ├── nssm.rs, mutex_probe.rs, legacy_cleanup.rs
│   │   │   ├── icons/        # tray.png + state icons (idle/running/crashed)
│   │   │   ├── capabilities/default.json
│   │   │   ├── tauri.conf.json
│   │   │   ├── build.rs
│   │   │   ├── Cargo.toml, Cargo.lock
│   │   ├── ui/               # React settings window (Vite)
│   │   │   ├── src/
│   │   │   │   ├── main.tsx, App.tsx
│   │   │   │   ├── pages/    # GeneralPage, FoldersPage, SecurityPage
│   │   │   │   ├── components/RootsPanel.tsx
│   │   │   │   ├── lib/autoUpdater.ts
│   │   │   │   └── UpdateNotifier.tsx
│   │   │   ├── index.html, vite.config.ts, package.json
│   │   ├── scripts/build-and-update.ps1
│   │   ├── README.md, UPDATER-SETUP.md
│   ├── test/                 # Bun tests (repo-scanner, git-introspect, etc.)
│   ├── package.json
│   └── tsconfig.json
│
├── mobile/                   # Capacitor wrapper for iOS/Android (mobile PWA)
│
├── docs/                     # Per-app docs (rule #21 contract)
│   ├── api.md                # Generated from openapi.json (committed)
│   ├── openapi.json          # Generated by hub/scripts/dump-openapi.ts
│   ├── auth.md               # Phase 07 Titanium cutover architecture
│   ├── scheduled-tasks.md    # Scheduler + post-run + Coolify webhook architecture
│   ├── error-capture.md      # Sentry intake pipeline
│   ├── grid-view.md          # Multichat grid view
│   ├── codex-and-rootless.md # Phase 05 Codex CLI + rootless sessions
│   ├── revanote.md           # Phase 08 browser annotations
│   ├── telegram-bridge.md    # Phase 12 W3 outbound bridge
│   ├── coolify-webhook-migration.md
│   ├── self-heal-integration.md
│   ├── github-session-keying.md
│   ├── mobile-client.md
│   ├── HANDOFF.md
│   └── superpowers/          # Historical specs + plans
│
├── .planning/                # GSD planning artifacts
│   ├── codebase/             # This map (ARCHITECTURE, STRUCTURE, STACK, etc.)
│   ├── phases/               # Per-phase plan + execution docs
│   ├── debug/                # Triage notes (active + resolved/)
│   └── docs-standardization-plan.md
│
├── supabase/                 # Historical Supabase migrations (deprecated 2026-05-24)
├── .github/                  # CI workflows (docs-drift, release-supervisor)
├── Dockerfile                # Multi-stage build: deps → web build → prod image
├── README.md
├── CLAUDE.md                 # Per-repo instructions
├── package.json              # Bun workspaces root
├── bun.lock
└── .env.example
```

## Directory Purposes

**`hub/`:**
- Purpose: only network-facing service. REST + WS + Postgres.
- Entry: `hub/src/index.ts`.
- New REST route → add file in `hub/src/api/`, mount in `index.ts`. Add OpenAPI in `api/_openapi.ts` and delete plain twin.
- New WS event → extend Zod in `hub/src/ws/protocol.ts` (browser) or `agent-protocol.ts` (supervisor), then implement in `client.ts`/`agent.ts`.

**`web/`:**
- Purpose: SPA delivered by hub static serving in prod.
- Entry: `web/src/main.tsx` → `App.tsx` (hash router).
- New page → add file in `web/src/pages/`, wire route in `App.tsx`, use `AppShell` + `Tabs` from `components/ui/`.
- New feature component → `web/src/components/`. Shared primitives → `web/src/components/ui/`.

**`supervisor/src/`:**
- Purpose: Bun TypeScript runtime, compiled by Tauri build into a single sidecar binary.
- New CLI runner → implement `CliRunner` from `runners/types.ts`, register in `process-manager.ts`.

**`supervisor/tauri/`:**
- Purpose: Rust shell (tray + MSI) + Vite settings UI.
- New settings page → `tauri/ui/src/pages/`. New Tauri command → `tauri/src-tauri/src/*_cmds.rs` and register in `lib.rs`.

**`docs/`:**
- Purpose: per-app contract docs (rule #21). `openapi.json` and `api.md` are GENERATED — never hand-edit.
- New subsystem doc → add `docs/<topic>.md` and reference it in `CLAUDE.md`.

**`.planning/`:**
- Purpose: GSD workflow artifacts. Per-phase plans live under `.planning/phases/<NN>-<slug>/`.
- Codebase maps in `.planning/codebase/` are regenerated by `/gsd:map-codebase`.

## Key File Locations

**Entry Points:**
- `hub/src/index.ts`: Hub HTTP + WS server.
- `web/src/main.tsx` → `App.tsx`: SPA root.
- `supervisor/src/index.ts`: Supervisor Bun CLI.
- `supervisor/tauri/src-tauri/src/main.rs`: Tauri shell.

**Configuration:**
- `hub/src/config.ts`: typed env parse for the hub.
- `supervisor/src/config.ts`: typed config for supervisor; persists to `%LOCALAPPDATA%\remo-code-supervisor\config.json`.
- `.env.example`: required env vars for the hub.
- `Dockerfile`: prod image.

**Core Logic:**
- `hub/src/scheduler/dispatcher.ts`: scheduled-task fan-out + cost gate.
- `hub/src/error-capture/dispatcher.ts`: Sentry-intake dispatch.
- `hub/src/revanote/dispatcher.ts`: revanote dispatch.
- `hub/src/ws/agent.ts`: supervisor channel + stream-json relay.
- `hub/src/ws/client.ts`: browser channel + subscribe routing.
- `supervisor/src/runners/claude-runner.ts`: Claude CLI spawn + stdio parse.

**Database:**
- `hub/src/db/schema.sql`: idempotent schema, applied by `db/migrate.ts` on boot.
- `hub/src/db/dal.ts`: shared user/session/message DAL.
- `hub/src/db/{chat-tabs,error-capture,orchestrator,revanote,scheduled-tasks,supervisor}-dal.ts`: per-domain.

**Testing:**
- `hub/test/*.test.ts`: Bun test runner.
- `supervisor/test/*.test.ts`: Bun test runner.
- `web/src/lib/*.test.ts`: vitest (sparse — only `external-link`, `platform` so far).

## Naming Conventions

**Files:**
- TypeScript: kebab-case (`session-queue.ts`, `coolify-webhook.ts`).
- React components: PascalCase `.tsx` (`AppShell.tsx`, `ChatSurface.tsx`).
- Test siblings: `<name>.test.ts`.
- Rust modules: snake_case (`config_cmds.rs`, `mutex_probe.rs`).
- Prompts: `<task_kind>/<step>.md` under `hub/src/scheduler/prompts/`.

**Directories:**
- kebab-case for code dirs (`error-capture`, `scheduled-tasks`).
- Per-domain DALs: `<domain>-dal.ts` under `hub/src/db/`.
- Per-subsystem API files: `<resource>.ts` or `<resource>-<sub>.ts` under `hub/src/api/`.

**Database tables:**
- snake_case plural (`scheduled_tasks`, `error_projects`, `auth_sessions`).
- Per-feature idempotency tables: `<feature>_idempotency`.

## Where to Add New Code

**New REST endpoint:**
- File: `hub/src/api/<resource>.ts` exporting a Hono router.
- Mount: `hub/src/index.ts` (license-gated under `app.use('/api/*', requireActiveLicense)`, OR before it for public webhooks).
- OpenAPI: add `createRoute` in `hub/src/api/_openapi.ts` and delete the plain twin.
- Tests: `hub/test/<resource>.test.ts`.

**New WS message type:**
- Schema: extend the discriminated union in `hub/src/ws/protocol.ts` (browser) or `agent-protocol.ts` (supervisor).
- Handler: `hub/src/ws/client.ts` or `agent.ts`.
- Web consumer: `web/src/hooks/useWebSocket.ts` + relevant feature hook.

**New scheduled task kind:**
- Sender: `hub/src/scheduler/senders/<kind>.ts`.
- Prompts: `hub/src/scheduler/prompts/<kind>/*.md`.
- Registry wire: `hub/src/scheduler/registry.ts`.
- DAL: add columns/tables to `hub/src/db/schema.sql` and helpers to `scheduled-tasks-dal.ts`.
- Update `docs/scheduled-tasks.md` + `hub/test/scheduler.test.ts` in the same commit.

**New post-run action:**
- File: `hub/src/scheduler/post-run/<action>.ts`.
- Schema variant: `hub/src/scheduler/post-run/schema.ts` (discriminated union).
- Wire: `hub/src/scheduler/post-run/dispatcher.ts`.

**New error-capture stack auto-install:**
- Detection: `hub/src/error-capture/setup/detect.ts`.
- Snippet: `hub/src/error-capture/setup/snippet.ts`.
- Optional Coolify env push: `setup/coolify-env.ts`.

**New web page:**
- File: `web/src/pages/<Name>Page.tsx`.
- Route: add to `App.tsx` `getRoute()` and `Route` union.
- Use `AppShell` + `Tabs` from `web/src/components/ui/`.
- Nav: extend `web/src/lib/ui/nav.ts` if it becomes a top-level route.

**New settings or tasks tab:**
- File: `web/src/pages/settings/<Name>Tab.tsx` or `web/src/pages/tasks/<Name>Tab.tsx`.
- Wire into the shell file (`SettingsPage.tsx` / `TasksPage.tsx`) `tab` union + `Tabs` items.

**New shared web primitive:**
- File: `web/src/components/ui/<Name>.tsx`.
- Export from `web/src/components/ui/index.ts` barrel.

**New supervisor CLI runner:**
- File: `supervisor/src/runners/<name>-runner.ts` implementing `CliRunner`.
- Register in `supervisor/src/process-manager.ts`.

**New Tauri command:**
- File: `supervisor/tauri/src-tauri/src/<topic>_cmds.rs`.
- Register in `lib.rs` `invoke_handler`.

**Utilities:**
- Hub helpers: `hub/src/lib/<topic>.ts` (e.g. `cidr.ts`, `repo-key.ts`).
- Web helpers: `web/src/lib/<topic>.ts` (UI helpers under `web/src/lib/ui/`).

## Special Directories

**`hub/src/scheduler/prompts/`:**
- Purpose: markdown prompt templates loaded by `prompts/loader.ts`.
- Generated: No.
- Committed: Yes.

**`docs/openapi.json` + `docs/api.md`:**
- Purpose: generated OpenAPI spec + human-readable companion.
- Generated: Yes (via `bun run docs:sync`).
- Committed: Yes (CI `docs-drift.yml` enforces).

**`supabase/`:**
- Purpose: historical Supabase migrations.
- Generated: No.
- Committed: Yes (deprecated 2026-05-24 — not active).

**`.planning/`:**
- Purpose: GSD plans + codebase maps. Committed per rule #21.
- Generated: partially (codebase maps regenerate via `/gsd:map-codebase`).
- Committed: Yes.

**`supervisor/tauri/src-tauri/target/`** (not in tree):
- Purpose: Rust build output.
- Generated: Yes.
- Committed: No.

---

*Structure analysis: 2026-05-28*

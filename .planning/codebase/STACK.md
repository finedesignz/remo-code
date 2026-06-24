# Technology Stack

**Analysis Date:** 2026-05-28

## Languages

**Primary:**
- TypeScript ~5.7 — hub, web, supervisor sidecar, supervisor UI
- Rust (edition 2021, MSRV 1.77) — Tauri shell (`supervisor/tauri/src-tauri/`)

**Secondary:**
- SQL — `hub/src/db/schema.sql` (Postgres DDL)
- Markdown — `.planning/`, `docs/`, scheduler/revanote prompt templates (`hub/src/scheduler/prompts/**/*.md`, `hub/src/revanote/prompt.ts`)

## Runtime

**Server (hub + supervisor sidecar):**
- Bun 1.x (`oven/bun:1` Docker base; `bun --watch` dev; `bun build --compile` for sidecar)

**Desktop (supervisor):**
- Tauri 2.11.2 (Windows MSI, `windows-latest` CI, MSVC `x86_64-pc-windows-msvc`)
- Sidecar is a single-file `bun build --compile` exe at `tauri/src-tauri/binaries/remo-code-supervisor-x86_64-pc-windows-msvc.exe`

**Web:**
- Browser (modern, ESM); built with Vite 6 → static dist served by hub at `/`

**Package Manager:**
- Bun workspaces — root `package.json` workspaces: `hub`, `web`
- Lockfile: `bun.lock` (frozen-lockfile in Docker + CI)
- `supervisor/` and `supervisor/tauri/ui/` are NOT in workspaces; each has its own `bun install`

## Frameworks

**Hub (Bun + Hono):**
- `hono` ^4.7 — HTTP + WS server, port 3040
- `@hono/zod-openapi` ^0.18 — OpenAPI 3.1 routes (incremental migration)
- `@scalar/hono-api-reference` ^0.10 — `/docs` UI
- `zod` ^3.24 — runtime validation (REST + WS protocols)

**Web (React 19 SPA):**
- `react` / `react-dom` ^19
- `vite` ^6.2, `@vitejs/plugin-react` ^4.4
- `tailwindcss` ^4 + `@tailwindcss/vite` ^4.2 (no PostCSS config — Vite plugin)
- `@tanstack/react-virtual` ^3.13 — message-list virtualization (Grid view)
- `react-markdown` ^9 + `remark-gfm` ^4 + `rehype-sanitize` ^6
- `cronstrue` ^3.14, `croner` ^10 (shared with hub for "next 3 runs" preview)

**Supervisor sidecar (Bun TS):**
- No web framework — raw WebSocket client to hub `/ws/agent`
- Spawns child processes (`claude --input-format stream-json --output-format stream-json --verbose`, `codex app-server`)

**Supervisor Tauri shell (Rust):**
- `tauri` 2.11.2 with `tray-icon`, `image-png`
- Plugins: `single-instance` 2.4, `autostart` 2.5, `global-shortcut` 2.3, `updater` 2.10, `process` 2.3, `shell` 2.3.5, `dialog` 2
- `tokio` (time, sync, rt, macros, process, io-util), `parking_lot`, `dirs` 5, `once_cell`, `windows` 0.58 (Win32_Foundation/Threading/WinSock)
- UI: separate React 19 + Vite + Tailwind 4 app under `supervisor/tauri/ui/`, uses `@tauri-apps/api` ^2.1, plugin bindings (`plugin-dialog`, `plugin-process`, `plugin-updater`), `react-router-dom` ^7.1

## Key Dependencies (hub)

| Package | Version | Purpose |
|---------|---------|---------|
| `postgres` | ^3.4.9 | Postgres client (primary DAL) |
| `pg` | ^8.20 (root devDep) | Migration scripts, tests |
| `ioredis` | ^5.10 | Magic-link JTI replay-protect (required when `TITANIUM_REQUIRE_REDIS=true`) |
| `jose` | ^6.2 | JWKS verification for Titanium Keygen EdDSA license tokens |
| `jsonwebtoken` | ^9.0 | Legacy bearer JWTs (gated by `ALLOW_LEGACY_LOGIN`, removed in Phase 07.5) |
| `bcryptjs` | ^3.0 | Legacy password hashing (Phase 07.5 will delete) |
| `nanoid` | ^5.1 | ID generation |
| `croner` | ^10.0 | Cron scheduler (scheduled tasks, revanote dispatcher) |
| `@octokit/rest` | ^22.0 | GitHub API (issue creation, repo introspection, PR ops) |

## Build / Dev Tooling

| Tool | Purpose |
|------|---------|
| `tsc -b` | Web typecheck before Vite build |
| `vite` ^6.2 | Web + supervisor UI dev/build |
| `bun --watch` | Hub dev hot-reload (`bun run dev:hub`) |
| `bun build --compile` | Compile supervisor sidecar to single Windows exe |
| `cargo tauri build` | MSI build (called via `tauri-action` in CI) |
| `widdershins` 4.0.1 | OpenAPI → `docs/api.md` (npx, no install — `bun run docs:sync`) |

## Configuration

**Hub env (required):**
- `DATABASE_URL`, `JWT_SECRET` (≥32 chars), `PORT` (3040), `HUB_ALLOWED_ORIGINS`

**Hub env (Titanium auth, Phase 07):**
- `TITANIUM_KEYGEN_API_URL`, `TITANIUM_KEYGEN_ACCOUNT_ID`, `TITANIUM_KEYGEN_PRODUCT_ID`, `TITANIUM_KEYGEN_PORTAL_TOKEN`, `TITANIUM_KEYGEN_ADMIN_TOKEN`
- `MAGIC_LINK_SECRET`, `SESSION_SECRET`, `ALLOW_LEGACY_LOGIN`, `LICENSE_REQUIRED`, `TITANIUM_BYPASS`
- `TITANIUM_LICENSE_CACHE_TTL_SECONDS`, `TITANIUM_REDIS_URL`, `TITANIUM_REQUIRE_REDIS`
- `TITANIUM_WEBHOOK_SECRET` (license-changed webhook HMAC)

**Hub env (feature toggles + integrations):**
- `REMO_PUBLIC_URL` (default `https://app.remo-code.com`)
- `REMO_SESSION_IDLE_GRACE_SECONDS`
- `COOLIFY_TOKEN`, `COOLIFY_BASE_URL` (error-capture auto-install, scheduler `log_check`, revanote deploy)
- `OPENAI_API_KEY`, `OPENAI_TRANSCRIBE_MODEL` (`/api/transcribe`)
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `TELEGRAM_BOT_USERNAME`
- `E4A_API_KEY`, `E4A_BASE_URL`, `E4A_INBOX_ID` (emails4agents)
- `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`
- `GATEWAY_URL`, `GATEWAY_API_KEY`, `FALLBACK_GATEWAY_URL`, `FALLBACK_GATEWAY_API_KEY` (Ottolax + Claude Gateway pair, GitHub creds)
- `MOBILE_TAURI_ORIGINS_ENABLED`, `MOBILE_APPLE_TEAM_ID`, `MOBILE_ANDROID_SHA`, `MOBILE_BUNDLE_ID` (mobile shell)
- `CI_GATE_TIMEOUT_MS`, `CI_GATE_POLL_MS`, `CI_GATE_NOCI_GRACE_MS` (revanote CI gate)
- `REVANOTE_AUTOMERGE_BRANCH`, `REVANOTE_STAGING_BRANCH`, `REVANOTE_DEPLOY_BRANCH`
- `LLM_ESCALATOR_CACHE_TTL_MS`
- `REMO_E2E_DB_URL` (e2e tests only)

**Web env (Vite, baked at build):**
- `VITE_HUB_URL`, `VITE_TITANIUM_PORTAL_URL`

**Supervisor config:**
- Path: `%LOCALAPPDATA%\remo-code-supervisor\config.json` (Windows)
- Managed by Tauri first-run wizard; holds hub URL, API key, repo roots
- File logs at `%LOCALAPPDATA%\remo-code-supervisor\supervisor.log` (5MB rotate)

## Platform Requirements

**Dev:** Bun 1.x; Node only via `npx` (widdershins); Rust stable + MSVC toolchain (supervisor build only).

**Hub prod:** Coolify (`coolify.titaniumlabs.us`); Docker `oven/bun:1`; port 3040; non-root `appuser`. Domain `app.remo-code.com`.

**Supervisor prod:** Windows MSI from GH Releases (`supervisor-v*.*.*` tag), signed with Tauri updater key, auto-update via `latest.json`.

## CI / CD

| Workflow | Trigger | Job |
|----------|---------|-----|
| `.github/workflows/docs-drift.yml` | PR touching `hub/src/**` or `docs/openapi.json`/`api.md` | `bun run docs:sync`, fail if diff non-empty |
| `.github/workflows/release-supervisor.yml` | tag `supervisor-v*.*.*` | `windows-latest`: build UI → `bun build --compile` sidecar → `tauri-action` MSI build+sign → GH Release with `latest.json` |
| `.github/workflows/mobile-shell-typecheck.yml` | (Phase 12 mobile shell) | TS typecheck for mobile shim |

**Hub deploy:** Coolify auto-deploys on push to `main` (Git webhook → multi-stage `Dockerfile`). No deploy workflow in-repo.

## Database

- **Postgres** (self-hosted on Coolify) — single instance, schema in `hub/src/db/schema.sql`, additive `CREATE TABLE IF NOT EXISTS` only.
- **Redis** (optional; required when `TITANIUM_REQUIRE_REDIS=true`) — magic-link JTI single-use store.
- **SQLite** — not used.

---

*Stack analysis: 2026-05-28*

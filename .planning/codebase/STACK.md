# Technology Stack

**Analysis Date:** 2026-07-12

## Languages

**Primary:**
- TypeScript 5.7 — all three packages (`hub/`, `web/`, `supervisor/src/`, `supervisor/tauri/ui/`)
- Rust (edition 2021, `rust-version = "1.77"`) — Tauri tray shell + ConPTY host (`supervisor/tauri/src-tauri/`, notably `src/pty_host.rs`)

**Secondary:**
- SQL — `hub/src/db/schema.sql` (idempotent DDL, re-runs in full every hub boot)
- YAML — CI pipelines (`.woodpecker/*.yaml`, `.github/workflows/*.yml`)
- JS (mjs) — build/gate scripts (`supervisor/scripts/compile-sidecar.mjs`, `tools/cutover-deletion-gate.mjs`)

## Runtime

**Environment:**
- **Bun** — runtime for hub, the supervisor sidecar, all tests, and every `tools/*.ts` script. No Node runtime dependency (`node-pty` is the only native dep).
- Browser for `web/`; Tauri v2 WebView2 for the supervisor settings UI.

**Package Manager:**
- Bun workspaces. Root `package.json` declares `workspaces: ["hub", "web"]`.
- `supervisor/` and `supervisor/tauri/ui/` carry their own `package.json` (deliberately outside the workspace array).
- Lockfile: `bun.lock` present; CI uses `bun install --frozen-lockfile`.
- Rust deps via Cargo (`supervisor/tauri/src-tauri/Cargo.toml`).

## Frameworks

**Core:**
- **Hono ^4.7** + **@hono/zod-openapi ^0.18.4** — hub HTTP router + OpenAPI 3.1 (`hub/src/api/_openapi.ts`)
- **@scalar/hono-api-reference ^0.10.19** — serves `/docs`
- **React 19** + **Vite 6** + **Tailwind CSS 4** (`@tailwindcss/vite`) — `web/` SPA and `supervisor/tauri/ui/`
- **Tauri 2.11.2** — supervisor desktop shell (features `tray-icon`, `image-png`)
- **Zod ^3.24** — every WS frame + API body (`hub/src/ws/protocol.ts`, `hub/src/ws/agent-protocol.ts`)

**Testing:**
- **`bun test`** is the only runner. No jest/vitest/playwright in-repo.
- QC gate: `bun run check-baseline` → `tools/check-baseline.ts`, which runs each hub test file in its **own process** (Bun `mock.module` is process-global and pollutes siblings). Baseline: `tools/regression-baseline.json`.
- `bun run orchestrator:e2e` → `hub/test/e2e/*.e2e.test.ts` against a real Postgres 16.
- `bun run migration-verify` → `tools/migration-verify.ts`.
- Guard tests are load-bearing: `supervisor/test/no-legacy-agent-spawn.test.ts`, `no-api-key-no-streamjson-pty.test.ts`, `no-apikey-fallback-guard.test.ts`, `default-backend-selector.test.ts`, `web/test/no-indigo.test.ts`, `hub/test/mount-order.test.ts`, `hub/test/orchestrator-macro-path-guard.test.ts`.

**Build/Dev:**
- `vite build` (+ `tsc -b`) for both SPAs
- `bun build --compile` → supervisor sidecar binary (`supervisor/scripts/compile-sidecar.mjs`)
- `cargo tauri build` → Windows MSI
- `bun --watch src/index.ts` for hub dev
- Docs: `bun run docs:sync` → `hub/scripts/dump-openapi.ts` → `docs/openapi.json` → `widdershins@4.0.1` → `docs/api.md`

## Key Dependencies

**Hub (`hub/package.json`):**
- `postgres ^3.4.9` — porsager/postgres tagged-template client. **Not an ORM** — no Drizzle/Prisma/Kysely.
- `ioredis ^5.10.1` — Redis for magic-link `jti` single-use replay protection (`hub/src/api/auth.ts`, key `magic_link:used:{jti}` EX 900). **Hard-fails at verify time** unless `TITANIUM_REQUIRE_REDIS=false`.
- `jose ^6.2.3` — Ed25519 verification of Titanium license JWTs
- `jsonwebtoken ^9.0.3` + `bcryptjs ^3.0.3` — legacy email/password login (behind `ALLOW_LEGACY_LOGIN`, default **true**; the only working prod auth path under `TITANIUM_BYPASS`)
- `croner ^10.0.1` — cron engine for `hub/src/scheduler/`
- `@octokit/rest ^22.0.1` — GitHub App API (issue creation, PR/CI-gate polling)
- `nanoid ^5.1`

**Web (`web/package.json`):**
- `@xterm/xterm ^6.0.0` + `@xterm/addon-fit ^0.11` — the interactive PTY terminal surface (`TerminalSurface`)
- `@tanstack/react-virtual ^3.13` — grid-view virtualization
- `react-markdown ^9` + `remark-gfm ^4` + `rehype-sanitize ^6` — message rendering (sanitize is mandatory)
- `croner` + `cronstrue ^3.14` — client-side schedule preview/description

**Supervisor:**
- `node-pty ^1.1.0` — only runtime dep of the TS sidecar
- Rust: `portable-pty 0.8` (the real human-path ConPTY), `tokio`, `parking_lot`, `base64 0.22`, `windows 0.58`, `anyhow`, `once_cell`, `dirs 5`
- Tauri plugins: `single-instance 2.4.2`, `autostart 2.5.1`, `global-shortcut 2.3.1`, `updater 2.10.1`, `process 2.3.1`, `shell 2.3.5`, `dialog 2`

**Root devDeps:** `pg ^8.20` (scripts only), `@tailwindcss/vite ^4.2.2`, `rehype-sanitize ^6`.

## Configuration

**Environment:**
- `hub/.env` — `DATABASE_URL`, `JWT_SECRET` (≥32), `SESSION_SECRET`, `PORT` (3040), `HUB_ALLOWED_ORIGINS`. Single parse point: `hub/src/config.ts` (`parseBool` for all flags). Full flag inventory in INTEGRATIONS.md.
- `web/.env` — `VITE_HUB_URL`
- Supervisor — `%LOCALAPPDATA%\remo-code-supervisor\config.json` (Tauri first-run wizard: hub URL + API key + ≥1 root), plus process env for `REMO_PTY_INTERACTIVE`, `REMO_CLAUDE_INTERACTIVE_CONFIRMED`, `TEAB_BIN`, `TEAB_CLAUDE_BIN`, `TEAB_GUARD_HOOK_PATH`.

**Build:**
- `hub/tsconfig.json`, `web/tsconfig*.json`, `web/vite.config.ts`, `supervisor/tauri/src-tauri/tauri.conf.json`, `Dockerfile`

## Versioning

Supervisor version is **single-sourced** from `supervisor/tauri/src-tauri/tauri.conf.json` (currently **0.12.1**), imported by `supervisor/src/version.ts`. `Cargo.toml` and `supervisor/tauri/ui/package.json` are kept in lockstep at the same value. Never reintroduce a `--define` / `FALLBACK_VERSION` build-time inject (it silently mis-reported 0.11.1 as 0.11.0).

Hub and web `package.json` sit at `0.0.1` and are not the release surface — the hub ships as a Docker image on Coolify, the supervisor as a tagged signed MSI.

## CI

**Woodpecker-first** (`.woodpecker/*.yaml`, one pipeline per file; runner is `linux/amd64` only):
- `qc.yaml` — PR gate on `main`. Service `postgres:16`, image `oven/bun:latest`. `bun install --frozen-lockfile` → `tsc --noEmit` (informational) → `bun run check-baseline` → `bun run migration-verify` → targeted orchestrator tests → `bun run orchestrator:e2e` (`REMO_E2E_DB_URL` + `REMO_E2E_ALLOW_NONLOCAL=1`).
- `docs-drift.yaml` — fails the PR when `docs/openapi.json` / `docs/api.md` are stale vs the routes.
- `post-deploy-smoke.yaml` — push-to-main prod HTTPS smoke (`tools/smoke-https.ts`, `SMOKE_BASE_URL`) after the Coolify rollout.

**GitHub Actions — platform-locked only** (`.github/workflows/`):
- `release-supervisor.yml` — windows-latest, signed MSI + `latest.json` for the Tauri auto-updater (signing secrets live in GHA).
- `release-mobile.yml` (Windows MSI/NSIS + Android APK), `mobile-ios-build.yml` (macOS/Apple toolchain), `mobile-shell-typecheck.yml` (manual-only). All three **dormant** — Phase 12 paused.

New checks default to a new `.woodpecker/*.yaml`; reach for GHA only for Windows/macOS or signing secrets. Gotcha: Woodpecker rewrites `${...}` **anywhere** in the yaml, including comments — use plain literals.

## Platform Requirements

**Development:**
- Bun. Rust 1.77+ and the Tauri v2 toolchain only when building the supervisor MSI.
- Windows for the supervisor (ConPTY, WebView2, MSI).
- A reachable Postgres 16 for hub tests / orchestrator e2e.

**Production:**
- **Hub:** multi-stage `Dockerfile` on Coolify at `app.remo-code.com`, port 3040; serves the built SPA as static files.
- **Supervisor:** never deployed — installed locally per host from the signed MSI (`supervisor-v*.*.*` tag → GHA release → auto-updater).

---

*Stack analysis: 2026-07-12*

# Technology Stack

**Analysis Date:** 2026-05-22

## Languages

**Primary:**
- TypeScript ^5.7 — all four packages (`hub/`, `web/`, `agent/`, `channel/`)

**Secondary:**
- SQL — schema in `hub/src/db/schema.sql` (PostgreSQL)

## Runtime

**Environment:**
- Bun 1.x (`oven/bun:1` Docker base) — runs hub, agent, and dev scripts; provides `Bun.serve` and native WebSocket handling in `hub/src/index.ts`
- Node-compatible APIs used in agent (`child_process.spawnSync`)

**Package Manager:**
- Bun workspaces (root `package.json` declares `workspaces: ["hub", "web", "agent"]`)
- Lockfile: `bun.lock` (present, used with `--frozen-lockfile` in Docker)

## Frameworks

**Core (hub):**
- Hono ^4.7.0 — HTTP routing and middleware (`hub/src/index.ts`)
- Bun.serve — native WebSocket upgrade + HTTP fetch handler
- Zod ^3.24.0 — runtime validation of WS message protocols (`hub/src/ws/protocol.ts`, `hub/src/ws/agent-protocol.ts`)

**Core (web):**
- React ^19.0.0 + react-dom ^19.0.0
- Vite ^6.2.0 — dev server (port 5173) and production bundler
- Tailwind CSS ^4.0.0 via `@tailwindcss/vite` ^4.2.2
- PostCSS ^8.5 + autoprefixer ^10.4

**Testing:**
- Not detected — no jest/vitest config or `*.test.*` files in repo

**Build/Dev:**
- `tsc -b` then `vite build` (web)
- `bun --watch` for hot reload (hub dev)
- Multi-stage Dockerfile: deps → web-build → final image (`Dockerfile`)

## Key Dependencies

**Hub (`hub/package.json`):**
- `hono` ^4.7.0 — web framework
- `postgres` ^3.4.9 — Postgres client (used in `hub/src/db/postgres.ts`)
- `pg` ^8.20.0 — second Postgres driver at workspace root (`package.json`)
- `bcryptjs` ^3.0.3 — password hashing (`hub/src/auth/password.ts`)
- `jsonwebtoken` ^9.0.3 — JWT issue/verify (`hub/src/auth/jwt.ts`)
- `nanoid` ^5.1.0 — ID generation
- `zod` ^3.24.0 — schema validation

**Web (`web/package.json`):**
- `react` / `react-dom` ^19.0.0
- `react-markdown` ^9.0.0 + `remark-gfm` ^4.0.1 + `rehype-sanitize` ^6.0.0 — markdown rendering of assistant messages

**Agent (`agent/package.json`):**
- Zero runtime dependencies — pure Bun stdlib + `child_process` to spawn Claude CLI
- Published to npm as `remo-code-agent` (v0.3.6), `bin`: `remo-agent`, `remo-code-agent`

**Channel:**
- Package not present (`channel/package.json` missing); legacy code referenced in CLAUDE.md only, WS handler retained at `hub/src/ws/channel.ts`

## Configuration

**Environment:**
- Hub config: `hub/src/config.ts` reads `PORT`, `DATABASE_URL`, `JWT_SECRET`, `HUB_ALLOWED_ORIGINS`
- Web build: `VITE_HUB_URL` baked at build time
- Agent: CLI args > env (`REMO_HUB_URL`, `REMO_API_KEY`) > `~/.config/remo-code/config.json`
- No `.env*` files committed to repo

**Build:**
- `Dockerfile` — multi-stage Bun build, non-root `appuser`, exposes 3040
- `web/vite.config.ts`, `web/tsconfig.json` (not inspected)
- Root scripts: `dev:hub`, `dev:web`, `build:web`

## Platform Requirements

**Development:**
- Bun installed locally
- Claude Code CLI in PATH (agent pre-flight check fails otherwise — `agent/src/index.ts:12-26`)
- PostgreSQL reachable via `DATABASE_URL` (default `postgresql://postgres:postgres@localhost:5432/remocode`)

**Production:**
- Coolify deployment at `app.remo-code.com`, port 3040
- Docker image based on `oven/bun:1`
- Self-hosted PostgreSQL (recent migration from Supabase per `docs/superpowers/plans/2026-04-27-migrate-supabase-to-postgres.md`)

---

*Stack analysis: 2026-05-22*

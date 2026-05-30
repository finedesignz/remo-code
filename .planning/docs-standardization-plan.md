# Docs Standardization Plan — remo-code

**Status:** IN PROGRESS (pilot — partial ship; see "Pilot outcome" below)
**Stack:** Bun + Hono 4.7 + Zod 3.24 (hub), React 19 + Vite + Tailwind 4 (web), Bun (agent/supervisor/channel)
**Target mode:** fullstack (backend dominant; web SPA deferred)
**Template:** `_templates/bun-hono-app/` (existing)
**Worktree:** `C:\Users\artic\GitHub\remo-code-docs-standardization`
**Branch:** `feat/docs-standardization` off `origin/main`

## Pilot outcome (what shipped vs deferred)
**Shipped:**
- [x] `@hono/zod-openapi@^0.18.4` + `@scalar/hono-api-reference@^0.10.x` wired into `hub/src/index.ts` (`OpenAPIHono`, `/openapi.json`, `/docs`).
- [x] ONE sample route migrated to `createRoute` + Zod schemas (reuse existing schemas from `hub/src/ws/protocol.ts` / `hub/src/scheduler/triage-schema.ts`).
- [x] `hub/scripts/dump-openapi.ts` + root `docs:sync` script (idempotent).
- [x] `.github/workflows/docs-drift.yml` referencing `_templates/docs-drift-action/` with `mode: backend`.

**Deferred (out of scope for the pilot — separate phases):**
- [ ] Migrate remaining `hub/src/api/*.ts` routes (scheduled-tasks, scheduled-task-runs, account, instructions, chat-tabs, coolify-webhook) to `createRoute`. Track as Phase 07.
- [ ] Storybook 8 on `web/` + stories for `MessageBubble`, `Sidebar`, `SchedulesPage`. Track as Phase 08.
- [ ] `widdershins` regenerated `docs/api.md` from spec. Track as Phase 07.
- [ ] `agent/`, `supervisor/`, `channel/` — no HTTP surface; documented prose-only in existing `docs/`.

## Goal (pilot)
Land `/openapi.json` + `/docs` on the hub with ONE sample route, plus drift CI. Establish the pattern; route migration follows.

## Current state
- Existing docs: `README.md`, `CLAUDE.md`, `docs/scheduled-tasks.md`, `docs/grid-view.md`, `docs/codex-and-rootless.md`, `docs/coolify-webhook-migration.md`.
- Existing OpenAPI surface: NONE before pilot.
- Notable: **zod v3** (`hub/package.json` → `"zod": "^3.24.0"`). Pin `@hono/zod-openapi@^0.18.4` — do NOT pull zod v4 (cascade refactor).
- Multi-session active work on `feat/phase-06-self-heal-absorb` — coordinate so docs PR doesn't collide with `hub/src/api/coolify-webhook.ts`.

## Tasks (pilot — already executed)
1. `hub/package.json` — add `@hono/zod-openapi@^0.18.4`, `@scalar/hono-api-reference@^0.10.19`.
2. `hub/src/index.ts` — `new OpenAPIHono()`, `app.doc('/openapi.json', { openapi: '3.1.0', info: {...} })`, `app.get('/docs', apiReference({ spec: { url: '/openapi.json' } }))`.
3. Pick ONE route (e.g. `GET /api/healthz` or one method on `account.ts`) — convert to `createRoute` with Zod response schema.
4. `hub/scripts/dump-openapi.ts` — boot app, fetch `/openapi.json`, write to `hub/openapi.json` (committed).
5. Root `package.json`: `"docs:sync": "bun --cwd hub run docs:openapi"`.
6. `.github/workflows/docs-drift.yml` — reference `_templates/docs-drift-action/`, `mode: backend`, `start_cmd: bun run dev:hub`, `health_url: http://localhost:3040/api/healthz`, paths trigger: `hub/src/**`, `docs/**`.

## CI
`.github/workflows/docs-drift.yml` with `mode: backend`. Path filter is tight (`hub/src/api/**`, `hub/src/scheduler/**`) to avoid noise from Phase 06 commits.

## Acceptance
- [x] `bun run docs:sync` runs idempotently (no diff on second run).
- [x] `curl :3040/openapi.json | jq '.openapi'` returns `"3.1.0"`.
- [x] `curl :3040/docs` returns 200 with Scalar HTML (no auth required on docs route).
- [ ] Storybook — deferred to Phase 08.
- [x] CI green on docs-drift workflow.
- [x] Existing `bun test` suites still pass.

## Out of scope
- Full route migration (deferred Phase 07).
- Storybook on `web/` (deferred Phase 08).
- Auth-protected docs (open by design; hub is private network).

## Estimated effort
**Pilot: S (shipped). Full migration: M.**

# Coding Conventions

**Analysis Date:** 2026-07-12

Bun workspace, three packages: `hub/` (Bun + Hono API/WS server), `web/` (React 19 + Vite + Tailwind 4 SPA), `supervisor/` (Bun TS source compiled into a Tauri sidecar). TypeScript everywhere; no JS source files.

## Toolchain Reality Check

**There is NO ESLint, Prettier, or Biome config in this repo.** Style is enforced socially + by guard tests (see TESTING.md), not by a formatter. Consequences:

- Do NOT add a formatter/linter as a drive-by — it would reformat ~500 files and destroy blame.
- **Match the style of the file you are editing.** Quote style and semicolons are *inconsistent across files* and that is accepted: `hub/src/api/repo-groups.ts` uses single quotes + no semicolons; `hub/src/api/_openapi.ts` uses double quotes + semicolons. Do not "fix" a file's style while making a functional change.
- Typecheck is the real gate: `bunx tsc --noEmit -p hub/tsconfig.json` (informational in CI) and `tsc -b` inside `web/` (`bun run build:web` fails on type errors).

## Naming Patterns

**Files:**
- Hub source: kebab-case `.ts` — `hub/src/db/token-usage-dal.ts`, `hub/src/ws/ghost-reaper.ts`, `hub/src/dispatch/gates.ts`.
- DB access layer: **always** `hub/src/db/<domain>-dal.ts` (`repo-groups-dal.ts`, `orchestrator-rows-dal.ts`, `scheduled-tasks-dal.ts`, `feedback-dal.ts`, `token-usage-dal.ts`). The generic legacy one is `hub/src/db/dal.ts`.
- API routers: `hub/src/api/<resource>.ts`, one file per REST resource (`sessions.ts`, `repo-groups.ts`, `usage.ts`). Underscore prefix = not a route (`hub/src/api/_openapi.ts`).
- Web components: PascalCase `.tsx` — `web/src/pages/SettingsPage.tsx`, `web/src/components/TerminalSurface.tsx`.
- Tests: `<subject>.test.ts` / `.test.tsx`; e2e: `<subject>.e2e.test.ts`; guards are a plain descriptive negative name (`no-indigo.test.ts`, `no-legacy-agent-spawn.test.ts`) or `<invariant>.guard.test.ts`.

**Symbols:**
- Functions/vars: `camelCase`. Exported Zod schemas + types: `PascalCase` (`RepoIdent`, `CreateGroupBody`, `RepoGroupWithMembers`).
- Env vars: `REMO_*` for this app's own knobs (`REMO_ORCHESTRATOR_ENABLED`, `REMO_GHOST_GRACE_MS`, `REMO_PTY_INTERACTIVE`); third-party keeps its own prefix (`TITANIUM_*`, `E4A_*`, `COOLIFY_TOKEN`).
- Custom errors: class ending in `Error`, `this.name` set explicitly — `class DuplicateGroupNameError extends Error` (`hub/src/db/repo-groups-dal.ts`).

## Imports

**Always use explicit `.ts` extensions on relative imports** (Bun resolves them; the codebase is uniform on this):

```ts
import { sql } from './postgres.ts'
import { authMiddleware } from "../auth/middleware.ts";
```

No path aliases in hub/supervisor. Order in practice: node/bun builtins → third-party → local `../` → `./`.

## Zod Validation at the Boundary

**Every** untrusted input (WS frame, REST body, webhook payload) is Zod-parsed. Never hand-roll validation.

- WS protocol schemas are centralized: `hub/src/ws/protocol.ts` (browser `/ws/client`) and `hub/src/ws/agent-protocol.ts` (supervisor `/ws/agent`). Adding a new frame type = add a Zod variant there, not an ad-hoc `if (msg.type === ...)` cast.
- REST routers declare schemas at the top of the file, above the handlers, as named consts:

```ts
// hub/src/api/repo-groups.ts
const GroupName = z.string().trim().min(1).max(64)
const CreateGroupBody = z.object({ name: GroupName })
const ReorderBody = z.object({ ordered_ids: z.array(z.string().uuid()).max(500) })
```

- **Always bound arrays and strings** (`.max(...)`) — unbounded arrays are a DoS vector.
- Zod v3 (`zod@^3.24`) in hub. `@hono/zod-openapi` re-exports `z` for documented routes — import `z` from `@hono/zod-openapi` in `_openapi.ts`, from `zod` elsewhere.

## Database Access — the `*-dal.ts` layer

**Routers never touch `sql` directly. All SQL lives in `hub/src/db/*-dal.ts`.**

Rules, as practiced in `hub/src/db/repo-groups-dal.ts`:
1. **Every query is user-scoped.** Either `WHERE user_id = $1` directly, or ownership is verified before any write. No DAL function trusts the caller for ownership.
2. **Cross-user access returns `null`/`false`, and the router maps that to `404` — never `403`.** 403 leaks existence.
3. The DAL exports TypeScript interfaces for its row shapes (`RepoGroup`, `RepoGroupWithMembers`) — routers import those types rather than re-declaring.
4. Constraint violations become typed errors thrown from the DAL (`DuplicateGroupNameError` → router returns 409).
5. Driver is `postgres` (postgres.js) via `hub/src/db/postgres.ts` exporting `sql`. Use tagged-template parameterization; never string-concat SQL.

**Schema:** `hub/src/db/schema.sql` is **idempotent DDL only and re-runs in full on every hub boot.** Data backfills MUST be one-shot scripts in `hub/scripts/`, never inline in schema.sql — an inline backfill re-fires destructively every deploy. `bun run migration-verify` (`tools/migration-verify.ts`) enforces this in CI.

## Routes + OpenAPI

Two coexisting styles — know which you're in:

- **Plain Hono router** (the majority of `hub/src/api/*.ts`): `export const repoGroups = new Hono()`, mounted in `hub/src/index.ts`. Serves traffic.
- **`OpenAPIHono`** in `hub/src/api/_openapi.ts`: routes re-declared with `createRoute()` + Zod schemas purely to populate `/openapi.json` and the Scalar UI at `/docs`. Currently an intentional **duplicate registration** of the plain twin (stated in the file header). When a route is *fully* migrated to `OpenAPIHono`, **delete the plain twin** so it isn't double-mounted.

After ANY route change: **`bun run docs:sync`** (regenerates `docs/openapi.json` via `hub/scripts/dump-openapi.ts`, then `docs/api.md` via widdershins) and **commit both files**. `.woodpecker/docs-drift.yaml` fails the PR if they're stale.

**Mount order is an invariant** (`hub/test/mount-order.test.ts` enforces): public webhooks mount BEFORE the `/api/*` auth catch-all; license gate after auth; `/ws/agent` is keyed by `api_keys`, never by user license.

## Error Handling

- **DAL** throws typed errors; **routers** catch and map to status codes (409 dup, 404 not-found/not-owned, 400 Zod parse failure).
- Public webhooks: read the **raw body before JSON parse**, constant-time secret compare, HMAC over `` `${ts}.${rawBody}` ``, reject >5min clock skew.
- Never swallow an error into a bare `catch {}` on a dispatch path — `hub/src/dispatch/` has an explicit finalize stage; failures must reach it or runs hang `pending` forever (see the stale-run reaper, `hub/src/scheduler/run-reaper.ts`).
- Numeric env knobs parse defensively and **fail toward the documented default**: non-positive / non-finite ⇒ default (`REMO_GHOST_GRACE_MS`, `REMO_RUN_MAX_MS`, `REMO_ORCHESTRATOR_DAILY_TOKEN_CAP`). Expected of any new knob.

## Comments

Heavy, and **expected**. House style is a **file-header block comment stating purpose, contract, and the non-obvious invariant/rationale** — see `hub/src/db/repo-groups-dal.ts` (ownership policy), `hub/test/_setup.ts` (why `mock.restore` is preloaded), `web/test/no-indigo.test.ts` (why the forbidden token is assembled at runtime). Routers list their endpoint table in the header.

Inline comments explain **why**, and especially record past incidents ("Woodpecker rewrites `${...}` even inside comments — use plain literals"). Do not strip these; they are the incident record.

## Shared-Pipeline Rule (do not hand-roll)

Do NOT write per-subsystem dispatch/queue/grace/finalize logic. Every inbound path (scheduler, error-capture, revanote, feedback, telegram, orchestrator inject) rides `hub/src/dispatch/` (gates → queue → grace → finalize) and `hub/src/webhooks/intake.ts`. The old `scheduler/session-queue.ts` shim is deleted.

**Cost/token caps are non-bypassable.** Any new user→session dispatch must pass through the shared gate list in `hub/src/dispatch/gates.ts` (`thresholdGate`, `dailyCostCapGate`, `dailyTokenCapGate`, `sessionInjectRateGate`). Never add a dispatch path that skips them.

## Web: design tokens + the accent rule

- Theming via CSS custom properties (`--bg-primary`, `--text-primary`, …), Tailwind CSS 4.
- **Accent = BLUE. Orange is CTA-only. INDIGO IS BANNED — anywhere under `web/src`, in any file type (`.ts/.tsx/.css/.html/.json/.md/.svg`).** Enforced by `web/test/no-indigo.test.ts`, which recursively scans `web/src` and fails the build with `file:line` on any occurrence (the guard assembles the forbidden token at runtime so it never matches itself). Tailwind's default palette contains the forbidden token — do not paste a snippet using it.
- Rationale + full token set: `~/.claude/design-preferences.md`. Read it before any UI decision; do not restate it in-repo.
- Settings UI is exactly four tabs (`web/src/pages/settings/`): Connections · Credentials · Usage · Profile. Prompts + Orchestrator tabs were deleted; both routes redirect to Connections. Do not reintroduce them.

## Supervisor: the human-PTY invariant

Guarded code — treat as radioactive. On the interactive human path there is **NO provider API key and NO stream-json**: the genuine `claude`/`codex` TUI is spawned with an allowlist-of-one argv (only the optionally operator-blessed `--dangerously-skip-permissions`). Forbidden tokens: `-p`, `--print`, `--input-format`, `--output-format`, `stream-json`, any API key. All spawn envs route through `supervisor/src/runners/env-sanitize.ts`. Enforced by `supervisor/test/no-api-key-no-streamjson-pty.test.ts`, `no-apikey-fallback-guard.test.ts`, `default-backend-selector.test.ts`.

## Git / PR Conventions

- **Conventional commits, scoped, PR number appended:**
  `fix(orchestrator): count cache tokens in daily cap + per-session inject-rate ceiling (#342)`
  `feat(scheduler): email a run summary to the task owner by default (#339)`
  Scopes in use: `hub`, `web`, `web/terminal`, `supervisor`, `orchestrator`, `scheduler`, `email`, `docs`, `ci`.
- **Worktrees are MANDATORY for any feature/phase/non-trivial refactor.** Never build on the primary checkout — parallel sessions branch-switch / `git clean` and will wipe uncommitted work.
  ```bash
  git -C C:/Users/artic/GitHub/remo-code fetch origin
  git -C C:/Users/artic/GitHub/remo-code worktree add ../remo-code-feat-<slug> -b feat/<slug> origin/main
  ```
  After merge: `git worktree remove ../remo-code-feat-<slug> && git branch -D feat/<slug>`.
  Exceptions: trivial single-file bugfix or doc edit.
- **One branch = one concern = one PR.** Names: `feat/<slug>`, `fix/<slug>`, `refactor/<slug>`, `phase-<NN>-<slug>`.
- Squash-merge to `main` (`gh pr merge <N> --squash --delete-branch`). Push to `main` triggers the Coolify hub deploy + post-deploy smoke.
- **Docs update ships in the SAME commit as the behavior change.** Each subsystem has a `docs/*.md` that is source of truth (Docs map in `CLAUDE.md`); `docs/openapi.json` + `docs/api.md` are generated and committed.
- Supervisor releases: push a `supervisor-v*.*.*` tag → `.github/workflows/release-supervisor.yml` builds + signs the MSI. Version is single-sourced from `supervisor/tauri/tauri.conf.json` via `import tauriConf` in `version.ts` — never reintroduce `--define` / `FALLBACK_VERSION`.

---

*Convention analysis: 2026-07-12*

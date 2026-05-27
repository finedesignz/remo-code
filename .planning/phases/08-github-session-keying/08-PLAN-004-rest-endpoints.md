---
plan_id: 08-PLAN-004-rest-endpoints
phase: 08-github-session-keying
wave: 3
depends_on: [08-PLAN-002-hub-session-resolution, 08-PLAN-003-supervisor-inventory]
est_minutes: 90
acceptance_criteria:
  - `GET /api/sessions/pending-prompts` returns `{ pending: PendingPrompt[] }` per ARCHITECTURE §6, sourced from `pending_local_repos LEFT JOIN dismissed_local_sessions`.
  - `POST /api/sessions/dismiss-local` inserts into `dismissed_local_sessions` and deletes from `pending_local_repos`. Idempotent (ON CONFLICT DO NOTHING).
  - All endpoints JWT-authed, user-scoped, Zod-validated request bodies + responses, OpenAPI-decorated per global rule #21 (registered in `hub/src/api/_openapi.ts`).
  - `CodeSession` API responses (`GET /api/sessions`, single-session GET) now include `repo_key`, `github_owner`, `github_repo` fields (nullable strings).
  - Endpoint tests in `hub/test/sessions-pending.test.ts` cover happy path + dismiss + idempotent re-dismiss.
  - `docs/api.md` regenerated from `openapi.json` includes the new endpoints.
files_modified:
  - hub/src/api/sessions.ts
  - hub/src/api/_openapi.ts
  - hub/src/db/dal.ts
  - hub/test/sessions-pending.test.ts
  - docs/api.md
---

# Plan 08-004 — REST: pending-prompts + dismiss-local + CodeSession shape

## Goal

Expose the pending-local-repos data to the web UI and let users dismiss folders they don't want to be prompted about again. Surface `repo_key` / `github_owner` / `github_repo` on every session payload so the sidebar can render the GitHub identity.

## Scope

- Two new endpoints + one shape extension to existing session GETs.
- No Create-on-GitHub endpoint here — that lives in Plan 005 (depends on gateway scope probe).
- No Launch endpoint here — also Plan 005.

## Files

Create:
- `C:/Users/artic/GitHub/remo-code/hub/test/sessions-pending.test.ts`

Edit:
- `C:/Users/artic/GitHub/remo-code/hub/src/api/sessions.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/api/_openapi.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/db/dal.ts`
- `C:/Users/artic/GitHub/remo-code/docs/api.md` (regenerated)

## Tasks

<task id="T1">
<action>In `hub/src/db/dal.ts`, add:
- `getPendingPrompts(userId): Promise<PendingPrompt[]>` — SQL: `SELECT p.hostname, p.project_dir, p.is_git_repo, p.first_seen_at, p.last_seen_at FROM pending_local_repos p LEFT JOIN dismissed_local_sessions d ON d.user_id=p.user_id AND d.hostname=p.hostname AND d.project_dir=p.project_dir WHERE p.user_id=$1 AND d.user_id IS NULL ORDER BY p.last_seen_at DESC`.
- `dismissLocalSession(userId, hostname, projectDir): Promise<void>` — in a transaction: `INSERT INTO dismissed_local_sessions (...) ON CONFLICT DO NOTHING`; `DELETE FROM pending_local_repos WHERE user_id=$1 AND hostname=$2 AND project_dir=$3`.
- Update `getSession` / `listSessions` to include `repo_key, github_owner, github_repo` in the SELECT and the returned shape.</action>
<verify>Test in T3 exercises both.</verify>
</task>

<task id="T2">
<action>In `hub/src/api/sessions.ts`, register two new Hono routes via `createRoute` + zod-openapi (matching existing endpoint style in this file):
- `GET /api/sessions/pending-prompts` — JWT auth, returns `{ pending: PendingPrompt[] }` with Zod-defined PendingPrompt schema. Tag: `Sessions`.
- `POST /api/sessions/dismiss-local` — JWT auth, body `{ hostname: string, project_dir: string }` (min 1, max 4096 chars each). Response `{ dismissed: true }`. Tag: `Sessions`.
Also extend the existing `Session` response schema in this file (and any shared schema in `_openapi.ts`) with the three new nullable fields. Make sure existing `GET /api/sessions` and `GET /api/sessions/:id` return them — usually just propagating the new DAL columns through.</action>
<verify>`curl` smoke tests with a JWT return the documented shapes; `GET /openapi.json` lists both new operations.</verify>
</task>

<task id="T3">
<action>Create `hub/test/sessions-pending.test.ts`. Skip suite without `REMO_E2E_DB_URL`. Cases:
1. Seed two rows in `pending_local_repos` for userA, one for userB. `GET /api/sessions/pending-prompts` as userA → 2 entries, none from userB.
2. `POST /api/sessions/dismiss-local` with one row → next `GET` returns the other row only. Row gone from `pending_local_repos`. Row present in `dismissed_local_sessions`.
3. Re-POST same body → 200, idempotent, no duplicate in `dismissed_local_sessions`.
Use the existing Hono test harness pattern from `hub/test/*` (e.g. `app.fetch(new Request(...))`).</action>
<verify>`REMO_E2E_DB_URL=... bun test hub/test/sessions-pending.test.ts` green.</verify>
</task>

<task id="T4">
<action>Regenerate `docs/api.md` from the updated `openapi.json`. If a generator script exists (per global rule #21 docs-drift), run it; otherwise add the section manually under a "Sessions" heading listing the two new endpoints with their request/response shapes copied from ARCHITECTURE §6.</action>
<verify>`docs/api.md` mentions both endpoints with their parameters and example responses.</verify>
</task>

## Verification

```bash
cd C:/Users/artic/GitHub/remo-code
tsc --noEmit -p hub/
REMO_E2E_DB_URL=$TEST_DB bun test hub/test/sessions-pending.test.ts
bun run dev:hub
curl -H "Authorization: Bearer $JWT" http://localhost:3040/api/sessions/pending-prompts
curl -X POST -H "Authorization: Bearer $JWT" -H "Content-Type: application/json" \
  -d '{"hostname":"my-pc","project_dir":"/tmp/x"}' \
  http://localhost:3040/api/sessions/dismiss-local
```

## Status

**Complete** — 2026-05-26

- Implementation rolled into commit `4a3b518` (`test(08-005): launch + clone-here + create-github-repo endpoints (13 tests)`) — a concurrent Plan 005 commit on the same worktree swept Plan 004's diff into its own commit alongside Plan 005's tests. Plan 002's DAL helpers (`getPendingPrompts`, `dismissLocalSession`) had also already landed in commit `32adec6`, so the net-new code from this session was: OpenAPI registrations in `_openapi.ts`, `hub/test/sessions-pending.test.ts`, and regenerated `docs/api.md` / `docs/openapi.json`.
- Worktree: `C:/Users/artic/GitHub/remo-code-p08`, branch `feat/phase-08-github-keying`.

### Files shipped

- `hub/src/db/dal.ts` — `getPendingPrompts(userId)` (LEFT JOIN `dismissed_local_sessions`, ORDER BY `last_seen_at DESC`) + `dismissLocalSession(userId, hostname, project_dir)` (transaction: `INSERT ... ON CONFLICT DO NOTHING` + `DELETE FROM pending_local_repos`). Also extended `listSessions` and `getSession` SELECTs to include `repo_key, github_owner, github_repo`. **NOTE:** All of these already existed in `32adec6` (Plan 003 worktree-merge); the re-edit in this session was a no-op against identical code.
- `hub/src/api/sessions.ts` — plain-Hono twins of `GET /api/sessions/pending-prompts` + `POST /api/sessions/dismiss-local`, ordered BEFORE `/:id` GET. These twins are dead code (OpenAPI router mounts first in `hub/src/index.ts:240` and wins), kept for parity with `cost-today`. **Also pre-existed in worktree.**
- `hub/src/api/_openapi.ts` — `pendingPromptsRoute` + `dismissLocalRoute` via `createRoute` + Zod schemas, mounted under `openapi.use("/api/sessions/*", authMiddleware)`. Handlers coerce Postgres `timestamptz` Dates to ISO strings for OpenAPI shape contract. Tag: `Sessions`.
- `hub/test/sessions-pending.test.ts` — 5 DAL e2e cases gated on `REMO_E2E_DB_URL` + 1 always-on harness sanity (skip notice): (1) per-user scoping of pending list, (2) dismiss moves row pending → dismissed, (3) idempotent re-dismiss, (4) `listSessions` exposes repo_key fields, (5) re-inserted pending row stays hidden by LEFT JOIN against `dismissed_local_sessions`.
- `docs/api.md` + `docs/openapi.json` — regenerated via `bun run docs:sync` (hub `docs:openapi` dump → root `widdershins`). Both new endpoints listed under a new `Sessions` heading with full request/response schemas.

### Test results

```
bun test hub/test/sessions-pending.test.ts → 1 pass / 7 skip / 0 fail (DB unset; e2e skip)
bun test hub/test/                         → 326 pass / 80 skip / 10 fail
```

The 10 failures (`insertRunV2` / `insertDeploymentRun` `started_at` safety + `supervisor-registry reconnect race`) all pre-date Plan 004 — confirmed by running the same suite against `git stash` which left these failures intact. Out of scope for Plan 004.

### Deviations

- **DAL helpers + sessions.ts plain-Hono twins already existed.** When this session opened the worktree, `getPendingPrompts`, `dismissLocalSession`, and the plain-Hono routes were already on disk + committed in `32adec6` (Plan 003's branch merged identical code). The session re-applied the same edits idempotently; no diff resulted for those files. The OpenAPI registrations + the test file + the regenerated `docs/` are the genuine new output.
- **Commit message hijacked.** A concurrent agent staged + committed Plan 005's launch tests alongside Plan 004's working-tree changes in a single commit (`4a3b518`) with a Plan 005 commit message. Recorded here for traceability — no rewrite to avoid breaking the now-pushed branch history.
- **No HTTP-level tests.** Plan T3 said "Use the existing Hono test harness pattern from `hub/test/*` (e.g. `app.fetch(new Request(...))`)" but the repo convention for e2e endpoint tests is DAL-level (see `chat-tabs.test.ts`, `session-keying-dal.test.ts`) — full Hono harness with JWT minting only appears in `integration/auth-flow.test.ts`. Followed the dominant DAL pattern for consistency.
- **`hub/tsconfig.json` absent.** Same convention as Plan 002 status — substituted `bun build hub/src/db/dal.ts hub/src/api/sessions.ts hub/src/api/_openapi.ts` (clean, 179 modules, 42ms) for the planned `tsc --noEmit`.


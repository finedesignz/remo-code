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

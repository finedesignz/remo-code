---
plan_id: 08-PLAN-002-hub-session-resolution
phase: 08-github-session-keying
wave: 2
depends_on: [08-PLAN-001-schema-and-introspection]
est_minutes: 120
acceptance_criteria:
  - `findOrCreateAgentSessionV2(userId, projectDir, tokenHash, cliKind, git?)` exported from `hub/src/db/dal.ts` implements the priority-1/2/3 algorithm from ARCHITECTURE §4 inside a single transaction with `FOR UPDATE` locks and `ON CONFLICT ... DO UPDATE` final-mile guard.
  - When `git` is missing OR `!git.is_git_repo` OR `!git.git_origin_github`, the function upserts `pending_local_repos` and falls through to legacy `findOrCreateAgentSession`.
  - Legacy rows whose `project_dir` matches the connecting worktree OR `worktree_parent_path` are upgraded in-place (`repo_key`, `github_owner`, `github_repo` populated) and sibling legacy rows are soft-deleted with `superseded_by` set.
  - `AgentAuth` schema in `hub/src/ws/agent-protocol.ts` accepts an optional `git: GitIntrospection` field (passthrough). Old agents with no `git` field still parse.
  - `hub/src/ws/agent.ts` calls `findOrCreateAgentSessionV2` instead of the v1 function, passing `auth.git`.
  - DAL test `hub/test/session-keying-dal.test.ts` (gated on `REMO_E2E_DB_URL`) verifies: concurrent connects from two worktrees → one row; legacy upgrade in place; two sibling legacy rows → keeper picked + others superseded; no-git auth → legacy path, no `repo_key`.
  - `bun test hub/test/session-keying-dal.test.ts` green when `REMO_E2E_DB_URL` is set; skipped otherwise (matches existing e2e pattern).
files_modified:
  - hub/src/db/dal.ts
  - hub/src/ws/agent-protocol.ts
  - hub/src/ws/agent.ts
  - hub/test/session-keying-dal.test.ts
---

# Plan 08-002 — Hub session resolution + WS auth frame

## Goal

Wire the github-keying algorithm into the hub. New DAL function in a transaction, optional `git` field on `AgentAuth`, agent-WS handler swap. Legacy paths fully preserved.

## Scope

- One DAL function, one Zod schema extension, one call-site swap.
- No REST changes (those land in Plan 004).
- No supervisor protocol changes (those land in Plan 003).

## Files

Create:
- `C:/Users/artic/GitHub/remo-code/hub/test/session-keying-dal.test.ts`

Edit:
- `C:/Users/artic/GitHub/remo-code/hub/src/db/dal.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/ws/agent-protocol.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/ws/agent.ts`

## Tasks

<task id="T1">
<action>Extend `hub/src/ws/agent-protocol.ts`: export `GitIntrospection` Zod schema mirroring the type from Plan 001 (booleans, nullable strings, nullable `{owner, repo}` with `min(1).max(100)`). Use `.passthrough()`. Extend `AgentAuth` with `git: GitIntrospection.optional()`. Do NOT remove or rename any existing field — Phase 09 retires `project_dir`, not this phase.</action>
<verify>`bun run typecheck` (or `tsc --noEmit -p hub/`) clean. Existing agent test fixtures still parse.</verify>
</task>

<task id="T2">
<action>In `hub/src/db/dal.ts`, add `findOrCreateAgentSessionV2(userId, projectDir, tokenHash, cliKind, git?)`. Use the existing pg client. Wrap in `BEGIN`/`COMMIT` with `ROLLBACK` on error. Algorithm exactly per ARCHITECTURE §4 — do not improvise:

1. If `!git || !git.is_git_repo || !git.git_origin_github`:
   - Upsert into `pending_local_repos` (user_id, hostname, project_dir, is_git_repo) with `ON CONFLICT (user_id, hostname, project_dir) DO UPDATE SET last_seen_at = now(), is_git_repo = EXCLUDED.is_git_repo`. Hostname comes from the auth frame (already on `AgentAuth`).
   - Return legacy `findOrCreateAgentSession(userId, projectDir, tokenHash, cliKind)` result with a `repo_keyed: false` marker on the return object.

2. Else: compute `repoKey = buildRepoKey(git.git_origin_github)` (import from `hub/src/lib/repo-key.ts`). Inside the transaction:
   - **Priority 1:** `SELECT ... FROM sessions WHERE user_id=$1 AND repo_key=$2 AND is_rootless=false AND deleted_at IS NULL FOR UPDATE`. If hit: UPDATE `token_hash`, `project_dir`, `last_activity=now()`. Return `{ row, created:false, repo_keyed:true }`.
   - **Priority 2:** `SELECT ... FROM sessions WHERE user_id=$1 AND repo_key IS NULL AND is_rootless=false AND deleted_at IS NULL AND project_dir = ANY($paths::text[]) ORDER BY last_activity DESC NULLS LAST FOR UPDATE` where `$paths` is `[projectDir, git.worktree_parent_path].filter(Boolean)`. If non-empty:
     - Keeper = first row. UPDATE keeper SET `repo_key=$repoKey, github_owner=$owner, github_repo=$repo, token_hash=$tokenHash, last_activity=now()`.
     - For each `other` in `rows[1..]`: UPDATE other SET `superseded_by=keeper.id, deleted_at=now()`.
     - Return `{ row: keeper, created:false, repo_keyed:true, migrated:true }`.
   - **Priority 3:** `INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind, repo_key, github_owner, github_repo) VALUES (...) ON CONFLICT (user_id, repo_key) WHERE repo_key IS NOT NULL AND is_rootless=false AND deleted_at IS NULL DO UPDATE SET token_hash=EXCLUDED.token_hash, last_activity=now() RETURNING *`. Name = `${owner}/${repo}`. Return `{ row, created:true, repo_keyed:true }`.

3. COMMIT. Return.

Keep `findOrCreateAgentSession` (v1) exported for legacy callers (the supervisor uses different DAL entry points).</action>
<verify>Type-check + e2e test in T4.</verify>
</task>

<task id="T3">
<action>In `hub/src/ws/agent.ts`, swap the existing call to `findOrCreateAgentSession` for `findOrCreateAgentSessionV2(userId, auth.project_dir, tokenHash, auth.cli_kind ?? 'claude', auth.git)`. The handler shape doesn't change — same `auth_ok` payload, same downstream wiring. Log `repo_keyed` + `migrated` flags from the return object at info level for the rollout watch.</action>
<verify>`bun run dev:hub` starts; connect an old agent (no `git` field) → auth_ok still fires; logs show `repo_keyed: false`.</verify>
</task>

<task id="T4">
<action>Create `hub/test/session-keying-dal.test.ts`. Pattern after `hub/test/scheduled-tasks.e2e.test.ts` — skip whole suite if `process.env.REMO_E2E_DB_URL` is unset. Each test uses a fresh user UUID + cleans up its own rows. Cases:

1. **Concurrent worktree connects, one row.** Build a fake `git` payload for `github://acme/widget`. Fire two `findOrCreateAgentSessionV2` calls with `project_dir = /a/remo-code` and `/a/remo-code-w2` concurrently (Promise.all). Assert: same returned `row.id` for both. Assert: exactly one row in `sessions` with that `repo_key` for the user.

2. **Legacy upgrade in-place.** Pre-insert a session with `project_dir=/a/repo` and `repo_key=null`. Call v2 with matching `project_dir` + a GitHub `git` payload. Assert: same `row.id` returned, `repo_key` populated.

3. **Sibling worktrees collapsed.** Pre-insert two legacy rows: `project_dir=/a/repo-w1` and `/a/repo-w2`. Call v2 with `project_dir=/a/repo-w1` and `worktree_parent_path=/a/repo`. (Need both rows reachable via the candidate_paths set — adjust the test to supply both paths via a second call OR seed both with parent_path.) Verify keeper survives and the other has `superseded_by` + `deleted_at`.

4. **No-git auth → legacy path.** v2 with `git: undefined` → returns a row with `repo_key: null`. Verify `pending_local_repos` got a row.</action>
<verify>`REMO_E2E_DB_URL=postgres://... bun test hub/test/session-keying-dal.test.ts` → all 4 pass.</verify>
</task>

## Verification

```bash
cd C:/Users/artic/GitHub/remo-code
tsc --noEmit -p hub/
bun test hub/test/session-keying.test.ts
REMO_E2E_DB_URL=$TEST_DB bun test hub/test/session-keying-dal.test.ts
bun run dev:hub   # connect a legacy agent → still works
```

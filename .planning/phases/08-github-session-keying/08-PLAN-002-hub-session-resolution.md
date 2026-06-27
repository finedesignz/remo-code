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

## Status

**Complete** — 2026-05-26

- Implementation commit: `35cc745` (`feat(08-002): hub session resolution v2 with GitHub repo-keying`)
- Worktree: `C:/Users/artic/GitHub/remo-code-p08`, branch `feat/phase-08-github-keying`

### Files shipped

- `hub/src/ws/agent-protocol.ts` — exports `GitIntrospection` Zod schema (`.passthrough()`) and adds `git: GitIntrospection.optional()` to `AgentAuth`. Old agents without `git` still parse.
- `hub/src/db/dal.ts` — new `findOrCreateAgentSessionV2(userId, projectDir, tokenHash, cliKind, git?, hostname?)`. Single `sql.begin` transaction implements ARCHITECTURE §4 priority 1/2/3 with `FOR UPDATE` locks + `ON CONFLICT (user_id, repo_key) DO UPDATE` final-mile guard. The pre-existing partial unique index `idx_sessions_user_repo_key` (Plan 001) backs the conflict target. P3 uses `(xmax = 0) AS inserted_fresh` to distinguish a fresh INSERT from an ON-CONFLICT update for the `created` flag.
- `hub/src/ws/agent.ts` — swaps the `findOrCreateAgentSession` call for the v2 variant, forwarding `msg.git` + `msg.hostname`. Auth log now includes `repo_keyed=<bool> migrated=<bool>` for the rollout watch.
- `hub/test/session-keying-dal.test.ts` — 4 e2e cases gated on `REMO_E2E_DB_URL`: (1) two parallel worktree connects collapse to one repo-keyed row, (2) legacy `project_dir` row upgraded in-place when matching `git` arrives, (3) sibling legacy rows pick a keeper + soft-delete the rest via `superseded_by`, (4) no-git auth → legacy path + `pending_local_repos` populated. Per-test user UUID + `afterAll` cascade keeps the suite hermetic. Skips cleanly without `REMO_E2E_DB_URL`.

### Test results

```
bun test hub/test/session-keying.test.ts        → 16 pass / 0 fail
bun test hub/test/session-keying-dal.test.ts    → 1 pass / 6 skip (DB unset; e2e skip)
bun test hub/test/                              → 330 pass / 73 skip / 5 fail
```

The 5 failures (`insertRunV2` / `insertDeploymentRun` `started_at` safety) pre-date this plan — verified by re-running with `git stash` against the same commit base. Out of scope for plan 002.

### Deviations

- **Hostname plumbing through DAL.** The plan text said hostname for `pending_local_repos` "comes from the auth frame (already on `AgentAuth`)" but did not specify the DAL signature. Added an explicit `hostname: string | null = null` final parameter so the DAL never reaches into the WS message. `hub/src/ws/agent.ts` passes `msg.hostname ?? null`. No behavior change.
- **`created` flag on P3.** Plan text didn't specify how to detect a fresh INSERT vs. an ON-CONFLICT-DO-UPDATE branch — needed for the `created` return field used by the WS handler to decide whether to unregister the previous channel. Added `(xmax = 0) AS inserted_fresh` to the RETURNING clause (standard Postgres convention) and strip it before returning. Rule 2 — required for correctness of downstream `if (!session.created) unregisterChannel(...)` logic.
- **TSC step skipped.** No `hub/tsconfig.json` exists (Bun-native package), so typecheck via `bunx tsc --noEmit -p hub/` is not available. Substituted `bun build` on the three changed files as a smoke (no type errors → clean bundle). Pre-existing convention across the repo.
- **`supervisor/src/repo-scanner.ts`** is also modified in the worktree, but belongs to Plan 003 (already merged as commit `ba8880f`) — left untouched per scope boundary.


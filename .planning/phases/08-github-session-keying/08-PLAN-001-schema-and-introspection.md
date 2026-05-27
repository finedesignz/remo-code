---
plan_id: 08-PLAN-001-schema-and-introspection
phase: 08-github-session-keying
wave: 1
depends_on: []
est_minutes: 90
acceptance_criteria:
  - Schema migration adds `repo_key`, `github_owner`, `github_repo`, `superseded_by` columns + partial unique index `idx_sessions_user_repo_key` + tables `dismissed_local_sessions` and `pending_local_repos`. All `CREATE ... IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`.
  - Shared introspection module `supervisor/src/git-introspect.ts` exposes `introspect(cwd: string): GitIntrospection` using `spawnSync` with arg-vectors (NEVER `shell: true`, never string concatenation). Module is importable from both supervisor and hub-side tests.
  - `parseGitRemote` handles SSH (`git@github.com:Owner/Repo.git`), HTTPS (`https://github.com/Owner/Repo/`), `ssh://git@github.com/...`; lowercases owner/repo; returns null for non-github hosts and empty strings.
  - `buildRepoKey({ owner, repo })` returns `github://<lower>/<lower>`.
  - Unit tests in `hub/test/session-keying.test.ts` cover all parse cases listed in ARCHITECTURE §11.
  - Agent test `supervisor/test/git-introspect.test.ts` covers: real `git init` no remote, SSH GitHub remote, `git worktree add` sibling, non-git directory.
  - `bun test hub/test/session-keying.test.ts supervisor/test/git-introspect.test.ts` green.
  - `bun run dev:hub` boots cleanly after migration (no schema errors in logs).
files_modified:
  - hub/src/db/schema.sql
  - hub/src/db/migrate.ts
  - supervisor/src/git-introspect.ts
  - hub/src/lib/repo-key.ts
  - hub/test/session-keying.test.ts
  - supervisor/test/git-introspect.test.ts
---

# Plan 08-001 — Schema migration + shared git introspection

## Goal

Lay the foundation: additive schema for github-keyed sessions and the deterministic git introspection module that both supervisor scans and (legacy) agent auth will call. No behavior change yet — DAL still uses the v1 path.

## Scope

- DB only adds columns/tables/indexes; no data backfill.
- `git-introspect.ts` is pure: takes `cwd`, returns `GitIntrospection`. No WS, no DB.
- Repo-key construction lives in a tiny shared helper consumed by hub + supervisor.

## Files

Create:
- `C:/Users/artic/GitHub/remo-code/supervisor/src/git-introspect.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/lib/repo-key.ts`
- `C:/Users/artic/GitHub/remo-code/hub/test/session-keying.test.ts`
- `C:/Users/artic/GitHub/remo-code/supervisor/test/git-introspect.test.ts`

Edit:
- `C:/Users/artic/GitHub/remo-code/hub/src/db/schema.sql`
- `C:/Users/artic/GitHub/remo-code/hub/src/db/migrate.ts` (only if statement-splitting needs adjustment; per the PR #63 parser fix plain `ALTER TABLE ... IF NOT EXISTS` works without `DO $$` blocks)

## Tasks

<task id="T1">
<action>Append to `hub/src/db/schema.sql` the exact DDL from ARCHITECTURE.md §1 — four `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS` statements (`repo_key`, `github_owner`, `github_repo`, `superseded_by` with FK to sessions(id) ON DELETE SET NULL), the partial unique index `idx_sessions_user_repo_key` (WHERE `repo_key IS NOT NULL AND is_rootless = false AND deleted_at IS NULL`), `idx_sessions_superseded` (partial), and the two new tables `dismissed_local_sessions` and `pending_local_repos` with their indexes. Use plain `ALTER` / `CREATE TABLE IF NOT EXISTS` — no `DO $$ ... $$` blocks (parser handles them now per PR #63 but plain is simpler).</action>
<verify>Run `bun run dev:hub` against a fresh Postgres; `\d sessions` shows new columns; `\d dismissed_local_sessions` and `\d pending_local_repos` exist. Re-run migration → no errors (idempotent).</verify>
</task>

<task id="T2">
<action>Create `hub/src/lib/repo-key.ts` exporting:
- `type GitOriginGithub = { owner: string; repo: string }`
- `parseGitRemote(remote: string | null | undefined): GitOriginGithub | null` — regex match against the three URL forms in ARCHITECTURE §2.4, case-insensitive on host, strip trailing `.git` / `/`, lowercase both fields. Return null for non-github hosts, empty strings, or unparseable input.
- `buildRepoKey(o: GitOriginGithub): string` → `` `github://${o.owner.toLowerCase()}/${o.repo.toLowerCase()}` ``.
No deps beyond the standard lib.</action>
<verify>Imported by tests in T4.</verify>
</task>

<task id="T3">
<action>Create `supervisor/src/git-introspect.ts`:
```ts
export type GitIntrospection = {
  is_git_repo: boolean;
  is_worktree: boolean;
  worktree_parent_path: string | null;
  git_remote: string | null;
  git_origin_github: { owner: string; repo: string } | null;
};
export function introspect(cwd: string): GitIntrospection;
```
Implement per ARCHITECTURE §2 algorithm. SECURITY: every subprocess call uses `spawnSync` with an arg-vector. Never `shell: true`. Never string-concatenate `cwd` into a command. Pass `cwd` via the `-C` flag (still as a separate arg).

1. `spawnSync('git', ['-C', cwd, 'rev-parse', '--git-dir'])` → `is_git_repo`.
2. `spawnSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'])` and compare to `--git-dir`; mismatch → `is_worktree=true`. Compute `worktree_parent_path` as `dirname(dirname(common_dir))` (the `.../repo/.git` → `.../repo`).
3. As backup, sniff `<cwd>/.git` as a file with `gitdir:` prefix when `--git-common-dir` is unavailable.
4. `spawnSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'])` → `git_remote` (trim) or null.
5. Call `parseGitRemote(git_remote)` from `hub/src/lib/repo-key.ts` (relative import path is fine since both are TS source in the bun workspace). Result → `git_origin_github`.

Wrap each `spawnSync` in try/catch — any failure yields the appropriate null/false default. No throws from this module.</action>
<verify>`bun test supervisor/test/git-introspect.test.ts` (created in T5) passes.</verify>
</task>

<task id="T4">
<action>Create `hub/test/session-keying.test.ts` with the parse-cases from ARCHITECTURE §11:
- `parseGitRemote('git@github.com:Owner/Repo.git')` → `{owner:'owner', repo:'repo'}`
- `parseGitRemote('https://github.com/Owner/Repo/')` → same
- `parseGitRemote('https://github.com/Owner/Repo')` → same
- `parseGitRemote('ssh://git@github.com/Owner/Repo')` → same
- `parseGitRemote('git@gitlab.com:foo/bar.git')` → null
- `parseGitRemote('')` → null
- `parseGitRemote(null)` → null
- `buildRepoKey({owner:'Foo', repo:'Bar'})` → `'github://foo/bar'`
Use `bun:test`'s `describe`/`test`/`expect`.</action>
<verify>`bun test hub/test/session-keying.test.ts` all green.</verify>
</task>

<task id="T5">
<action>Create `supervisor/test/git-introspect.test.ts`. Use `node:fs`, `node:os`, `node:path`, and `child_process.spawnSync` (arg-vector form — NEVER `exec` with a concatenated string) to build temp git repos:
- Test 1: empty dir → `is_git_repo:false`.
- Test 2: `spawnSync('git', ['init'], { cwd: tmpdir })` only → `is_git_repo:true, git_remote:null, git_origin_github:null, is_worktree:false`.
- Test 3: init + `spawnSync('git', ['remote','add','origin','git@github.com:Acme/Widget.git'], { cwd: tmpdir })` → `git_origin_github:{owner:'acme',repo:'widget'}`.
- Test 4: init in parent, `spawnSync('git', ['worktree','add','../sibling'], { cwd: parent })`, then introspect the sibling → `is_worktree:true`, `worktree_parent_path` ends with the parent dir name.
Skip the suite if `git` isn't on PATH (probe with `spawnSync('git', ['--version'])`).</action>
<verify>`bun test supervisor/test/git-introspect.test.ts` all green on Windows + Linux.</verify>
</task>

## Verification

```bash
cd C:/Users/artic/GitHub/remo-code
bun test hub/test/session-keying.test.ts
bun test supervisor/test/git-introspect.test.ts
bun run dev:hub   # boots, applies migration cleanly
```

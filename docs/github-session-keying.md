# GitHub-Keyed Sessions (Phase 08)

Sessions are identified by their GitHub origin (`github://owner/repo`) rather than by the local `project_dir` they happen to be opened from. All worktrees, clones, and checkouts of the same repo on the same machine — or across machines for the same user — collapse to one session row, one conversation history, one sidebar entry.

Design source of truth: `.planning/phases/08-github-session-keying/ARCHITECTURE.md`. This doc is the operational reference.

## Why

Per the parallel-worktree mandate (CLAUDE.md rule #20), a user routinely has `remo-code`, `remo-code-feat-foo`, `remo-code-feat-bar` checked out side-by-side. Before Phase 08, each worktree produced its own session row and its own chat history, fragmenting context. GitHub-keying makes "the repo" the unit of conversation; worktrees become metadata.

## Repo-key derivation

A repo key is `github://<owner>/<repo>`, lower-cased, computed from the supervisor's git introspection.

Origin URL forms recognized (case-insensitive on host):

- SSH:                `git@github.com:Owner/Repo.git`
- HTTPS:              `https://github.com/Owner/Repo[.git][/]`
- SSH-with-protocol:  `ssh://git@github.com/Owner/Repo[.git]`

Anything else (GitLab, Bitbucket, self-hosted, forks pointing at a non-GitHub remote) returns `git_origin_github: null` and falls into the local-only path (see *Pending local repos* below). Only the `origin` remote is consulted — other remotes are ignored.

Edge cases (see ARCHITECTURE §10 for the full table): detached HEAD, submodule cwd, monorepo subfolder, fork, repo with no commits yet, and bare repo all behave as documented there.

## Session resolution algorithm

`hub/src/db/dal.ts::findOrCreateAgentSessionV2` wraps the priority-1/2/3 algorithm in a single `BEGIN…COMMIT` with `FOR UPDATE` row locks so concurrent worktree connects can't race.

```
INPUT: userId, projectDir, tokenHash, cliKind, git?

If no git, or !git.is_git_repo, or !git.git_origin_github:
  upsert pending_local_repos(user, hostname, project_dir, is_git_repo)
  return legacy findOrCreateAgentSession (project_dir-keyed)

repoKey = "github://" + lower(owner) + "/" + lower(repo)

BEGIN TRANSACTION

  -- P1: existing github-keyed row for this user
  row = SELECT * FROM sessions
        WHERE user_id=$1 AND repo_key=$2
          AND is_rootless=false AND deleted_at IS NULL
        FOR UPDATE
  If row: UPDATE token_hash, project_dir, last_activity; return row.

  -- P2: legacy (repo_key IS NULL) row whose project_dir matches the
  -- connecting path OR worktree_parent_path. Pick the most-recently
  -- active as keeper; supersede the rest.
  legacy = SELECT * FROM sessions
           WHERE user_id=$1 AND repo_key IS NULL
             AND is_rootless=false AND deleted_at IS NULL
             AND project_dir = ANY([projectDir, worktree_parent_path])
           ORDER BY last_activity DESC NULLS LAST
           FOR UPDATE
  If legacy non-empty:
    keeper = legacy[0]
    UPDATE keeper SET repo_key, github_owner, github_repo, …
    FOR each other in legacy[1..]:
      UPDATE SET superseded_by = keeper.id, deleted_at = now()
    return keeper.

  -- P3: brand-new repo-keyed row, protected by the partial unique index.
  INSERT INTO sessions (…repo_key, github_owner, github_repo…)
    ON CONFLICT (user_id, repo_key) WHERE repo_key IS NOT NULL
                                      AND is_rootless = false
                                      AND deleted_at IS NULL
    DO UPDATE SET token_hash = EXCLUDED.token_hash, last_activity = now()
  return inserted.

COMMIT
```

The partial unique index `idx_sessions_user_repo_key` makes P3's `ON CONFLICT` correct. Rootless rows (`is_rootless=true`) and local-only rows (`repo_key IS NULL`) are excluded from the constraint so they never collide.

Tokens: when the supervisor uploads inventory (no runner yet attached) it calls the DAL with `tokenHash=null`. In that case P1 preserves the existing `token_hash`, and P3 inserts a synthetic marker (`pending_supervisor_inventory`). A real runner connect via `/ws/agent` then overwrites the marker through P1.

## Pending-local-repos flow

Folders that are not git repos, or are git repos with no GitHub origin, never get a `repo_key`. They are tracked in `pending_local_repos(user_id, hostname, project_dir, is_git_repo, first_seen_at, last_seen_at)` so the web UI can prompt the user.

- The supervisor reports them on every `supervisor.repo_inventory` (see `hub/src/ws/supervisor-protocol.ts`).
- The hub upserts (`ON CONFLICT … DO UPDATE SET last_seen_at = now()`).
- The Sidebar's **Needs attention** section renders rows from `GET /api/sessions/pending-prompts`.
- **Create on GitHub** → `POST /api/sessions/:id/create-github-repo` (see *Create-on-GitHub flow* below).
- **Dismiss** → `POST /api/sessions/dismiss-local` inserts into `dismissed_local_sessions` and deletes the matching `pending_local_repos` row. The `pending-prompts` query LEFT JOINs against `dismissed_local_sessions` so dismissed folders never reappear, even if the supervisor re-reports them on the next scan.

## Launch flow

Sessions are never auto-spawned. The user clicks **Launch Claude Code** / **Launch Codex** on a session row in the web UI.

```
Web UI
  POST /api/sessions/:id/launch   { cli_kind?, local_path? }
Hub
  - look up session (must be user's, not online, has cwd)
  - resolve cwd:
      1. caller-supplied `local_path` — must match an entry in the supervisor
         inventory for this session's repo_key, else 400 invalid_local_path
      2. repo_key → supervisor inventory canonical path
      3. session.project_dir (legacy)
  - if no cwd → 409 local_path_missing { repo_key, suggested_clone_dir }
  - mint launch nonce (5 min)
  - WS send to supervisor:
      { type: 'session.launch', run_id, session_id, cli_kind, cwd,
        api_key: <nonce>, system_prompt }
  - 202 { launching: true, run_id }
Supervisor
  - spawn runner (claude or codex) in cwd
  - reuse the existing run_started / run_output / run_finished events;
    hub flips sessions.status (offline → thinking → online)
```

Canonical cwd selection (see ARCHITECTURE §15): when multiple local checkouts of the same repo exist, the supervisor prefers a non-worktree over a worktree, and shorter paths over longer ones. The user can override that choice via the Sidebar's Launch dropdown (Phase 08.6); the picker is populated from `session.local_paths[]` which mirrors `getKnownLocalPathsForRepoKey()` in `hub/src/ws/supervisor-registry.ts`.

## Phase 08.6 — one row per repo + worktree picker

`GET /api/sessions` enriches each row with a `local_paths: Array<{ local_path, branch, is_worktree, canonical }>` field, sourced from the per-user inventory cache. The web Sidebar collapses any duplicate `repo_key` rows (defensive — DB dedupe via the partial unique index on `(user_id, repo_key)` is the primary mechanism) and the `LaunchButton` shows a `<select>` next to the button when `local_paths.length > 1` so the user picks a worktree/branch before launching. The selected path is sent as `local_path` in the `POST /api/sessions/:id/launch` body and validated against the inventory cache server-side (no arbitrary cwd injection).

To populate `branch`, `supervisor/src/git-introspect.ts` now runs `git symbolic-ref --short HEAD` per scanned repo (null on detached HEAD). The wire field is optional/back-compat — pre-0.5 supervisors that don't ship branch info still work; the picker simply omits the branch suffix.

### Connections repo-list worktree hide (scan enrichment)

The **settings → Connections** repo table is fed by `POST /api/supervisors/:id/scan`
(`repo.scan` → the legacy `scanAll`/`ScannedRepo` shape), which is a *different*
path from `GET /api/sessions`/`repo_inventory` and carries **no** worktree
introspection. PR #249 added a web filter (`SupervisorPage`) to hide worktrees /
non-canonical sibling clones, but the scan rows never carried `is_worktree` /
`is_canonical`, so the filter was inert and worktrees + branch-checkout sibling
clones still cluttered the list.

Fix (no new supervisor MSI): the hub `/scan` handler now joins each scanned repo
to the supervisor's already-stored `repo_inventory` (the introspection scan, which
*does* carry `is_worktree` + `canonical`) by normalized `local_path` and stamps
`is_worktree` / `is_canonical` onto the response
(`hub/src/api/supervisors.ts::enrichScanWithInventory`). The web filter predicate
is `isWorktreeOrNonCanonicalRepo()` in `web/src/lib/session-list.ts` (single source
of truth; absent flags → shown, so legacy/unenriched entries still render). The
sidebar/session-list path was already correct (collapse by `repo_key`); only the
Connections list was broken. Tests: `hub/test/scan-worktree-enrich.test.ts`,
`web/test/session-list.test.ts`.

## Create-on-GitHub flow

For folders in **Needs attention**, the user can promote a local repo to a fresh GitHub repo:

```
Web UI
  POST /api/sessions/:id/create-github-repo
    { visibility: 'private' | 'public', org?, name? }
Hub
  - gate: must have a local_path; supervisor must be online
  - probe GitHub App scope via the gateway pair:
      GET {GATEWAY_URL}/api/credentials/service/github
    needs administration:write + contents:write
  - if missing scope → 412 github_app_missing_scope
  - enqueue in-memory job; return 202 { job_id, status: 'queued' }
Background job (hub)
  - Octokit: create empty repo under the user's GitHub App installation
  - WS send to supervisor:
      { type: 'create_local_repo_and_push',
        session_id, owner, name, visibility, remote_url }
Supervisor
  - git init (if needed) → add -A → commit -m "Initial commit"
  - git remote add origin <remote_url>
  - git push -u origin HEAD
  - re-run introspection → emit fresh supervisor.repo_inventory
  - hub takes the P2 (legacy → repo-keyed upgrade) path on the next auth
Progress
  - WS broadcasts repo_create_progress { job_id, stage, percent }
```

GitHub credentials are fetched via the gateway pair on every job — there is no `GITHUB_TOKEN` env var on the hub (per the MCP server auth architecture in the repo CLAUDE.md). When the GitHub App installation lacks `administration: write`, the Create button is greyed out client-side; servers still return 412 if a call slips through.

The agent reports the same git origin twice (the user can lie about it — see ARCHITECTURE §9), so this is a labeling decision, not an authorization one. The push target is hub-authoritative.

## Schema reference

All additive, all idempotent. Applied by `hub/src/db/migrate.ts`. Full DDL in `hub/src/db/schema.sql`.

New columns on `sessions`:

| Column          | Type | Notes                                                              |
| --------------- | ---- | ------------------------------------------------------------------ |
| `repo_key`      | TEXT | `github://owner/repo` lower-cased, or NULL for local-only          |
| `github_owner`  | TEXT | denorm for sidebar rendering                                       |
| `github_repo`   | TEXT | denorm for sidebar rendering                                       |
| `superseded_by` | TEXT | FK back to `sessions(id)`; set on legacy rows collapsed by P2      |

New indexes:

- `idx_sessions_user_repo_key` (UNIQUE) on `(user_id, repo_key)` WHERE `repo_key IS NOT NULL AND is_rootless = false AND deleted_at IS NULL` — enforces "one session per repo per user".
- `idx_sessions_superseded` on `superseded_by` WHERE `superseded_by IS NOT NULL`.

New tables:

- `dismissed_local_sessions(user_id, hostname, project_dir, dismissed_at)` PK `(user_id, hostname, project_dir)`.
- `pending_local_repos(user_id, hostname, project_dir, is_git_repo, first_seen_at, last_seen_at)` PK same.

Rollback is dropping the four columns + two new tables + the partial unique index; the legacy `project_dir` path still works. Zero data loss.

## REST endpoints

All JWT-authed, per-user scoped, Zod-validated. Routes mounted under `/api/sessions/*` in `hub/src/api/sessions.ts`.

### `GET /api/sessions/pending-prompts`

```bash
curl https://app.remo-code.com/api/sessions/pending-prompts \
  -H "Authorization: Bearer $JWT"
# → { "pending": [{ hostname, project_dir, is_git_repo,
#                   first_seen_at, last_seen_at }, ...] }
```

### `POST /api/sessions/dismiss-local`

```bash
curl -X POST https://app.remo-code.com/api/sessions/dismiss-local \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"my-host","project_dir":"C:/Users/me/sketches"}'
# → { "dismissed": true }
```

### `POST /api/sessions/:id/launch`

```bash
curl -X POST https://app.remo-code.com/api/sessions/sess_abc/launch \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"cli_kind":"claude"}'
# 202 → { "launching": true, "run_id": "<uuid>" }
# 409 → { "error": "local_path_missing",
#         "repo_key": "github://acme/widget",
#         "suggested_clone_dir": "C:/Users/me/GitHub/widget" }
```

### `POST /api/sessions/:id/clone-here`

```bash
curl -X POST https://app.remo-code.com/api/sessions/sess_abc/clone-here \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"target_root":"C:/Users/me/GitHub"}'
# 202 → { "cloning": true, "req_id": "<uuid>",
#         "target_path": "C:/Users/me/GitHub/widget" }
```

`target_root` is optional; if omitted the hub picks the first root from the supervisor's inventory. The path must be inside one of the supervisor's configured roots — paths outside return 400.

### `POST /api/sessions/:id/create-github-repo`

```bash
curl -X POST https://app.remo-code.com/api/sessions/sess_abc/create-github-repo \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{"visibility":"private","name":"widget"}'
# 202 → { "job_id": "<uuid>", "status": "queued" }
# 412 → { "error": "github_app_missing_scope",
#         "missing_scope": "administration:write",
#         "kind": "github_app",
#         "detail": "..." }
```

## Test plan

- Unit: `hub/test/session-keying.test.ts` (parsing + key building).
- DAL e2e: `hub/test/session-keying-dal.test.ts` — concurrent worktrees, legacy upgrade, sibling supersede, no-git fallback (gated on `REMO_E2E_DB_URL`).
- REST: `hub/test/sessions-launch.test.ts`, `hub/test/sessions-pending.test.ts`.
- Headline e2e: `hub/test/phase-08.e2e.test.ts` — two supervisor connections from different worktrees of the same repo converge on one session row (gated on `REMO_E2E_DB_URL`).
- Triage / classifier-adjacent: `hub/test/triage-schema.test.ts`, `hub/test/coolify-webhook-triage-e2e.test.ts` (Phase 06; unrelated but exercises the same DAL).

## References

- `.planning/phases/08-github-session-keying/ARCHITECTURE.md` — design source of truth.
- `hub/src/db/dal.ts` — `findOrCreateAgentSessionV2`, `getPendingPrompts`, `dismissLocalSession`, `upsertPendingLocalRepoBatch`.
- `hub/src/lib/repo-key.ts` — `parseGitRemote`, `buildRepoKey`.
- `hub/src/api/sessions.ts` — REST endpoints listed above.
- `hub/src/ws/agent.ts` — auth-frame `git` field handler.
- `hub/src/ws/supervisor-protocol.ts` — `SupervisorRepoInventory`, `SessionLaunch`.
- `hub/src/ws/supervisor-registry.ts` — in-memory inventory cache used by `/launch` + `/clone-here`.
- `supervisor/src/` — supervisor-side scanning, runner spawn, push driver.
- `web/src/components/Sidebar.tsx` — Needs-attention section, Launch / Clone buttons.

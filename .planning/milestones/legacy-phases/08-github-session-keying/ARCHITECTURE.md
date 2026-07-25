# Phase 08 — GitHub-Backed Session Keying

**Status:** design (not implemented)
**Branch (planned):** `feat/phase-08-github-session-keying`
**Owner:** Backend Architect
**Date:** 2026-05-26

## Problem

Sessions are keyed by `(user_id, project_dir)` (see `hub/src/db/dal.ts::findOrCreateAgentSession` + `idx_sessions_user_project`). A user with N git worktrees of the same repo (e.g. `remo-code`, `remo-code-w3`, `remo-code-w4` — see CLAUDE.md rule #20) gets N sidebar entries and N separate conversation histories for what is logically the same project. With the parallel-worktrees mandate, this is now the steady-state pain.

## Goal

Collapse all worktrees/clones of one GitHub repo into ONE Claude Code session per user. Leave rootless/ambient (Phase 05) and supervisor sessions untouched. Keep migration lazy.

## Non-Goals

- Cross-user session sharing.
- Multi-repo / monorepo / submodule support beyond "use `origin` only".
- Reworking supervisor `repo_path` semantics or `paused_repos` (those are correctly path-keyed).
- Removing `project_dir` — it stays as metadata for the *currently connected* runner + UI breadcrumbs.

## Scope Expansion (2026-05-26): Tauri Supervisor Is Now The Only Local Runner

The CLI agent path (`claude-remote` / `npx remo-code-agent`) is being **retired**. The Tauri supervisor desktop app is now THE single local entry point. Implications baked into this doc:

- The Tauri app launches anywhere on disk — not tied to a cwd. It opens one WS connection to the hub at startup and keeps it open for the life of the app.
- It owns a user-configured set of **roots** (directories under which the user keeps local repos). On launch, it scans them, computes git introspection per repo (§2), and reports the whole inventory to the hub in one payload. The hub upserts sessions per github-key (§4).
- Claude Code (and Codex) subprocesses are **spawned on demand** by the Tauri app when the user clicks "Launch" in the web UI. Multiple subprocesses are multiplexed over the single WS connection.
- The agent CLI binary stays buildable for one release with WS back-compat preserved (its existing auth frame still parses on the hub) — `agent/` package gets a deprecation README and is removed in Phase 09.

The github-keying core (§1–§5) is unchanged. The Tauri supervisor takes over the role the agent CLI played in §2–§3 (introspection + auth frame) and additionally drives **session discovery** + **launch directives** (§15–§17 below).

---

## 1. Schema Changes

All additive, all idempotent. Migration applied by existing `hub/src/db/migrate.ts`.

```sql
-- The new identity column. Format: 'github://owner/repo' lower-cased.
-- NULL = legacy / local-only / pending classification. Project-dir lookup still works.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS repo_key TEXT;

-- One row per (user, repo) for GitHub-backed sessions. Rootless rows
-- (is_rootless=true) and local-only rows (repo_key IS NULL) are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_user_repo_key
  ON sessions(user_id, repo_key)
  WHERE repo_key IS NOT NULL AND is_rootless = false AND deleted_at IS NULL;

-- Display origin (owner/repo) for the sidebar. Cheap denorm so we don't parse repo_key on every render.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS github_owner TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS github_repo  TEXT;

-- Pointer to the row that superseded this one during lazy migration. NULL = current.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS superseded_by TEXT REFERENCES sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_superseded ON sessions(superseded_by) WHERE superseded_by IS NOT NULL;

-- Per-(user, hostname, project_dir) dismissals so the "create or dismiss" prompt
-- never re-appears for a folder the user said no to.
CREATE TABLE IF NOT EXISTS dismissed_local_sessions (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname    TEXT NOT NULL,
  project_dir TEXT NOT NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hostname, project_dir)
);

-- Folders the agent has reported as "not on GitHub yet" — surfaced in the
-- Connect modal so the user can pick Create or Dismiss without the agent re-
-- announcing. Refreshed on every agent connect.
CREATE TABLE IF NOT EXISTS pending_local_repos (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hostname     TEXT NOT NULL,
  project_dir  TEXT NOT NULL,
  is_git_repo  BOOLEAN NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, hostname, project_dir)
);
CREATE INDEX IF NOT EXISTS idx_pending_local_repos_user ON pending_local_repos(user_id);
```

**NULL semantics:** `repo_key IS NULL` is valid forever — it identifies a local-only or unclassified session. The partial unique index excludes those rows so we never collide on NULL.

---

## 2. Agent-Side Git Introspection

A single module `agent/src/git-introspect.ts`. Pure, synchronous, no shell-injection risk (uses `spawnSync` with arg vectors, never `shell:true`).

Output type:

```ts
type GitIntrospection = {
  is_git_repo: boolean;
  is_worktree: boolean;
  worktree_parent_path: string | null;   // absolute path of the canonical .git directory's parent
  git_remote: string | null;             // raw `origin` URL, may be SSH or HTTPS
  git_origin_github: { owner: string; repo: string } | null;
};
```

### Detection algorithm

1. **Is a git repo?** `git -C <cwd> rev-parse --git-dir`. Exit 0 → yes. Stderr `"not a git repository"` → no.
2. **Is a worktree?** Read `<cwd>/.git`. If it's a **file** (not a directory) whose first line is `gitdir: <path>` and `<path>` contains `/.git/worktrees/`, then `is_worktree=true` and `worktree_parent_path = dirname(dirname(dirname(<path>)))`. (The chain `.../<repo>/.git/worktrees/<name>` → parent is `.../<repo>`.)
   - Robustness: also accept `git rev-parse --path-format=absolute --git-common-dir` (returns `.../<repo>/.git` for a worktree; same for main). If it differs from `--git-dir`, it's a worktree. This is the canonical method — the file-sniff is a backup for stale checkouts.
3. **Origin URL:** `git -C <cwd> remote get-url origin`. Trim. Missing/no-remote → `git_remote = null`.
4. **GitHub parse:** regex-match the URL against these forms:
   - SSH: `^git@github\.com:([^/]+)/(.+?)(?:\.git)?/?$`
   - HTTPS: `^https?://github\.com/([^/]+)/(.+?)(?:\.git)?/?$`
   - SSH-with-protocol: `^ssh://git@github\.com/([^/]+)/(.+?)(?:\.git)?/?$`
   - Case-insensitive on host; lowercase owner + repo for the key.
   - Anything else (gitlab, bitbucket, self-hosted, fork over a non-github remote) → `git_origin_github = null`. Per spec we only collapse on github.com.
5. **Detached HEAD / submodule / bare repo:** all fine — they still answer the questions above. We don't care about `HEAD` state for keying.

### When the agent runs introspection

- Once at startup before opening the WS.
- Re-run on `SIGHUP` (optional) and on any explicit `re-introspect` hub message (used after `create-github-repo` finishes pushing — the remote now exists).

---

## 3. WS Auth Frame Additions

Extend `AgentAuth` in `hub/src/ws/agent-protocol.ts`. All fields optional → old agents still work.

```ts
export const GitIntrospection = z.object({
  is_git_repo: z.boolean(),
  is_worktree: z.boolean(),
  worktree_parent_path: z.string().nullable(),
  git_remote: z.string().nullable(),
  git_origin_github: z.object({
    owner: z.string().min(1).max(100),
    repo:  z.string().min(1).max(100),
  }).nullable(),
}).passthrough();

export const AgentAuth = z.object({
  // ...existing fields...
  git: GitIntrospection.optional(),
});
```

Backward compat: if `msg.git` is absent, hub treats the session exactly like today (project_dir-keyed).

---

## 4. Hub-Side Session Resolution

New DAL function: `findOrCreateAgentSessionV2(userId, projectDir, tokenHash, cliKind, git)`. Wraps everything in a single transaction so concurrent worktree connects can't race.

### Algorithm

```
INPUT: userId, projectDir, tokenHash, cliKind, git (optional)

IF git is missing or !git.is_git_repo or !git.git_origin_github:
    # No GitHub identity — fall through to legacy path.
    upsert into pending_local_repos (user, hostname, projectDir, is_git_repo=git?.is_git_repo ?? false)
    RETURN legacy findOrCreateAgentSession(userId, projectDir, tokenHash, cliKind)
    # Sidebar will show this as a "Local folder — Create on GitHub?" row (see UI §7).

repoKey = `github://${git.git_origin_github.owner.toLowerCase()}/${git.git_origin_github.repo.toLowerCase()}`

BEGIN TRANSACTION

  # Priority 1: existing github-keyed row.
  row = SELECT * FROM sessions
        WHERE user_id=$1 AND repo_key=$2 AND is_rootless=false AND deleted_at IS NULL
        FOR UPDATE

  IF row exists:
      UPDATE sessions
         SET token_hash = $tokenHash,
             project_dir = $projectDir,   -- bookkeeping: currently-connected path
             last_activity = now()
       WHERE id = row.id
      RETURN { row, created: false, repo_keyed: true }

  # Priority 2: legacy project_dir-keyed row eligible for upgrade.
  # ANY of this user's existing rows whose project_dir is the worktree itself
  # OR is the worktree_parent_path. We pick the most-recently-active one and
  # supersede the rest (collapsing N worktree rows into 1).
  candidate_paths = [projectDir, git.worktree_parent_path].filter(Boolean)
  legacy_rows = SELECT * FROM sessions
                WHERE user_id=$1 AND repo_key IS NULL AND is_rootless=false
                  AND deleted_at IS NULL AND project_dir = ANY($candidate_paths)
                ORDER BY last_activity DESC NULLS LAST
                FOR UPDATE

  IF legacy_rows non-empty:
      keeper = legacy_rows[0]
      UPDATE sessions
         SET repo_key = $repoKey,
             github_owner = $owner, github_repo = $repo,
             token_hash = $tokenHash,
             last_activity = now()
       WHERE id = keeper.id
      # Supersede any sibling legacy rows (other worktree of same repo).
      FOR each other in legacy_rows[1..]:
          UPDATE sessions SET superseded_by = keeper.id, deleted_at = now()
           WHERE id = other.id
      RETURN { row: keeper, created: false, repo_keyed: true, migrated: true }

  # Priority 3: brand-new repo-keyed row.
  INSERT INTO sessions (user_id, name, project_dir, token_hash, cli_kind,
                        repo_key, github_owner, github_repo)
  VALUES (..., $owner||'/'||$repo, ..., $repoKey, $owner, $repo)
  ON CONFLICT (user_id, repo_key) WHERE repo_key IS NOT NULL AND is_rootless=false AND deleted_at IS NULL
  DO UPDATE SET token_hash = EXCLUDED.token_hash, last_activity = now()
  RETURNING *

COMMIT
```

The `FOR UPDATE` + the partial unique index together prevent duplicate-key races when worktree A and worktree B authenticate within milliseconds of each other. The `ON CONFLICT … DO UPDATE` handles the final-mile race where two transactions both miss in the SELECT but only one wins the INSERT.

### Worktree → hide

The agent's `project_dir` for a worktree is the worktree path (e.g. `C:/Users/artic/GitHub/remo-code-feat-error-capture`). After the algorithm above runs, the session's `project_dir` is rewritten to the *currently-connecting* worktree, but **the row is the same row** as the canonical repo. The sidebar dedupes by `repo_key`, so worktrees never appear separately. The only worktree-specific UI is in the SessionTooltip → "Connected from: <worktree path>" (a metadata line, not a separate row).

---

## 5. Migration Plan from Legacy Rows

**Strategy:** lazy, on next agent connect. No background backfill, no data loss.

1. Deploy schema (additive ALTERs).
2. Old agents (no `git` field in auth) continue using legacy path. No change for them.
3. New agents send `git`. Algorithm §4 runs.
4. First time a worktree of a known repo connects, the keeper row is upgraded (`repo_key` set, `github_owner`/`github_repo` populated). Sibling legacy rows for sister worktrees are soft-deleted with `superseded_by` set.
5. Messages on superseded rows are **not** moved — they stay attached to their original `session_id`. The UI either (a) shows them in a "Previous histories" expander on the keeper row, or (b) ignores them. Recommendation: **(b) — ignore**. Users with worktrees rarely care about per-worktree history; surfacing two histories is the confusion we're trying to fix. Add a follow-up admin tool later if anyone asks. `superseded_by` is the audit trail.

**Rollback:** drop `repo_key`, `github_owner`, `github_repo`, `superseded_by` columns + the partial unique index. Legacy `project_dir` path still works. Zero loss.

---

## 6. REST Endpoints

All JWT-authed, per-user scoped, validated with Zod.

### `GET /api/sessions/pending-prompts`

Returns folders that have connected but have no GitHub remote AND have not been dismissed.

```ts
// Response
{
  pending: Array<{
    hostname: string;
    project_dir: string;
    is_git_repo: boolean;       // false = not a git repo at all; true = git repo with no GitHub remote
    first_seen_at: string;
    last_seen_at: string;
  }>;
}
```

Source: `pending_local_repos` LEFT JOIN `dismissed_local_sessions` WHERE dismissed row is NULL.

### `POST /api/sessions/dismiss-local`

```ts
// Request
{ hostname: string; project_dir: string; }
// Response
{ dismissed: true }
```

Inserts into `dismissed_local_sessions`. Also deletes the row from `pending_local_repos`. Idempotent (ON CONFLICT DO NOTHING).

### `POST /api/sessions/:id/create-github-repo`

```ts
// Request
{
  visibility: 'private' | 'public';   // default 'private'
  org?: string;                       // optional org under user's GitHub App installation
  name?: string;                      // defaults to current folder name
}
// Response (202 — long-running)
{ job_id: string; status: 'queued' }
```

Implementation outline (delegated to a background job, NOT inline in the request handler):

1. Resolve the target agent over WS (must be online and own the session). If offline → 409.
2. Verify GitHub App installation + permissions (see §8). On scope failure → 412 with `{ missing_scope: 'repo:write' }`.
3. Send a new WS message `agent → create_local_repo_and_push { session_id, owner, name, visibility, remote_url }` after the hub creates the empty repo via the GitHub App.
4. Agent runs: `git init` (if needed) → `git add -A && git commit -m "Initial commit"` (if no commits) → `git remote add origin <url>` → `git push -u origin HEAD`.
5. Agent re-runs introspection and re-authenticates (or sends a `re-introspect` follow-up). Hub takes the algorithm §4 priority-2 path (legacy → repo-keyed upgrade).
6. Job status surfaced via WS event `repo_create_progress { job_id, stage, percent }` (reuse the supervisor clone-progress pattern in `hub/src/ws/agent.ts:588`).

Job state is held in-memory + persisted as a `scheduled_task_runs`-style row only if we need durability across hub restarts. For v1, in-memory is fine — if the hub restarts mid-create, the user clicks Create again.

---

## 7. Frontend Changes

### `useSessions` hook

No shape change; `CodeSession` gains:

```ts
interface CodeSession {
  // ...existing...
  repo_key: string | null;
  github_owner: string | null;
  github_repo: string | null;
}
```

The hook also polls `GET /api/sessions/pending-prompts` once on mount + on WS `session_list` events; exposes `pendingPrompts: PendingPrompt[]`.

### Sidebar filtering

`Sidebar.tsx::connectedSessions` already filters by status. Add: when two rows would share a `repo_key`, the dedupe is already enforced by the DB (only one un-superseded row per key). No client-side dedup needed.

For pending local folders, render a new section **above** the session list:

```
NEEDS ATTENTION (2)
  📁 C:/.../my-side-project — Local folder        [Create on GitHub]  [Dismiss]
  📁 C:/.../sketches        — Not a git repo      [Create on GitHub]  [Dismiss]
```

Single row per `(hostname, project_dir)` from `/api/sessions/pending-prompts`. Buttons call the REST endpoints in §6.

### `<CreateGithubRepoModal>` (new)

Small modal launched from the Create button. Fields: name (prefilled from folder), visibility (radio, default Private), org (optional dropdown populated from GitHub App installations). Submit → POST → progress toast wired to WS `repo_create_progress` events.

### Tooltip

`SessionTooltip` shows `github.com/owner/repo` when `repo_key` is set, and (small text) `Connected from: <project_dir>` showing which worktree/clone is currently driving.

---

## 8. GitHub App Scope (rule #1 — verify, don't guess)

**Status: needs verification before implementation.** Before merging, run:

```
GET /api/credentials/service/github     # via the gateway pair
```

and inspect:

- For a GitHub App installation: the installation's `permissions` payload must include `contents: write` AND `administration: write` (the latter is required to create a new repo under a user/org). Verify against the live install via `GET /installation/repositories` and `GET /app` on the gateway-issued installation token.
- For a classic PAT fallback: scope `repo` (private repos) + `workflow` (if we touch workflows on push — we don't, in v1).

If the current GitHub App installation does NOT have `administration: write`:
- **Do not** silently degrade. Surface a clear error in the modal: *"This GitHub App installation can't create repos. Re-install with the 'Administration: write' permission, or use a PAT in Settings → Integrations → GitHub."*
- Track as a **follow-up phase deliverable**, not a blocker — Phase 08 ships with the Create button greyed-out + a tooltip when the install scope is missing. Users can still benefit from the worktree-dedupe behavior (which needs zero scopes).

Existing usage in `hub/src/scheduler/post-run/github-issue.ts` shows the gateway-pair contract (creds fetched via `GET {GATEWAY_URL}/api/credentials/service/github`). Reuse that path; do NOT add a `GITHUB_TOKEN` env var.

---

## 9. Threat Model

**The agent can lie about its git remote.** Accepted risk:

- The agent already runs arbitrary code on the user's machine. A lying agent could already do worse (exfiltrate files, mint API calls).
- A lying remote at worst causes the user's own session to be labeled `owner/repo` incorrectly. It does NOT cross user boundaries — the partial unique index is scoped `(user_id, repo_key)`.
- A lying remote cannot collide with another user's sessions (different `user_id`).
- For `create-github-repo`, the user explicitly confirms `owner` + `name` in the modal — the agent's reported remote isn't used. The push target is hub-authoritative.

**Conclusion:** trust the agent's introspection for labeling purposes only. Never trust it for authorization decisions.

---

## 10. Edge Cases

| Case | Behavior |
|---|---|
| Detached HEAD | Introspection still works (remote is unaffected). Keyed normally. |
| Submodule cwd | `git -C <cwd> remote get-url origin` returns the submodule's remote — that becomes the key. Likely correct (user opened the submodule deliberately). Document this in `docs/`. |
| Multiple remotes | Only `origin` is consulted. Other remotes are ignored. Future: a manual override in Settings if anyone asks. |
| Fork | `origin` points to the fork → keyed as the fork. Correct: forks are distinct repos. |
| Monorepo subfolder | The agent's `cwd` is inside the repo → `git rev-parse` walks up to the root → introspection returns the repo's remote. Keyed at the repo level. Worktrees of sub-projects within a monorepo all collapse to one session — consistent with the goal. |
| Repo with no commits yet | `is_git_repo=true`, `git_remote=null` → falls into "pending local" bucket → Create button works (the agent creates the initial commit). |
| Repo moved off GitHub | Old session has `repo_key='github://owner/repo'`. On next connect with no GitHub remote, the agent reports `git_origin_github: null`. The algorithm falls to legacy path → creates/uses a separate `project_dir`-keyed row. Old GitHub-keyed row stays as-is until user manually deletes. (Acceptable — moving off GitHub is rare.) |
| Two users, same repo | Different `user_id`s → no collision (partial unique index is per-user). Each user has their own session for `github://owner/repo`. |
| Repo renamed on GitHub | `origin` URL still resolves until the user updates it. Once `git remote set-url origin <new>`, the next connect produces a new `repo_key` → new session. Old one becomes orphaned (status=offline). Acceptable; show a "Repo renamed?" hint in tooltip when status has been offline >7d AND a same-user session with the same `github_repo` (case-insensitive) but different `github_owner` exists. Optional polish. |
| Worktree of a worktree | git allows this. `--git-common-dir` resolves to the original repo's `.git`. Same key. Works. |
| Bare repo | `cwd` is unusual. `is_worktree=false`. If origin is GitHub → keyed normally. Otherwise legacy. No special handling. |

---

## 11. Test Plan

### Unit (`hub/test/session-keying.test.ts`)

- `parseGitRemote('git@github.com:Owner/Repo.git')` → `{owner:'owner', repo:'repo'}`
- `parseGitRemote('https://github.com/Owner/Repo/')` → same
- `parseGitRemote('ssh://git@github.com/Owner/Repo')` → same
- `parseGitRemote('git@gitlab.com:foo/bar.git')` → `null`
- `parseGitRemote('')` → `null`
- `buildRepoKey({owner:'Foo', repo:'Bar'})` → `'github://foo/bar'`

### DAL (`hub/test/session-keying-dal.test.ts`, requires `REMO_E2E_DB_URL`)

- Concurrent `findOrCreateAgentSessionV2` calls for two worktrees of same repo → one row, both returns reference same id.
- Legacy row with matching `project_dir` → upgraded in-place, `repo_key` populated.
- Two sibling legacy rows (worktree A + worktree B) → first connect picks one as keeper, the other gets `superseded_by` set on next connect.
- Agent connects with no `git` field → legacy path, no `repo_key`, row appears in `listSessions`.

### Agent (`agent/test/git-introspect.test.ts`)

- Real `git init` in a tmpdir, no remote → `is_git_repo=true, git_origin_github=null`.
- Add `origin` SSH GitHub URL → parsed correctly.
- `git worktree add ../sibling` → introspection from sibling reports `is_worktree=true` and the parent path.
- Non-git directory → `is_git_repo=false`.

### E2E (`hub/test/phase-08.e2e.test.ts`)

- Spawn two simulated agents pointing at two worktrees of the same fake repo. Auth both. Assert: one row in `sessions`, both agents successfully receive `auth_ok` with the same `session_id`. Send a message to that session_id from a third "browser" client and assert it routes to the most-recently-authenticated agent (existing single-channel behavior).
- `POST /api/sessions/dismiss-local` removes the folder from `/api/sessions/pending-prompts`.

---

## 12. Rollout

**No feature flag.** The change is additive at the schema level and the WS protocol level. Old agents keep working unchanged. New agents get the new behavior immediately. Risk surface:

- The only mutating code path is `findOrCreateAgentSessionV2`. Wrap it in a transaction and unit-test concurrency.
- If a bug surfaces, set agents to omit the `git` field via a config flag (`REMO_DISABLE_GIT_INTROSPECT=1`) → fall back to legacy behavior end-to-end.
- Deploy off-peak hours per usual.

---

---

## 15. Tauri Supervisor: Roots Config + Session Discovery

### Roots config file

Path (platform-resolved by Tauri):
- Windows: `%APPDATA%\remo-code\supervisor.json`
- macOS:   `~/Library/Application Support/remo-code/supervisor.json`
- Linux:   `~/.config/remo-code/supervisor.json`

Shape:

```jsonc
{
  "version": 1,
  "hub_url": "https://app.remo-code.com",
  "api_key": "remo_xxx",
  "roots": [
    "C:/Users/artic/GitHub",
    "C:/Users/artic/Projects"
  ],
  "scan": {
    "max_depth": 2,          // do not walk arbitrarily deep; repos are at depth 1, worktree siblings at depth 0/1
    "ignore_globs": ["**/node_modules/**", "**/.next/**", "**/dist/**", "**/target/**"],
    "follow_symlinks": false
  },
  "last_scan_at": "2026-05-26T12:34:56Z"
}
```

### First-run UX (one-time prompt)

When `supervisor.json` is absent or `roots` is empty:

1. Tauri opens a "Welcome" window.
2. Pre-populated default per platform:
   - Windows → first existing of: `C:\Users\<user>\GitHub`, `C:\Users\<user>\Projects`, `C:\Users\<user>\source\repos`. Fallback: prompt with no default.
   - macOS/Linux → first existing of: `~/projects`, `~/code`, `~/GitHub`, `~/dev`. Fallback: prompt with no default.
3. User can accept, edit (folder picker), or add additional roots.
4. Validation: each root must exist + be readable. Reject paths that point inside system dirs (`Program Files`, `/System`, `/usr/bin`) — soft warning, allow override.
5. Save → trigger first scan → proceed to main window.

**Never re-prompt automatically.** Only re-asks when the user clicks Settings → Roots → Add (or removes the last root and saves an empty list, in which case we show the same welcome again).

### Settings → Roots panel (inside Tauri window)

- List of current roots with [Remove] per row.
- [Add root] → folder picker.
- [Re-scan now] button.
- "Last scanned: <relative time>" line.

### Scan algorithm

For each `root`:

1. Walk first-level children (depth 1) up to `max_depth`.
2. For each candidate dir, run §2's introspection.
3. Skip dirs matching `ignore_globs`.
4. Build `RepoEntry`:
   ```ts
   type RepoEntry = {
     local_path: string;          // absolute
     is_git_repo: boolean;
     is_worktree: boolean;
     worktree_parent_path: string | null;
     git_remote: string | null;
     git_origin_github: { owner: string; repo: string } | null;
   };
   ```
5. Group by `git_origin_github`. For each GitHub-keyed group, the supervisor picks the **canonical local path** preference: non-worktree > worktree with shorter path. That's the path used for `cwd` on launch (§16).
6. Local-only / non-git dirs are sent as individual entries → hub upserts them into `pending_local_repos`.

### Discovery WS message

New supervisor → hub message (extends `hub/src/ws/supervisor-protocol.ts`):

```ts
export const SupervisorRepoInventory = z.object({
  type: z.literal('supervisor.repo_inventory'),
  scanned_at: z.string(),
  repos: z.array(z.object({
    local_path: z.string(),
    is_git_repo: z.boolean(),
    is_worktree: z.boolean(),
    worktree_parent_path: z.string().nullable(),
    git_remote: z.string().nullable(),
    git_origin_github: z.object({ owner: z.string(), repo: z.string() }).nullable(),
  })).max(2000),       // soft cap; users with >2000 repos are out of scope for v1
});
```

Hub processing on receive: for each entry with a GitHub remote, take §4's algorithm priority-1/2/3 path — but **without** creating a `claude` runner. Sessions are upserted in `idle` state (status = `'offline'` because no runner is attached yet). For local-only entries, populate `pending_local_repos`.

---

## 16. Launch-On-Demand Flow

Sessions are **never** auto-spawned by the Tauri supervisor — the user explicitly clicks **Launch Claude Code** (or **Launch Codex**) on a session row in the web UI.

### REST: `POST /api/sessions/:id/launch`

```ts
// Request
{ cli_kind?: 'claude' | 'codex' }    // optional override; defaults to session.cli_kind
// Response
{ launching: true; run_id: string }   // 202 Accepted
```

Validates: session belongs to user, has a known `local_path` (resolved from `repo_key` + supervisor inventory), supervisor is online for this user, session is not currently `online`.

### WS: hub → supervisor `session.launch`

```ts
export const SessionLaunch = z.object({
  type: z.literal('session.launch'),
  run_id: z.string(),
  session_id: z.string(),
  cli_kind: z.enum(['claude', 'codex']),
  cwd: z.string(),                       // canonical local path picked in §15 step 5
  api_key: z.string(),                   // forwarded for the runner's own auth handshake (still uses the existing /ws/agent endpoint internally OR an embedded direct pipe — see below)
  system_prompt: z.string().nullable(),
  seed_files: z.array(SeedFile).optional(),
});
```

### Lifecycle (supervisor-side)

```
idle  ──launch directive──▶  launching  ──subprocess spawned──▶  online
  ▲                                                                 │
  └───────────────exit / user disconnect──────────────────────────┘
```

Supervisor → hub state messages reuse `supervisor.state` + the existing `run_started` / `run_output` / `run_finished` events. The hub flips `sessions.status` ('offline' → 'thinking' → 'online' → 'offline') as today; no schema change needed.

### Transport choice

Two viable options — pick at implementation time:

- **A. Subprocess piped through supervisor (recommended).** The supervisor spawns `claude --input-format stream-json --output-format stream-json --verbose`, parses stdout, forwards events to the hub over the supervisor's existing single WS. Cleanest multiplex; one WS connection for N runners. Requires the supervisor to implement the runner-event mapping today done in `agent/src/claude-runner.ts` — port that file into the Tauri sidecar.
- **B. Supervisor spawns an embedded `remo-code-agent` per session.** Each runner opens its own `/ws/agent` connection using the existing protocol. Less code change but N WS connections per machine. Use only if porting the runner into the Tauri sidecar proves too painful.

Strong preference for **A**. The retirement of the agent CLI is the whole point of this scope expansion — if we keep B we haven't actually retired anything.

### Missing-locally state

When the user clicks Launch but the resolved `local_path` no longer exists on disk (folder deleted, drive unmounted, repo only ever cloned on another machine):

- Hub returns 409 `{ error: 'local_path_missing', repo_key, suggested_clone_dir }`.
- Web UI shows: **"This repo isn't on this machine. Clone it to `<root>/<repo>`?"** with a Clone button.
- Clone button → `POST /api/sessions/:id/clone-here` → hub → supervisor `repo.clone` message (already implemented in supervisor protocol; reuse `repo_clone_progress`).
- After clone completes, supervisor re-scans roots → emits a fresh `supervisor.repo_inventory` → session's `local_path` resolves → Launch becomes available.

---

## 17. Agent CLI Retirement Plan

- **This phase:** Tauri supervisor ships with full §15–§16. Agent CLI keeps working unchanged. Add deprecation banner in `agent/README.md` + `npx remo-code-agent` startup log.
- **Phase 09 (follow-up):** delete `agent/` package, remove `/ws/agent` legacy fields from `AgentAuth` (`project_dir` becomes implicit via supervisor inventory). One-release deprecation window — anyone still on `claude-remote` gets a hub-side log warning + an email nudge (per the global rule #7, via emails4agents).
- WS protocol `/ws/agent` endpoint itself remains for one release as an emergency fallback. Removed in Phase 09.

---

## 13. Single-Phase Task Breakdown (~6 tasks)

1. **Schema + DAL + introspection lib.** New columns/tables/indexes in `schema.sql`; implement `findOrCreateAgentSessionV2` with transaction + `FOR UPDATE`; ship a shared `git-introspect` module usable from both Tauri (Rust or sidecar) and Node (legacy agent for one release). Unit tests for parsing + race conditions.
2. **Tauri supervisor: roots config + scan + inventory.** First-run welcome window, `supervisor.json` schema, scan worker, `supervisor.repo_inventory` WS message, Settings → Roots panel. Reuses existing `/ws/agent` (supervisor role) for auth.
3. **Hub WS handlers.** Extend `AgentAuth` (legacy back-compat path) + add `SupervisorRepoInventory` handler. Both routes call `findOrCreateAgentSessionV2`. Populate `pending_local_repos`. Broadcast `session_list`.
4. **REST + Launch flow.** `GET /api/sessions/pending-prompts`, `POST /api/sessions/dismiss-local`, `POST /api/sessions/:id/launch` (sends `session.launch` to supervisor), `POST /api/sessions/:id/clone-here`. Wire supervisor-side `session.launch` handler that spawns the runner with the right cwd (port `agent/src/claude-runner.ts` + `codex-runner.ts` into the Tauri sidecar).
5. **Create-on-GitHub flow.** Gateway-credential scope probe; new supervisor WS message `create_local_repo_and_push`; supervisor-side git push driver; `repo_create_progress` events; wire the modal. Graceful 412 when scope missing.
6. **Frontend.** `CodeSession` type extension; pending-prompts + missing-locally sections in `Sidebar`; Launch / Clone buttons on session rows; `<CreateGithubRepoModal>`; tooltip updates. Storybook stories per rule #21. Agent CLI deprecation banner.

Total: 6 focused tasks. No new external deps (Octokit + Tauri already in use). Estimated 4–5 dev-days end-to-end (was 2 — the Tauri-side runner port is the bulk of the new work).

---

## 14. Docs Updates Required at Phase End

Per global rule #14 + #21:

- Update `README.md`: worktrees are now collapsed; mention the Create-on-GitHub flow.
- Update `CLAUDE.md` repo file with a new "Phase 08: GitHub-keyed sessions" section pointing at this doc + `docs/github-session-keying.md`.
- Write `docs/github-session-keying.md` (deep-dive: the algorithm, the migration, the scope notes).
- Regenerate `docs/api.md` from `openapi.json` (the 3 new endpoints).
- Storybook story for `<CreateGithubRepoModal>`.

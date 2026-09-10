---
plan_id: 04-PLAN-007-worktree-per-session
wave: 2
depends_on: []
files_modified:
  - supervisor/src/git-ops.ts
  - supervisor/src/process-manager.ts
  - supervisor/src/worktree-manager.ts
  - supervisor/test/worktree-manager.test.ts
autonomous: true
requirements: [REQ-WORKTREE-01, REQ-WORKTREE-02]
---

# Plan 04-007 — Per-session git worktrees off a shared bare clone

Per ARCHITECTURE-REVIEW §5: avoid full clones per session (3–10× disk cost) and avoid sharing a single worktree (race conditions on `git checkout`). Instead, maintain shared bare clones at `/workspace/.bare/<host>/<owner>/<repo>.git` and add a `git worktree add` per session at `/workspace/wt/<session_id>`. Cleanup on session end.

<tasks>

<task id="T1">
<action>Create `supervisor/src/worktree-manager.ts` exporting: `async ensureBareClone(repoUrl: string): Promise<{ barePath: string; cached: boolean }>` (idempotent — clones with `git clone --bare` only if missing; if present, runs `git fetch --all --prune` and returns `cached: true`); `async createWorktree(sessionId: string, repoUrl: string, branch: string): Promise<{ worktreePath: string }>` — calls `ensureBareClone` then `git -C <barePath> worktree add <worktreePath> <branch>` (creates the branch from origin if remote-only); `async removeWorktree(sessionId: string, repoUrl: string): Promise<void>` — `git worktree remove --force <path>` + `rm -rf <path>` fallback; `async listWorktreesForRepo(repoUrl): Promise<{ sessionId: string; branch: string }[]>` — parses `git worktree list --porcelain`. Path scheme: bare clones at `/workspace/.bare/<host>/<owner>/<repo>.git` (URL → host/owner/repo via URL parsing — github.com paths only for v1; document; fall back to a hash for non-github URLs); worktrees at `/workspace/wt/<session_id>`. Use a per-bare-clone async mutex (simple Map<string, Promise>) so concurrent `ensureBareClone(sameRepo)` calls serialize. The `WORKSPACE_ROOT` is read from env `REMO_WORKSPACE_ROOT` (default `/workspace`) so tests can use a tmpdir.</action>
<read_first>
- supervisor/src/git-ops.ts (existing git helpers — match the shell-exec style + error handling)
- .planning/phases/04-coolify-dev-supervisor/ARCHITECTURE-REVIEW.md §5 (worktree-over-clones rationale, branch collision rule)
- .planning/phases/04-coolify-dev-supervisor/RESEARCH.md (Pitfall #3)
</read_first>
<acceptance_criteria>
- `ensureBareClone` is idempotent — second call on the same repo runs `fetch` not `clone`
- Concurrent `createWorktree` for two different sessions on the same repo with different branches succeed in parallel
- `removeWorktree` survives the case where git already cleaned the worktree (no-op exit 0)
- All paths land under `WORKSPACE_ROOT` — verified by tests writing to a tmpdir
</acceptance_criteria>
</task>

<task id="T2">
<action>Wire `worktree-manager.ts` into `supervisor/src/process-manager.ts` (or wherever runs are spawned today — confirm via grep): before spawning a `claude-agent` child for a run, call `createWorktree(sessionId, repoUrl, branch)` and pass the returned `worktreePath` as the child's `--project-dir`. On child exit (success or crash), call `removeWorktree(sessionId, repoUrl)` in a finally block. Also: BEFORE creating a worktree, check via `listWorktreesForRepo` whether `(repo, branch)` is already checked out for another active session — if so, abort the spawn with an error `branch_in_use` that propagates back to the hub (the hub then surfaces a 409 to the API caller; aligns with ARCHITECTURE-REVIEW §5 caveat).</action>
<read_first>
- supervisor/src/process-manager.ts (entire file — find the spawn site + the exit handler)
- supervisor/src/hub-client.ts (how supervisor reports errors back to hub today)
</read_first>
<acceptance_criteria>
- Spawning a run on `(repo=X, branch=main)` while another active run on the same `(X, main)` exists: second spawn fails with `branch_in_use`, no worktree created, no child spawned
- Spawning two runs on `(X, main)` and `(X, feature/foo)` succeeds — both children get independent worktrees
- After a child exits, the worktree directory is gone (`fs.existsSync(worktreePath) === false`)
- Crash test: kill a child via SIGKILL → cleanup still runs (finally block fires)
</acceptance_criteria>
</task>

<task id="T3">
<action>Create `supervisor/test/worktree-manager.test.ts` (Bun test). Use `REMO_WORKSPACE_ROOT=<tmpdir>` and a local file-based git repo (created via `git init --bare` in the tmpdir to avoid network calls — push a commit on `main` to seed the bare). Cases: ensureBareClone idempotency; createWorktree creates the path and checks out the branch (`git -C <path> rev-parse --abbrev-ref HEAD === 'main'`); removeWorktree leaves no dir; branch-collision detection (call createWorktree twice with same branch — second throws/returns the documented error); concurrent createWorktree for two different branches succeeds.</action>
<read_first>
- hub/test/scheduler.test.ts (Bun test style)
- supervisor/src/worktree-manager.ts (the unit under test)
</read_first>
<acceptance_criteria>
- `bun test supervisor/test/worktree-manager.test.ts` green with zero env vars set (uses tmpdir)
- All 5 documented cases have their own `test(...)`
- No test leaves files in the user's home — `afterAll` rm -rf the tmpdir
</acceptance_criteria>
</task>

</tasks>

must_haves:
- Bare clones live at `/workspace/.bare/<host>/<owner>/<repo>.git` (or env-overridden root) and are deduped across sessions
- Worktrees live at `/workspace/wt/<session_id>` and are created/torn down per run
- `(repo, branch)` collision is detected and refused server-side
- Cleanup runs on every child exit including crashes
- Unit tests cover idempotency, collision, and concurrent creation

rollback_plan:
- Revert `process-manager.ts` to its prior single-clone behavior; `worktree-manager.ts` becomes dead code. Existing `/workspace` volume layout is forward-compatible (no schema lock-in).

risks:
- `git worktree list --porcelain` parsing is fragile across git versions — pin the Coolify base image's git version in Plan 005 and add a parser regression test if needed.
- Non-github URLs use a hashed path which is opaque; documented in code comment. Future enhancement: parse gitlab/bitbucket URLs explicitly.

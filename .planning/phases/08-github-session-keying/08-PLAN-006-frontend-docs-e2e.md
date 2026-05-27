---
plan_id: 08-PLAN-006-frontend-docs-e2e
phase: 08-github-session-keying
wave: 4
depends_on: [08-PLAN-004-rest-endpoints, 08-PLAN-005-launch-and-create-github]
est_minutes: 180
acceptance_criteria:
  - `web/src/lib/useSessions.ts` exposes `pendingPrompts: PendingPrompt[]` (polled on mount + refreshed on `session_list` WS events) and extends `CodeSession` with `repo_key`, `github_owner`, `github_repo`.
  - `Sidebar.tsx` renders a "NEEDS ATTENTION" section above the session list listing pending local folders with [Create on GitHub] + [Dismiss] buttons. Section hidden when empty.
  - Connected sessions show GitHub identity (`owner/repo`) as the primary label when `repo_key` is set; `project_dir` becomes a secondary line / tooltip.
  - `<CreateGithubRepoModal>` (new) launched from the Create button: name (prefilled folder basename), visibility (radio, default Private), org (dropdown populated from GitHub App installations). Submit → `POST /api/sessions/:id/create-github-repo` → toast wired to `repo_create_progress` WS events. 412 response disables Create + shows scope-fix tooltip.
  - Each session row gains a [Launch Claude Code] (or [Launch Codex]) button when `status === 'offline'` AND user is connected through supervisor. On click → `POST /api/sessions/:id/launch`. On 409 `local_path_missing` → modal offering [Clone here].
  - `SessionTooltip` displays `github.com/<owner>/<repo>` when keyed; `Connected from: <project_dir>` as a small line.
  - Storybook stories per global rule #21: `Sidebar` (with + without pending prompts), `CreateGithubRepoModal` (scope OK + scope missing), `SessionTooltip` (keyed + legacy).
  - `agent/README.md` gains a deprecation banner (per ARCHITECTURE §17).
  - `docs/github-session-keying.md` (new) deep-dive: algorithm, migration, scope notes (per ARCHITECTURE §14).
  - `README.md` mentions worktree-collapse + Create-on-GitHub.
  - `CLAUDE.md` (repo) gains a "Phase 08: GitHub-keyed sessions" section.
  - E2E test `hub/test/phase-08.e2e.test.ts` covers ARCHITECTURE §11 scenarios (two simulated supervisor inventories of the same repo collapse to one session row; dismiss-local removes a folder).
files_modified:
  - web/src/lib/useSessions.ts
  - web/src/components/Sidebar.tsx
  - web/src/components/SessionTooltip.tsx
  - web/src/components/CreateGithubRepoModal.tsx
  - web/src/components/LaunchButton.tsx
  - web/src/components/CloneHereModal.tsx
  - web/src/stories/Sidebar.stories.tsx
  - web/src/stories/CreateGithubRepoModal.stories.tsx
  - web/src/stories/SessionTooltip.stories.tsx
  - agent/README.md
  - docs/github-session-keying.md
  - README.md
  - CLAUDE.md
  - hub/test/phase-08.e2e.test.ts
---

# Plan 08-006 — Frontend + Storybook + docs + E2E

## Goal

Make the phase visible to users: pending-folder section, Launch/Clone buttons, Create-on-GitHub modal with live progress, tooltip + sidebar adjustments. Ship the docs + Storybook required by global rules #14 + #21, plus the integration E2E.

## Scope

- All frontend wiring sits behind data fetched in earlier plans; no new REST/WS endpoints here.
- Storybook stories mirror the three new/changed components per rule #21.
- Docs: deep-dive in `docs/`, brief mentions in `README.md` + `CLAUDE.md`, agent CLI deprecation banner.

## Files

Create:
- `C:/Users/artic/GitHub/remo-code/web/src/components/CreateGithubRepoModal.tsx`
- `C:/Users/artic/GitHub/remo-code/web/src/components/LaunchButton.tsx`
- `C:/Users/artic/GitHub/remo-code/web/src/components/CloneHereModal.tsx`
- `C:/Users/artic/GitHub/remo-code/web/src/stories/Sidebar.stories.tsx`
- `C:/Users/artic/GitHub/remo-code/web/src/stories/CreateGithubRepoModal.stories.tsx`
- `C:/Users/artic/GitHub/remo-code/web/src/stories/SessionTooltip.stories.tsx`
- `C:/Users/artic/GitHub/remo-code/docs/github-session-keying.md`
- `C:/Users/artic/GitHub/remo-code/hub/test/phase-08.e2e.test.ts`

Edit:
- `C:/Users/artic/GitHub/remo-code/web/src/lib/useSessions.ts`
- `C:/Users/artic/GitHub/remo-code/web/src/components/Sidebar.tsx`
- `C:/Users/artic/GitHub/remo-code/web/src/components/SessionTooltip.tsx`
- `C:/Users/artic/GitHub/remo-code/agent/README.md`
- `C:/Users/artic/GitHub/remo-code/README.md`
- `C:/Users/artic/GitHub/remo-code/CLAUDE.md`

## Tasks

<task id="T1">
<action>Extend `web/src/lib/useSessions.ts`:
1. `CodeSession` type gains `repo_key: string | null`, `github_owner: string | null`, `github_repo: string | null`.
2. New `pendingPrompts: PendingPrompt[]` state. Fetch via `GET /api/sessions/pending-prompts` on mount and whenever the existing `session_list` WS event fires.
3. Expose `dismissLocal(hostname, project_dir)` → `POST /api/sessions/dismiss-local` + optimistic local removal.
4. Expose `launchSession(sessionId, cliKind?)` → `POST /api/sessions/:id/launch`. On 409 `local_path_missing`, throw a typed error the UI catches to open `<CloneHereModal>`.
5. Expose `cloneHere(sessionId, targetRoot?)` → `POST /api/sessions/:id/clone-here`.
6. Expose `createGithubRepo(sessionId, body)` → `POST /api/sessions/:id/create-github-repo`. Subscribe to `repo_create_progress` WS events keyed by `job_id`.</action>
<verify>`tsc --noEmit -p web/` clean. Sidebar consumes new fields without error.</verify>
</task>

<task id="T2">
<action>Update `web/src/components/Sidebar.tsx`:
1. Add a "NEEDS ATTENTION" section ABOVE the session list when `pendingPrompts.length > 0`. Each row shows the basename of `project_dir` + a muted full-path line + `[Create on GitHub]` + `[Dismiss]` buttons. Style per global frontend conventions (no heavy borders, indigo accent, soft hover).
2. For each connected session row: if `repo_key` is set, primary label is `${github_owner}/${github_repo}`; secondary line shows the current `project_dir` (truncated). Else (legacy/local-only), keep today's label.
3. When session.status === 'offline' AND a supervisor is connected, render `<LaunchButton sessionId={id} cliKind={cli_kind} />`.
4. Worktree dedup: not needed client-side (DB partial unique index enforces single row per repo_key).</action>
<verify>Visual: launch the app with seeded data; pending section appears with 2 items; clicking Dismiss removes one; sessions with repo_key show owner/repo as the main label.</verify>
</task>

<task id="T3">
<action>Create `<CreateGithubRepoModal>`. Props: `sessionId`, `defaultName`, `onClose`. Fields: name (text, prefilled), visibility (radio: Private/Public, default Private), org (select; populated lazily via a new lightweight `GET /api/github/installations` endpoint — if implementing that is out of scope for v1, hard-code "Personal account" + a free-form text field). On submit → `createGithubRepo(...)`. Render a progress section that subscribes to `repo_create_progress` for the returned `job_id` and shows the current `stage` + a determinate bar (`percent` if provided, else a stepped indicator across `validating_scope → creating_remote → pushing_locally → reindexing → done`). On 412 scope error, render: *"This GitHub App installation can't create repos. Re-install with 'Administration: write' permission, or use a PAT in Settings → Integrations → GitHub."* and disable Submit.

Also create `<LaunchButton>` (small inline button — calls `launchSession`; on `local_path_missing` error opens `<CloneHereModal>`) and `<CloneHereModal>` (shows resolved supervisor roots from a new `GET /api/supervisor/roots` if needed OR just lets user accept the suggested clone dir + calls `cloneHere`).</action>
<verify>Storybook (T4) renders both modals in their states.</verify>
</task>

<task id="T4">
<action>Add Storybook stories per global rule #21. Files in `web/src/stories/`:
- `Sidebar.stories.tsx` — "Empty", "WithSessions", "WithPendingPrompts", "WithLegacyAndKeyedMix".
- `CreateGithubRepoModal.stories.tsx` — "Default", "ScopeMissing", "ProgressPushing", "Failed".
- `SessionTooltip.stories.tsx` — "GithubKeyed", "LegacyLocal", "WorktreeConnectedFrom".
Use the existing Storybook setup in `web/` (if not yet present, this phase doesn't bootstrap it — note in PR that Storybook bootstrap is out of scope but file structure is reserved for the next pass).</action>
<verify>If Storybook is running: `bun run --cwd web storybook` shows all stories.</verify>
</task>

<task id="T5">
<action>Update `web/src/components/SessionTooltip.tsx`: when `repo_key` is set, primary line is `github.com/${github_owner}/${github_repo}`; small secondary line `Connected from: ${project_dir}`. When legacy, keep today's behavior.</action>
<verify>Hover a keyed session row → tooltip shows GitHub link + worktree path.</verify>
</task>

<task id="T6">
<action>Docs updates per ARCHITECTURE §14:
- Write `docs/github-session-keying.md`: full algorithm walkthrough, the migration story, edge cases table (copy from ARCHITECTURE §10), GitHub App scope notes (copy from §8), rollback steps (§5). Reference `ARCHITECTURE.md` as the design source.
- Update `README.md`: add a "Worktrees" subsection noting that multiple worktrees collapse to one session; brief mention of the Create-on-GitHub flow.
- Update `CLAUDE.md` (repo root): add a "Phase 08: GitHub-keyed sessions" section with file map (DAL, WS, REST, supervisor runners, web UI) and a link to `docs/github-session-keying.md`. Mirror the structure of the existing Phase 06 / Phase 05 sections.
- Update `agent/README.md`: add a deprecation banner: *"The CLI agent (`claude-remote` / `npx remo-code-agent`) is deprecated as of Phase 08. The Tauri supervisor desktop app is now the recommended local entry point. The CLI keeps working for one release and is removed in Phase 09."*</action>
<verify>`docs/github-session-keying.md` exists, references are accurate, the file map paths actually exist after this branch.</verify>
</task>

<task id="T7">
<action>Create `hub/test/phase-08.e2e.test.ts`. Skip without `REMO_E2E_DB_URL`. Bring up an in-process hub against the test DB. Simulate two supervisor connections from the same user, each uploading an inventory containing different worktree paths of the same GitHub repo (e.g. one with `local_path=/a/remo-code`, the other with `/a/remo-code-w2`, both with `git_origin_github={owner:'acme', repo:'widget'}`). Assert: exactly one row in `sessions` with `repo_key='github://acme/widget'`. Both supervisors get the same `session_id` reflected in their next `session_list` event. Send a `user_message` to that session_id from a third (web client) connection → routed to the most-recently-connecting supervisor.

Also test the dismiss flow: seed a `pending_local_repos` row, hit `POST /api/sessions/dismiss-local`, assert it disappears from `GET /api/sessions/pending-prompts`.</action>
<verify>`REMO_E2E_DB_URL=$TEST_DB bun test hub/test/phase-08.e2e.test.ts` green.</verify>
</task>

## Verification

```bash
cd C:/Users/artic/GitHub/remo-code
tsc --noEmit -p web/
tsc --noEmit -p hub/
REMO_E2E_DB_URL=$TEST_DB bun test hub/test/phase-08.e2e.test.ts
bun run build:web                  # production build is clean
bun run --cwd web storybook        # all 3 story files render
# Manual smoke: start hub + supervisor + web; verify Sidebar pending section, Launch button, Create-on-GitHub modal end-to-end.
```

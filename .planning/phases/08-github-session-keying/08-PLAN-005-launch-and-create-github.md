---
plan_id: 08-PLAN-005-launch-and-create-github
phase: 08-github-session-keying
wave: 3
depends_on: [08-PLAN-002-hub-session-resolution, 08-PLAN-003-supervisor-inventory]
est_minutes: 240
acceptance_criteria:
  - `POST /api/sessions/:id/launch` validates ownership, resolves the canonical `local_path` from the most recent supervisor inventory, ensures supervisor is online, ensures session is not currently `online`, returns `202 { launching:true, run_id }`. On missing local path → `409 { error:'local_path_missing', repo_key, suggested_clone_dir }`.
  - Hub sends `session.launch` WS message to the user's supervisor with `{ run_id, session_id, cli_kind, cwd, api_key, system_prompt, seed_files }` per ARCHITECTURE §16.
  - Supervisor handles `session.launch`: ports `agent/src/claude-runner.ts` + `codex-runner.ts` logic into `supervisor/src/runners/{claude,codex}.ts`, spawns the subprocess with the provided cwd, multiplexes events back over the existing single WS using the existing supervisor event envelope.
  - `POST /api/sessions/:id/clone-here` reuses the existing supervisor `repo.clone` flow; on completion supervisor re-scans roots and emits a fresh `supervisor.repo_inventory`.
  - `POST /api/sessions/:id/create-github-repo` validates GitHub App scope via the gateway pair (`GET {GATEWAY_URL}/api/credentials/service/github`), 412s if `administration: write` is missing. On success enqueues a background job that: creates the empty GitHub repo via Octokit, sends `create_local_repo_and_push` to the supervisor, supervisor runs `git init`/commit/`remote add`/`push -u`, then triggers a re-scan. Progress streamed via WS `repo_create_progress` events.
  - Job state is in-memory only for v1 (per ARCHITECTURE §6); hub-restart loses the job, user clicks Create again.
  - Endpoint tests in `hub/test/sessions-launch.test.ts` cover happy path + offline supervisor (409) + missing local path (409).
  - GitHub creds come ONLY from the gateway pair — no `GITHUB_TOKEN` env var added.
files_modified:
  - hub/src/api/sessions.ts
  - hub/src/ws/supervisor-protocol.ts
  - hub/src/ws/supervisor-registry.ts
  - hub/src/lib/github-scope.ts
  - hub/src/lib/github-repo-job.ts
  - supervisor/src/runners/claude.ts
  - supervisor/src/runners/codex.ts
  - supervisor/src/launch-handler.ts
  - supervisor/src/git-push-driver.ts
  - supervisor/src/index.ts
  - hub/test/sessions-launch.test.ts
---

# Plan 08-005 — Launch-on-demand + Create-on-GitHub flows

## Goal

Wire the user-facing actions: click Launch on a session → supervisor spawns the runner with the canonical cwd. Click Create-on-GitHub for a pending local folder → hub creates the empty repo via GitHub App, supervisor pushes the initial commit, the row migrates from `pending_local_repos` to a real GitHub-keyed session.

## Scope

- Three REST endpoints, two new supervisor WS messages (`session.launch`, `create_local_repo_and_push`), and the port of the agent CLI runners into the supervisor sidecar.
- GitHub App scope is **probed**, not assumed. Modal/UI degrades gracefully (Plan 006) when scope missing.
- Job state in-memory only.

## Files

Create:
- `C:/Users/artic/GitHub/remo-code/hub/src/lib/github-scope.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/lib/github-repo-job.ts`
- `C:/Users/artic/GitHub/remo-code/supervisor/src/runners/claude.ts`
- `C:/Users/artic/GitHub/remo-code/supervisor/src/runners/codex.ts`
- `C:/Users/artic/GitHub/remo-code/supervisor/src/launch-handler.ts`
- `C:/Users/artic/GitHub/remo-code/supervisor/src/git-push-driver.ts`
- `C:/Users/artic/GitHub/remo-code/hub/test/sessions-launch.test.ts`

Edit:
- `C:/Users/artic/GitHub/remo-code/hub/src/api/sessions.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/ws/supervisor-protocol.ts`
- `C:/Users/artic/GitHub/remo-code/hub/src/ws/supervisor-registry.ts`
- `C:/Users/artic/GitHub/remo-code/supervisor/src/index.ts`

## Tasks

<task id="T1">
<action>Port `agent/src/claude-runner.ts` and `agent/src/codex-runner.ts` (if those files exist; otherwise the equivalent claude/codex runner code in the agent package — confirm by reading the agent package source first) into `supervisor/src/runners/claude.ts` + `supervisor/src/runners/codex.ts`. Keep the existing `RunnerEvent` union shape identical so downstream hub processing doesn't change. The runners take a `cwd` + `cli_kind` + `seed_files` and expose `start()` / `stop()` / event subscription. Use the supervisor's existing WS client (`supervisor/src/hub-client.ts`) to forward events — DO NOT open a separate `/ws/agent` connection. Multiplex by `session_id` over the existing supervisor connection.</action>
<verify>Manually: trigger a launch (via Plan 006 UI or direct WS message) → supervisor spawns `claude --input-format stream-json ...`, events flow back over the supervisor WS, web UI renders them identically to today's agent CLI behavior.</verify>
</task>

<task id="T2">
<action>Create `supervisor/src/launch-handler.ts`. On inbound `session.launch` from hub: look up cwd existence (`fs.existsSync(cwd)`). If missing → reply `session.launch_failed { run_id, error: 'cwd_missing' }`. Else: instantiate the appropriate runner from T1, call `start()`, register the `session_id → runner` mapping for later `user_message` routing. Emit `run_started { run_id, session_id }` over the WS.</action>
<verify>Launch → web UI shows session status flip `offline → online`.</verify>
</task>

<task id="T3">
<action>Add `SessionLaunch` and `CreateLocalRepoAndPush` schemas to `hub/src/ws/supervisor-protocol.ts` (hub → supervisor direction). Fields per ARCHITECTURE §16 + §6 step 3. Add `session.launch_failed` and `repo_create_progress` to the supervisor → hub direction. Union the new variants into the existing message schemas.</action>
<verify>`tsc --noEmit -p hub/` clean.</verify>
</task>

<task id="T4">
<action>In `hub/src/api/sessions.ts`, add `POST /api/sessions/:id/launch`. Steps:
1. JWT → userId. Load session. 404 if not owned by user.
2. Resolve `local_path` — for now, this is the session row's `project_dir` (which the supervisor inventory keeps current per Plan 003). Future: query a dedicated `supervisor_session_paths` table if we need history; v1 uses `project_dir`.
3. Look up the user's connected supervisor in `supervisor-registry`. If none → 409 `{ error:'supervisor_offline' }`.
4. If session.status === 'online' → 409 `{ error:'already_online' }`.
5. The hub does NOT pre-validate `local_path` existence (supervisor does; missing → returns `session.launch_failed` → hub forwards 409 as a follow-up event). For v1 the initial 202 just promises a launch attempt; the UI listens for `session.launch_failed`.
6. Generate `run_id = crypto.randomUUID()`. Send `session.launch` to supervisor with `{ run_id, session_id, cli_kind, cwd: project_dir, api_key: <session token plaintext NOT exposed — synth a one-shot launch nonce instead and store it server-side keyed by run_id>, system_prompt, seed_files }`.
7. Return `202 { launching:true, run_id }`.

Also add `POST /api/sessions/:id/clone-here`. Body: `{ target_root?: string }`. Looks up the user's supervisor's roots (cached from the most recent inventory message — Plan 003 must persist `last_inventory` per user in memory or DB; add an in-memory `Map<userId, SupervisorRepoInventory>` in `supervisor-registry`). Default `target_root` = first root. Computes `target_path = path.join(target_root, repo_name)`. Sends existing `repo.clone` WS message. Returns 202.</action>
<verify>Test in T7.</verify>
</task>

<task id="T5">
<action>Create `hub/src/lib/github-scope.ts` with `probeGithubAppScope(): Promise<{ hasAdminWrite: boolean, hasContentsWrite: boolean, raw: unknown }>`. Implementation:
1. `GET {GATEWAY_URL}/api/credentials/service/github` (fall back to `FALLBACK_GATEWAY_URL`) with `Authorization: Bearer {GATEWAY_API_KEY}`. Identical pattern to `hub/src/scheduler/post-run/github-issue.ts` — copy the credential-loading helper if not already shared, extract into `hub/src/lib/gateway-creds.ts` if needed.
2. Use the returned installation token to call Octokit `GET /app` and `GET /installation/repositories`. Parse the installation `permissions` object.
3. Return the flags.
Cache the result for 5 minutes in-memory.</action>
<verify>Manual call from a script logs the parsed permissions object.</verify>
</task>

<task id="T6">
<action>Create `hub/src/lib/github-repo-job.ts` with `enqueueCreateGithubRepoJob(opts): { job_id: string }`. Holds an in-memory `Map<job_id, JobState>`. Job stages: `validating_scope → creating_remote → pushing_locally → reindexing → done` (or `failed_at_stage`). Job emits WS events to the user's web clients (`repo_create_progress { job_id, stage, percent }`). Steps inside the job:
1. `probeGithubAppScope()`. If `!hasAdminWrite` → fail with stage `validating_scope`.
2. Create the GitHub repo via Octokit `POST /user/repos` (or `POST /orgs/{org}/repos` when org provided). Name/visibility from request.
3. Find target supervisor. Send `create_local_repo_and_push { session_id, owner, name, visibility, remote_url }`. Wait for `repo_create_progress { stage: 'pushed' }` or `repo_create_failed`.
4. Supervisor re-scans → fresh inventory → hub re-runs `findOrCreateAgentSessionV2` for the same `project_dir` with a now-populated `git` payload → priority-2 upgrade → done.

Add `POST /api/sessions/:id/create-github-repo` in `hub/src/api/sessions.ts` that calls `enqueueCreateGithubRepoJob` and returns `202 { job_id, status: 'queued' }`. 412 immediately if the cached scope probe says no admin-write.

In `supervisor/src/git-push-driver.ts`, implement the receiver for `create_local_repo_and_push`: run `git init` (if needed) → `git add -A && git commit -m "Initial commit"` (if no commits) → `git remote add origin <url>` (or `set-url`) → `git push -u origin HEAD`. Emit `repo_create_progress` at each step.</action>
<verify>Manual: trigger create-github-repo for a pending local folder; modal in Plan 006 streams progress; folder ends up as a GitHub-keyed session.</verify>
</task>

<task id="T7">
<action>Create `hub/test/sessions-launch.test.ts`. Mock the supervisor registry (`Map<userId, FakeSupervisorConn>`) where `FakeSupervisorConn` records sent messages. Cases:
1. Launch happy path: session owned, supervisor online → 202 with `run_id`; supervisor received `session.launch` with correct cwd + cli_kind.
2. Supervisor offline → 409 `{ error:'supervisor_offline' }`.
3. Session already online → 409 `{ error:'already_online' }`.
4. Session not owned by JWT user → 404.
Skip if `REMO_E2E_DB_URL` unset (the test needs a real session row).</action>
<verify>`REMO_E2E_DB_URL=... bun test hub/test/sessions-launch.test.ts` green.</verify>
</task>

## Verification

```bash
cd C:/Users/artic/GitHub/remo-code
tsc --noEmit -p hub/
REMO_E2E_DB_URL=$TEST_DB bun test hub/test/sessions-launch.test.ts
# E2E manual: launch supervisor, web UI Launch button → claude subprocess spawns, events stream
# E2E manual: pending-local folder → Create on GitHub → empty repo created → initial commit pushed → session migrates to repo-keyed
```

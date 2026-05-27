---
phase: 08-github-session-keying
verified: 2026-05-26
status: gaps_found
verdict: "fix 3 items first OR ship hub-side + queue Phase 08.5 for web Launch/Modal UI"
score: 4.5/6 goals
---

# Phase 08 — GitHub-Backed Session Keying — Verification

Worktree: `C:/Users/artic/GitHub/remo-code-p08`
Branch: `feat/phase-08-github-keying`
Verified against `ARCHITECTURE.md` + 6 PLAN files.

## Goal Coverage

| # | Goal | Status | Evidence |
|---|------|--------|----------|
| 1 | Sessions keyed by GitHub repo (worktree dedupe) | **PASS** | `hub/src/db/schema.sql:545-559` adds `repo_key`/`github_owner`/`github_repo`/`superseded_by` + partial unique index `idx_sessions_user_repo_key`. `hub/src/db/dal.ts:224` `findOrCreateAgentSessionV2` with `FOR UPDATE` + `ON CONFLICT` (priority 1/2/3). `supervisor/src/git-introspect.ts` provides `parseGitRemote` + `buildRepoKey`. |
| 2 | Tauri first-run UX + Roots panel | **PASS** | `supervisor/tauri/ui/src/components/RootsPanel.tsx` lists/adds/removes roots via `add_root`/`remove_root`/`rescan_now` Tauri commands. Routed at `/roots` in `App.tsx`. `supervisor/src/config.ts` defines `supervisor.json` with platform-resolved path. |
| 3 | Inventory scan + report from supervisor | **PASS** | `supervisor/src/repo-scanner.ts:208` `scanRoots` with `max_depth` + ignore globs. `supervisor/src/hub-client.ts:241-263` emits `supervisor.repo_inventory` on auth_ok and after re-scans. Hub handler at `hub/src/ws/agent.ts:627`. Cache in `hub/src/ws/supervisor-registry.ts` (`setUserInventory`/`getUserInventory`/`resolveLocalPathForRepoKey`). `supervisor.repo_inventory` schema in `hub/src/ws/supervisor-protocol.ts:125`. |
| 4 | Pending-local-repos prompt UX | **PASS (with minor deviation)** | `web/src/hooks/usePendingLocalRepos.ts` polls `GET /api/sessions/pending-prompts` every 30s (deviation: spec said fetch on `session_list` WS event; implementation uses 30s polling). `web/src/components/PendingLocalRepoPrompt.tsx` renders sidebar banner with Dismiss + Create-on-GitHub. Hub endpoints `pending-prompts` + `dismiss-local` in `hub/src/api/sessions.ts:77,83`. |
| 5 | Launch-on-demand from web UI | **PARTIAL** | Hub-side complete: `POST /api/sessions/:id/launch` (`sessions.ts:297`), `POST /:id/clone-here` (370), `POST /:id/create-github-repo` (432). 13/13 tests pass in `sessions-launch.test.ts`. **Web UI NOT shipped:** no `<LaunchButton>`, no `<CloneHereModal>`, no `<CreateGithubRepoModal>`, no `launchSession`/`cloneHere` helpers in `useSessions.ts`. The only consumer is `PendingLocalRepoPrompt.createGithubRepo` for the pending-prompts path. **Supervisor receivers also unshipped:** no `launch-handler.ts`, no `git-push-driver.ts` (plan 005 deviations §1-2 — receiver for `session.launch` + `create_local_repo_and_push` deferred). End-to-end launch flow is NOT exercisable from the web UI today. |
| 6 | Replace Tauri "coming soon" with real UI | **PASS** | 3 real pages: `GeneralPage.tsx` (185 LOC — sidecar status + controls), `FoldersPage.tsx` (205 LOC — Repos/inventory list + refresh, polls `get_inventory` IPC), `SecurityPage.tsx` (171 LOC). `RootsPanel.tsx` is the Roots editor. No "coming soon" strings remain. |

## Test Counts

| Package | pass | fail | skip | notes |
|---------|------|------|------|-------|
| `hub` | 326 | 10 | 80 | All 10 failures are pre-existing (insertRunV2/insertDeploymentRun `started_at` × 5, supervisor-registry reconnect race × 4). `ws-multi-subscribe.test.ts` SyntaxError ("subscribeClient not found") is a pre-existing test-isolation bug unrelated to Phase 08 — `subscribeClient` IS exported at `registry.ts:65`. |
| `supervisor` | 47 | 0 | 0 | 117 expects. Clean. |
| `web` | n/a | — | — | No bun-test suite in web/. |

## Build Status

| Package | Result |
|---------|--------|
| `web/ bun run build` | **Clean.** 368 modules, ~707 kB main bundle (gzip 203 kB). |
| `supervisor/tauri/ui bun run build` | **Clean.** 51 modules. |
| `supervisor/tauri/src-tauri cargo check` | **Clean.** |

## Deviations from ARCHITECTURE / plans

1. **Plan 006 mostly NOT shipped on web side.** No `docs/github-session-keying.md`, no Storybook stories under `web/src/stories/`, no `hub/test/phase-08.e2e.test.ts`, no `<LaunchButton>`/`<CloneHereModal>`/`<CreateGithubRepoModal>` components, no `launchSession`/`cloneHere` helpers in `useSessions`. `SessionTooltip.tsx` IS updated (uses `githubOwnerRepo()` helper + renders `github.com/owner/repo` + "Connected from"). `Sidebar.tsx` renders pending-prompts banner but does NOT render Launch button on offline sessions. Plan 006 has no Status section — never marked complete.
2. **Plan 005 deviations (already documented):** supervisor-side `launch-handler.ts` and `git-push-driver.ts` deferred — hub dispatches `session.launch` and `create_local_repo_and_push` over the wire but no supervisor receiver exists, so launch will time out / no-op in practice.
3. **Plan 005 deviation:** hub-side dispatch of inbound `repo_create_progress` into `applySupervisorProgress()` is a one-liner that's NOT wired in the supervisor message switch. Function exists in `github-repo-job.ts` but never called.
4. **Plan 003 deviation:** Tauri `rescan_now` only nulls `last_scan_at`; relies on Bun sidecar fs.watch (not direct IPC trigger). Acceptable.
5. **Plan 003 deviation:** `findOrCreateAgentSessionV2` no-git + null-tokenHash branch returns a synthetic stub instead of falling through. Documented inline. Acceptable for inventory path.
6. **Plan 004 deviation:** pending-prompts UI polls every 30s instead of refetching on `session_list` WS event. Minor UX latency, no correctness impact.
7. **`is_worktree` filtering deferred** (Plan 006 final report) — worktrees collapse via DB partial unique index instead, which is the correct mechanism.

## Verdict

**Fix 3 items before declaring Phase 08 shipped — OR ship hub-side now and queue Phase 08.5.**

The phase delivers the **data model + supervisor inventory + REST surface** end-to-end. Anyone hitting the hub API directly gets the full GitHub-keyed flow. **What's missing is the user-facing closure of goal 5** (launch / create-on-github) and **goal 6's web-side polish** (no docs, stories, or e2e test). The hub-side launch endpoints are dead code from a UX perspective until either (a) a supervisor receiver wires them to `pm.start()`, or (b) the web UI exposes them.

### Top 3 gaps for Phase 08.5

1. **Supervisor receivers for `session.launch` + `create_local_repo_and_push`.** Without these, the entire Launch / Create-on-GitHub flow is non-functional end-to-end. Plan 005 calls this out as deferred. ~2 new files: `supervisor/src/launch-handler.ts`, `supervisor/src/git-push-driver.ts`. Also: one-line dispatch of inbound `repo_create_progress` into `applySupervisorProgress()`.
2. **Web UI for Launch + Create-on-GitHub.** `<LaunchButton>` on offline sessions in `Sidebar.tsx`, `<CloneHereModal>` (handle 409 `local_path_missing`), `<CreateGithubRepoModal>` with `repo_create_progress` subscription. Add `launchSession`/`cloneHere`/`createGithubRepo` helpers to `useSessions.ts`. The REST endpoints all exist and are tested.
3. **`docs/github-session-keying.md` + Storybook stories + `hub/test/phase-08.e2e.test.ts`.** Plan 006 T4/T6/T7 — required by global rule #21 (Storybook for components) and #14 (docs on phase completion). The e2e test specifically asserts the two-worktrees-collapse-to-one-session scenario from ARCHITECTURE §11 — currently only unit-tested.

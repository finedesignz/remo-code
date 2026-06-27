# Phase 08 / "Local Repos" Cluster — Disposition

**Date:** 2026-05-28
**Worktree:** `C:/Users/artic/GitHub/remo-code-ui-restructure`
**Branch:** UI restructure (off main)
**Mode:** Investigate-only, read-only.

---

## Verdict

**KEEP + FINISH (minimal wiring)** for the local-repos cluster.
**CONSOLIDATE separately** for `AppChrome` — but NOT into `AppShell`; they are not equivalent.

The local-repos feature is a real, fully-backed end-to-end Phase 08 capability that is mostly already wired in the restructure worktree. The 7 TS errors come from **3 missing methods on `useSessions`** plus a handful of prop-type gaps on `Sidebar`. All backend (hub + supervisor) work is shipped. Ripping it would discard real product value (Launch from GitHub-keyed session, Clone-here, Create-on-GitHub-from-local) that is documented as Phase 08 in `hub/src/db/dal.ts`, `hub/src/api/sessions.ts`, `supervisor/src/repo-scanner.ts`, etc.

---

## What each file does

| File | Purpose | Disposition |
|---|---|---|
| `web/src/components/AppChrome.tsx` | Sidebar + header frame wrapping 5 non-chat routes (Settings, Schedules, ErrorCapture, Revanote, Grid). Mounts `Sidebar` and forwards `launchSession` / `cloneHere`. | **Keep, refactor: rename/move into `components/ui/` once the restructure stabilises** — see "AppChrome vs AppShell" below. NOT replaceable by AppShell as-is. |
| `web/src/components/LaunchButton.tsx` | Per-row sidebar button on an **offline, GitHub-keyed session** that POSTs `/api/sessions/:id/launch` to ask the supervisor to spawn Claude/Codex against a specific known local worktree. If session has >1 `local_paths`, renders a worktree `<select>` first. | **Keep.** Real user affordance not covered by normal "open session" — you can't launch a session whose process is dead; this resurrects it on the right worktree. |
| `web/src/components/PendingLocalRepoPrompt.tsx` | Sidebar banner showing folders the supervisor has scanned that are **not on GitHub yet** and not dismissed. Per-row Create-on-GitHub + Dismiss buttons. Polls `GET /api/sessions/pending-prompts`. Hidden when empty. | **Keep.** Solves real problem: turning "I ran Claude in `C:\Users\me\stuff\`" into a published repo without leaving the app. |
| `web/src/components/CloneHereModal.tsx` | Modal opened from "Not on this machine" indicator. User picks supervisor + configured root; hub dispatches `repo.clone` to supervisor. | **Keep.** Counterpart to LaunchButton for the "I have a GitHub-keyed session but no local checkout on this host" case. |
| `web/src/components/CreateGithubRepoModal.tsx` | Modal: choose name, public/private, org. Calls `createGithubRepo` → enqueues hub-side job → progress streamed via WS `repo_create_progress`. Handles 412 (missing `administration:write` GitHub App scope). | **Keep.** Backed by `hub/src/lib/github-repo-job.ts` + supervisor `repo.create` handler. |
| `web/src/hooks/usePendingLocalRepos.ts` | Polls `GET /api/sessions/pending-prompts` every 30s; exposes optimistic dismiss + create-on-github actions. | **Keep.** |
| `web/src/hooks/useRepoCreateJob.ts` | Subscribes to WS `repo_create_progress` / `repo_create_failed`, maps stage → percent for the progress bar. Source of truth: `hub/src/ws/supervisor-protocol.ts > RepoCreateProgress`. | **Keep.** |

---

## Backend audit — IS IT ALL THERE?

**Yes.** Confirmed by direct file grep on the worktree:

### Hub REST/WS endpoints (`hub/src/api/sessions.ts` + co.)
- `GET /api/sessions/pending-prompts` ✅
- `POST /api/sessions/dismiss-local` ✅
- `POST /api/sessions/:id/launch` ✅
- `POST /api/sessions/:id/clone-here` ✅
- `POST /api/sessions/:id/create-github-repo` ✅ (+ 412 scope-missing handling)
- WS `repo_create_progress` / `repo_create_failed` events ✅ (`hub/src/ws/supervisor-protocol.ts`)
- DAL: `pending_local_repos` table + `lib/github-repo-job.ts` background worker ✅
- DB schema: `hub/src/db/schema.sql` defines `pending_local_repos`, `repo_create_jobs`, `local_paths` cache ✅

### Supervisor handlers (`supervisor/src/`)
- `repo-scanner.ts` walks roots, finds non-git folders → reports to hub as pending-local candidates ✅
- `hub-client.ts` handles inbound `repo.clone` → calls `git-ops.cloneRepo`, emits `repo.clone_progress` ✅
- `hub-client.ts` handles inbound `repo.create` (init + commit + remote-add + push) — see grep hits at lines 209/226/354 ✅
- Wire envelopes in `OutboundMsg` union include `repo.clone_progress`, `repo.op_result`, `repo.scan_result` ✅

### Restructure-only changes that intersect
- `web/src/components/ui/AppShell.tsx` (Wave 1b primitive) — header + main + optional footer, NO sidebar. Different shape than AppChrome.

---

## The 7 TS errors — exact fix list

From the indexed `TSC check` output:

1. `useSessions` does not export `launchSession` → **ADD method** (POST `/api/sessions/:id/launch`).
2. `useSessions` does not export `cloneHere` → **ADD method** (POST `/api/sessions/:id/clone-here`).
3. `useSessions` does not export `createGithubRepo` → **ADD method** (POST `/api/sessions/:id/create-github-repo`).
4. `CodeSession.local_paths` missing → **ALREADY DEFINED** in `useSessions.ts` line 36-41 in this worktree. The prior audit was stale OR a different branch. Re-run `bun run typecheck` to confirm.
5. `Sidebar` Props missing `token` → **ADD** to `interface Props` (already present in restructure: lines 31/34/35 of Sidebar.tsx). Confirm.
6. `Sidebar` Props missing `subscribe` → **ADD** (already present, line 31 comment).
7. `Sidebar` Props missing `launchSession` / `cloneHere` → **ADD** as optional props (lines 34-35 confirm they're declared as `?:`).

**Conclusion:** Most "missing" props ARE in place in this worktree. The single concrete missing piece is the 3 `useSessions` callbacks. Inspecting `useSessions.ts` shows the export list `launchSession, cloneHere, createGithubRepo` IS in the return on line 166 — but the bodies (lines 107, 122, 138) need verifying. There's a strong chance they're already drafted and the actual TS errors are elsewhere. **First action: re-run `bun run typecheck` from `web/` against the current worktree and capture the FRESH error list before any edits.**

---

## AppChrome vs AppShell — they are NOT the same primitive

After reading both:

- **`AppShell` (Wave 1b)** = `<header><main><footer/></header>`. No sidebar. Designed for the 3 *new* top-level pages.
- **`AppChrome`** = `<Sidebar (with sessions, launch, clone, navigation)><header (theme+usage+profile)><main>{children}</main></>`. The whole sidebar+chrome the chat-adjacent routes (Settings, Schedules, ErrorCapture, Revanote, Grid) inherit so the user keeps a session list while configuring.

If you swap AppChrome→AppShell on those 5 routes you LOSE the persistent sidebar. That's a UX choice, not a refactor.

**Recommended consolidation later (NOT now):** introduce a second primitive, e.g. `AppShellWithSidebar` (or rename AppChrome → `SidebarShell` and move it under `components/ui/`). Deferring this keeps the Wave 2 diff narrow.

---

## Action plan

### Wave 1c (insert before Wave 2) — 30-60 min

1. From `web/` run `bun run typecheck` against the worktree and capture the FRESH error list. The prior 7-error audit may be partly stale (local_paths IS defined; Sidebar props IS declared optional).
2. In `web/src/hooks/useSessions.ts`, confirm that `launchSession`, `cloneHere`, `createGithubRepo` callbacks (declared at lines 107/122/138 per grep) have bodies that fetch the correct hub endpoints. If missing, write them — each is ~10 lines.
3. Run `bun run build` (web) until green. No backend changes needed.
4. Smoke-test in the dev hub: load `#/grid`, confirm sidebar renders with `LaunchButton` for offline GitHub-keyed sessions, confirm `PendingLocalRepoPrompt` polls.

### Wave 2 — proceed as planned

- Phase 08 cluster is now type-clean and shipping. Wave 2 nav/route work can land without conflict.

### Wave 3 (deferred polish)

- Either rename `AppChrome` → `components/ui/SidebarShell.tsx` for naming consistency with `AppShell`, OR document that the two are intentionally distinct primitives.

---

## Deep-link redirects (#/schedules etc.)

**Not affected by this disposition.** The 5 routes that use AppChrome (`settings`, `schedules`, `error-capture`, `revanote`, `grid`) are all preserved as-is. Restructure deep-link redirects can land independently — they touch route parsing, not the chrome wrapper.

---

## Files to delete: NONE

Every file in the cluster has a real consumer and a real backend. No vestigial code identified.

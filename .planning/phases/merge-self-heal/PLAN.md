# Plan: upstream-fixes-merge

Reference: CONTEXT.md. Branch off `main` as `chore/upstream-fixes-replay`. One commit per task.

## Wave 1 — Investigate (VERIFY_THEN_APPLY items)

### 1.1 Verify profile PATCH response shape
- File: `hub/src/api/profile.ts`
- Cmd: `grep -n "PATCH\|c.json\|updated" hub/src/api/profile.ts`
- Success: confirm whether route returns `updated` (full profile) or `{ok:true}`. Record finding.

### 1.2 Inspect sessions.ts + plugin.ts for sequential awaits
- Files: `hub/src/api/sessions.ts`, `hub/src/api/plugin.ts`
- Cmd: `grep -n "await " hub/src/api/sessions.ts hub/src/api/plugin.ts`
- Success: list each handler with ≥2 independent awaits that could parallelize.

### 1.3 Check for existing fetch helper in web/
- Cmd: `grep -rn "VITE_HUB_URL\|HUB_URL" web/src/`; `ls web/src/lib/`
- Success: confirm no `api.ts` exists; count duplicate `fetch(\`${HUB_URL}` sites across hooks.

### 1.4 Audit Sidebar.tsx for non-button clickables
- Cmd: `grep -n "onClick\|<span\|<div" web/src/components/Sidebar.tsx`
- Success: list any `<span>`/`<div>` with `onClick` lacking role/tabIndex.

### 1.5 Audit App.tsx for duplication
- Cmd: `Read web/src/App.tsx`
- Success: identify duplicate Layout renders or inline loading screen markup; otherwise mark DROP.

### 1.6 Hook useCallback audit (low priority)
- Files: `web/src/hooks/{useApiKey,useChat,useSessions,useProfile,useAuth}.ts`
- Cmd: `grep -n "const.*= async\|useCallback" web/src/hooks/*.ts`
- Success: shortlist mutations passed to children as props that re-create each render.

## Wave 2 — APPLY_CLEAN

None. All surviving changes require rewrite on current main.

## Wave 3 — REWRITE on current main

### 3.1 Extract crypto utilities (PR change #2)
- New file: `hub/src/lib/crypto.ts` exporting `generateSecureToken(prefix?)`, `hashToken(token)`.
- Move impls from `hub/src/ws/channel.ts:35` (and any duplicate token-gen funcs found via `grep -n "randomBytes\|createHash" hub/src/`).
- Update imports in:
  - `hub/src/ws/channel.ts` (now imports from `../lib/crypto`)
  - `hub/src/ws/agent.ts`
  - `hub/src/api/plugin.ts`
  - `hub/src/api/api-keys.ts`
  - `hub/src/api/sessions.ts`
  - `hub/src/auth/api-key-middleware.ts`
- Verify: `bun run build` (or `tsc --noEmit` in hub); `grep -rn "from.*ws/channel'" hub/src/` shows no `hashToken` imports.
- Commit: `refactor(hub): extract crypto helpers to lib/crypto`
- Success: hub builds; all 5 importers point at `lib/crypto`; `ws/channel.ts` no longer exports `hashToken`.

### 3.2 web fetch helper (PR change #3) — only if 1.3 confirms duplication
- New file: `web/src/lib/api.ts` exporting `HUB_URL`, `authHeaders()`, `hubFetch(path, init)`.
- Refactor only the hook files that still exist and still duplicate the pattern (per 1.3 finding).
- Verify: `bun run build:web`; grep `fetch(\`${HUB_URL}` count drops to 0 in refactored hooks.
- Commit: `refactor(web): extract hubFetch helper`
- Success: web builds; no duplicate URL/header construction in touched hooks.

### 3.3 Profile PATCH response (PR change #4) — only if 1.1 finds `{ok:true}`
- File: `hub/src/api/profile.ts`
- Return `c.json(updated)` instead of `{ok:true}`.
- Verify: `curl -X PATCH .../api/profile` returns full profile object.
- Commit: `fix(hub): return full profile from PATCH /api/profile`
- Success: response body includes `display_name`, `system_prompt`, etc.

### 3.4 Parallelize DB queries (PR change #6) — only on handlers identified in 1.2
- Files: `hub/src/api/sessions.ts`, `hub/src/api/plugin.ts`
- Wrap independent awaits in `Promise.all([...])`.
- Verify: `tsc --noEmit`; manual smoke of affected endpoints.
- Commit (per file): `perf(hub): parallelize independent DB queries in <file>`
- Success: each refactored handler has zero sequential independent awaits.

### 3.5 Sidebar a11y (PR change #9) — only if 1.4 finds offenders
- File: `web/src/components/Sidebar.tsx`
- Convert each offending `<span onClick>` to `<button type="button" onClick>`; preserve classes.
- Verify: `bun run build:web`; tab through sidebar in browser, confirm focus ring + Enter activates.
- Commit: `a11y(web): use button for sidebar actions`
- Success: no clickable non-button in Sidebar.tsx.

### 3.6 App.tsx dedup (PR change #10) — only if 1.5 finds duplication
- File: `web/src/App.tsx`
- Extract `LoadingScreen` component (inline or `web/src/components/LoadingScreen.tsx`); collapse duplicate Layout renders.
- Verify: `bun run build:web`; visual smoke (loading, then authed view).
- Commit: `refactor(web): dedupe App.tsx layout + loading`
- Success: single Layout render path; loading markup not inlined twice.

### 3.7 useCallback wrapping (PR change #8) — only on shortlist from 1.6
- Files: per 1.6 shortlist.
- Wrap each identified mutation in `useCallback` with correct deps.
- Verify: `bun run build:web`; React DevTools shows stable refs.
- Commit: `perf(web): stabilize hook mutation refs with useCallback`
- Success: shortlisted callbacks have stable identity across renders.

## Wave 4 — Close PR

### 4.1 Push branch + open replay PR (optional, or merge directly)
- `git push -u origin chore/upstream-fixes-replay`
- If solo merge: `git checkout main && git merge --ff-only chore/upstream-fixes-replay && git push`

### 4.2 Close PR #1 with summary
- `gh pr comment 1 --body "<summary>"` linking each new commit SHA against the PR change # it replaces; note which were DROPPED (1, 5, 7) and why (already fixed / no longer applicable).
- `gh pr close 1`
- Success: PR #1 closed with traceable replacement commits.

### 4.3 Delete branch
- `git push origin --delete upstream-fixes`
- `git branch -D upstream-fixes` (if local copy exists)
- Success: branch gone from remote and local.

## Skip conditions

Any Wave 3 task whose Wave 1 verification shows "already fixed" or "no duplication" is dropped. Record in PR close comment.

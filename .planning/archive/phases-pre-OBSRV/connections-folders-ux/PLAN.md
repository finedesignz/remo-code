# Plan — Sidebar folder removal + Connections folders/repos UX

**Branch:** `feat/connections-folders-ux` (worktree off `origin/main`)
**Scope:** web SPA only (`web/src/components/*`). No hub/API changes — the data needed already exists on the client (`Row.hasLocal` / `Row.hasGithub`).

## Goals (from user)
1. Sidebar: stop showing "folders not yet on GitHub". Remove that banner **and its dropdown**.
2. Connections (Settings → Connections): keep showing folders in the repo list, but **render folders as folders** with a distinguishing icon (folder vs GitHub mark). Add a **type filter: All / Repos / Folders**.
3. Make the Connections page **more compact** (per design prefs) and **icons better for mobile**.

## Definitions
- **Repo** = row with `hasGithub === true` (matched to a GitHub repo).
- **Folder** = row with `hasGithub === false` (local-only git dir / plain folder, currently labeled "· local only").

---

## Change 1 — Remove sidebar pending-folders banner
**Files:** `web/src/components/Sidebar.tsx`, delete `web/src/components/PendingLocalRepoPrompt.tsx`

- `Sidebar.tsx:255-261` — remove the `<PendingLocalRepoPrompt … />` block.
- Remove now-unused wiring in `Sidebar.tsx`: the `resolveSessionId` helper (`:59-64`), and the `PendingLocalRepoPrompt` import. Keep `subscribe`/`token` props (still used elsewhere — verify before dropping).
- Delete `PendingLocalRepoPrompt.tsx` (the banner **is** the dropdown — its expand/collapse chevron is "the dropdown"). 
- Leave `usePendingLocalRepos.ts` + the hub `/api/sessions/pending-prompts` + `dismiss-local` endpoints in place (no longer rendered; harmless). Optionally note as dead-code for a later cleanup pass.

> **Assumption to confirm:** "the dropdown" = the collapsible chevron inside this same banner, not the header `SessionDropdown`. If you meant a different dropdown, flag it.

## Change 2 — Folder vs repo icon on each Connections row
**File:** `web/src/components/SupervisorPage.tsx`

- Add two icons to the inline `Icon` map (`:118-141`): `Github` (reuse the 16px mark already in `Sidebar.tsx:298`) and `Folder` (reuse `Sidebar.tsx:302` outline).
- Desktop rows (`:570-578`) and mobile cards (`:602-606`): prepend a leading icon — `Icon.Github` when `row.hasGithub`, else `Icon.Folder` — in `--text-muted`, `shrink-0`. Gives an at-a-glance repo/folder distinction; keep the existing "· local only" / "· not cloned" subtext or drop it now that the icon carries the meaning (proposed: drop "· local only", keep "· not cloned").

## Change 3 — Type filter: All / Repos / Folders
**File:** `web/src/components/SupervisorPage.tsx`

- New state `typeFilter: 'all' | 'repos' | 'folders'` (persist to localStorage like `filter`).
- Apply in the `rows` memo (`:389-395`) alongside search/status: `repos` → `r.hasGithub`; `folders` → `!r.hasGithub`.
- Render a second segmented control in the toolbar (`:516-526`) next to the existing All/Running/Idle status chips. On mobile, wrap/stack (toolbar is already `flex-wrap`).
- Keep the existing status filter (`all/running/idle`) — the two filters compose (e.g. Folders + Running).

## Change 4 — Compactness + mobile icon pass
**File:** `web/src/components/SupervisorPage.tsx` (per `~/.claude/design-preferences.md` — read before tuning)

- Tighten row padding `py-2.5 → py-2`; toolbar `py-2.5 → py-2`; section gap `space-y-4 → space-y-3`.
- Supervisor-selector card (`:439`) `p-3 → p-2.5`, smaller label text.
- Mobile action buttons: bump `IconBtn` hit target on touch (`p-1.5 → p-2` under `md:`), ensure ≥40px tap targets for Play/Stop/Open.
- Mobile card (`:601-614`): show the new folder/repo icon, keep one-line meta; verify truncation at 360px width.
- Re-run design-prefs density check (radius/shadow/spacing tokens) before finalizing.

---

## QC / verification
- `bun run build:web` (typecheck + bundle) — must pass.
- Manual (agent runs `bun run dev:web`, then user exercises): sidebar no longer shows the amber "N folders not on GitHub" banner; Connections shows folder icon vs GitHub icon; All/Repos/Folders filter works and composes with Running/Idle; page reads tighter on desktop and at mobile width.
- Independent verifier subagent → `VERIFICATION.md` (PASS/PARTIAL/MISSING) before merge.
- Docs: no behavior doc covers this list UI; update `docs/grid-view.md`? No — Connections is in SupervisorPage; no doc drift expected. Confirm no `/openapi.json` change (none).

## Out of scope
- Hub/API changes, removing the pending-prompts backend, mobile Tauri shell (paused).

# Repo Grouping — Implementation Plan / Spec

**Status:** DRAFT design doc (no code). Branch `plan/repo-grouping`.
**Owner surface:** Connections tab (`web/src/components/SupervisorPage.tsx`) + sessions sidebar (`web/src/components/Sidebar.tsx` / `web/src/lib/session-list.ts`).
**Author:** planning agent, 2026-06-04.

---

## 1. Goal & Scope

### Goal
Let a user organize their ~60 repos into **named, user-defined groups** and view the repo
list **grouped into expand/collapse sections** in BOTH the Connections tab and the sessions
sidebar. A repo may belong to **more than one group** (many-to-many).

### In scope
- **Group CRUD**: create / rename / delete groups (per-user).
- **Membership CRUD**: assign / unassign a repo to/from a group; a repo can be in 0..N groups.
- **Grouped rendering** in Connections (repo table) and the sessions sidebar, organized by group.
- **Expand/collapse** sections, with collapse state **persisted per-user, cross-device** (server-side).
- **Group ordering** (user-defined `sort_order`) and an implicit **"Ungrouped"** trailing section.
- OpenAPI registration + `docs:sync` for every new route.

### Non-goals (explicit)
- **No nested / hierarchical groups** (flat groups only). Revisit later if asked.
- **No drag-and-drop reorder of repos within a group** (repos sort inside a group by the existing
  Connections sort key). Group reorder IS in scope; repo-within-group reorder is NOT.
- **No sharing groups across users / teams** — groups are strictly `user_id`-scoped.
- **No auto-grouping heuristics** (by org, by language, by activity). Manual assignment only.
- **No supervisor / Tauri changes.** Grouping is a hub+web concern only; the supervisor never
  sees groups. (Repo identity already arrives via existing scan/session data.)
- **No change to how repos are discovered** (scan, GitHub App install, pending_local_repos stay as-is).

---

## 2. Data Model

### 2.1 Repo identity — the load-bearing decision

The two repo surfaces key repos differently today:

| Repo kind | Identity used today | Notes |
|---|---|---|
| GitHub-backed | `repo_key` = `github://<owner>/<repo>` (lowercase, `hub/src/lib/repo-key.ts` `buildRepoKey`) | Stable across supervisors + worktrees — every worktree/clone of one repo collapses to one `repo_key`. This is the canonical cross-host key. |
| Local-only folder (no GitHub remote) | absolute `path` | No `repo_key`. Lives in `pending_local_repos` / scan output. Path is host-specific; same folder on two machines = two identities. |

UI row keys today: GitHub rows `gh:<full_name>`, local rows `local:<path>` (`SupervisorPage.tsx`).
Sidebar dedupes sessions by `repo:<repo_key>` (else `id:<session_id>`) in `session-list.ts`.

**Decision — a single normalized `repo_ident` string column** stored on membership rows:

```
repo_ident =
  "github://<owner>/<repo>"   when the repo has a GitHub repo_key   (preferred, host-agnostic)
  "path://<absolute-path>"    when local-only (no GitHub remote)    (host-specific fallback)
```

Rationale:
- A GitHub repo seen through multiple supervisors / installations / worktrees has ONE `repo_key`,
  so its group membership is shared across hosts automatically — correct and desired.
- A local-only folder is inherently host-specific; keying it by `path://` is the only stable id
  available. If the same folder later gains a GitHub remote, it "upgrades" to a `github://` ident
  (a one-time client-side or lazy migration — see §6 edge cases; acceptable: membership simply
  needs re-assigning, no data corruption).
- `repo_ident` is a **free TEXT, NOT foreign-keyed** to any repo table. There is no canonical
  per-user "repos" table (repos live transiently in scan output + `sessions.repo_key` +
  `pending_local_repos`). FK-ing would force a brittle join and break for not-yet-scanned repos.
  This mirrors the existing precedent: `user_grid_state.active_tab_id` / `active_session_id` are
  deliberately non-FK TEXT pointers that the client tolerates as possibly-stale.

A tiny shared helper formalizes the mapping (web + hub):

```ts
// web/src/lib/repo-ident.ts  (and a hub twin or shared import)
export function repoIdent(row: { repo_key?: string | null; path?: string | null }): string | null {
  if (row.repo_key) return row.repo_key          // already "github://owner/repo"
  if (row.path)     return `path://${row.path}`
  return null                                     // unidentifiable → cannot be grouped
}
```

> Connections `Row` doesn't currently carry `repo_key` explicitly — it has `github.full_name` and
> `local.path`. P2 adds a derived `repoIdent` to each `Row` (from `github` → `buildRepoKey`-style
> `github://owner/repo`, else `path://<path>`). The hub already computes `repo_key`; we mirror the
> `buildRepoKey` format on the client for GitHub rows.

### 2.2 Tables (idempotent DDL for `hub/src/db/schema.sql`)

Follows the `chat_tabs` / `chat_tab_sessions` precedent exactly (CRUD parent + membership child,
both `ON DELETE CASCADE` from `users`). **Additive only — no backfill, safe to re-run every boot.**

```sql
-- ── Repo grouping (per-user, many-to-many) ───────────────────────────────────
-- User-defined groups for organizing repos in the Connections tab + sidebar.
-- A repo (identified by repo_ident, see below) may belong to 0..N groups.
-- repo_ident is "github://<owner>/<repo>" for GitHub-backed repos (host-agnostic,
-- matches hub/src/lib/repo-key.ts buildRepoKey) or "path://<abs-path>" for
-- local-only folders. NOT foreign-keyed: repos live transiently in scan output /
-- sessions / pending_local_repos, so a membership may reference a repo not
-- currently scanned; the client tolerates stale idents (cf. user_grid_state).
CREATE TABLE IF NOT EXISTS repo_groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_repo_groups_user_order
  ON repo_groups(user_id, sort_order, name);

CREATE TABLE IF NOT EXISTS repo_group_members (
  group_id    UUID NOT NULL REFERENCES repo_groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- denormalized for cheap user-scoped reads
  repo_ident  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, repo_ident)
);
CREATE INDEX IF NOT EXISTS idx_repo_group_members_user_ident
  ON repo_group_members(user_id, repo_ident);   -- "which groups is this repo in?" per user
CREATE INDEX IF NOT EXISTS idx_repo_group_members_group
  ON repo_group_members(group_id);

-- Per-user collapse state for group sections (cross-device, like user_grid_state).
-- One row per user; collapsed_group_ids is a JSON array of group-id strings that
-- are currently collapsed. The reserved literal '__ungrouped__' represents the
-- implicit Ungrouped section. Absent group ids default to EXPANDED.
CREATE TABLE IF NOT EXISTS user_repo_group_state (
  user_id             UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  collapsed_group_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**ON DELETE behavior:**
- Delete a `repo_groups` row → its `repo_group_members` rows cascade away. The repo itself is
  untouched (it just stops appearing under that group). Collapse-state pointer to the deleted
  group becomes stale and is ignored by the client (no FK, by design).
- Delete a `users` row → everything cascades (matches every other table).
- Removing a repo from the scan/inventory does NOT delete memberships (membership is durable; the
  repo may come back). Stale idents render nothing and are harmless.

**Why `user_id` on the membership table** (denormalized): the hottest query is "give me all of this
user's memberships in one shot" to build the grouped view — a single `WHERE user_id = $1` index
scan, no join to `repo_groups`. Integrity is enforced by always writing `user_id` from the
authenticated session and verifying `group_id` ownership on write.

### 2.3 Migration / backfill
**None required.** Purely additive tables; no existing data to transform. (Hard rule respected:
nothing inline-destructive in `schema.sql`; no `hub/scripts/` one-shot needed.)

---

## 3. API

New router `hub/src/api/repo-groups.ts`, mounted at `/api/repo-groups` behind `authMiddleware`
(JWT/opaque-cookie, user-scoped — same pattern as `hub/src/api/chat-tabs.ts`). DAL in
`hub/src/db/repo-groups-dal.ts`. All queries scoped by `user_id` from `c.get('userId')`.

### 3.1 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/repo-groups` | List the user's groups **with members**, ordered by `sort_order, name`. |
| `POST` | `/api/repo-groups` | Create a group `{ name }` → 201 with the new group. |
| `PATCH`| `/api/repo-groups/:id` | Rename `{ name }` and/or set `{ sort_order }`. |
| `DELETE`| `/api/repo-groups/:id` | Delete a group (members cascade). |
| `PUT`  | `/api/repo-groups/reorder` | Bulk reorder `{ ordered_ids: string[] }` → sets `sort_order` by index. |
| `POST` | `/api/repo-groups/:id/members` | Add a repo `{ repo_ident }` to the group (idempotent upsert). |
| `DELETE`| `/api/repo-groups/:id/members/:repo_ident` | Remove a repo from the group. (`repo_ident` URL-encoded.) |
| `PUT`  | `/api/repo-groups/:id/members` | **Replace** a group's full member set `{ repo_idents: string[] }` (for the "edit group membership" modal — one round trip). |
| `GET`  | `/api/repo-groups/collapse-state` | Get `{ collapsed_group_ids: string[] }`. |
| `PATCH`| `/api/repo-groups/collapse-state` | Set `{ collapsed_group_ids: string[] }` (full replace). |

> Optional convenience (decide in P2): `GET /api/repo-groups/by-repo?repo_ident=…` → groups a given
> repo belongs to. The `GET /api/repo-groups` (with members) already lets the client build the
> repo→groups inverse map locally for ~60 repos, so this is likely unnecessary. **Recommend: skip it.**

### 3.2 Zod shapes (request/response)

```ts
// Shared
const RepoIdent = z.string().min(1).max(512)
  .regex(/^(github:\/\/[^/]+\/.+|path:\/\/.+)$/, 'repo_ident must be github://owner/repo or path://<abs>');
const GroupName = z.string().trim().min(1).max(64);

// Responses
const GroupMember = z.object({ repo_ident: RepoIdent, created_at: z.string() });
const Group = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string(),
  members: z.array(GroupMember),     // included in GET /api/repo-groups
});
const GroupsResponse = z.object({ groups: z.array(Group) });

// Requests
const CreateGroupBody = z.object({ name: GroupName });
const PatchGroupBody  = z.object({ name: GroupName.optional(), sort_order: z.number().int().optional() })
  .refine(b => b.name !== undefined || b.sort_order !== undefined, 'no fields to update');
const ReorderBody     = z.object({ ordered_ids: z.array(z.string().uuid()).max(500) });
const AddMemberBody   = z.object({ repo_ident: RepoIdent });
const ReplaceMembersBody = z.object({ repo_idents: z.array(RepoIdent).max(2000) });
const CollapseStateBody  = z.object({ collapsed_group_ids: z.array(z.string()).max(2000) });
```

### 3.3 Auth, ownership, errors
- Every route requires `authMiddleware`; `userId` from context.
- Mutation on `:id` first verifies `repo_groups.id = :id AND user_id = $userId` → else `404`
  (don't leak existence). Same for member routes via the parent group.
- `POST` duplicate name → `409 { error: "group name already exists" }` (maps the
  `UNIQUE(user_id,name)` violation).
- Add-member is an idempotent `INSERT … ON CONFLICT (group_id, repo_ident) DO NOTHING`.
- `repo_ident` accepted as-is (no existence check — repo may be un-scanned). Format validated by Zod.

### 3.4 OpenAPI registration plan (mandatory — docs-drift CI)
- Define all routes as `createRoute` + Zod in `hub/src/api/_openapi.ts` (or a new
  `OpenAPIHono` subrouter `hub/src/api/repo-groups.openapi.ts` exported and mounted), tag
  `"repo-groups"`, `security: [{ bearerAuth: [] }]`, with 200/201/400/401/404/409 responses.
- Follow the existing dual-mount note: the plain-Hono router serves traffic; the OpenAPI
  declaration contributes the spec. (Or build the router itself as `OpenAPIHono` and skip the twin
  — preferred for a brand-new router; the sample in `_openapi.ts` only duplicates because it
  retrofits an existing plain route.)
- Run `bun run docs:sync` to regenerate `docs/openapi.json` + `docs/api.md`; commit both.
- Add a short subsystem doc `docs/repo-grouping.md` and a row in `CLAUDE.md`'s Docs map (rule 21 /
  same-commit doc update invariant).

---

## 4. Web UX

### 4.1 Where group management lives — **Connections tab**, inline (no new settings tab)
Settings is locked to exactly 4 tabs (Connections/Credentials/Usage/Profile) — do NOT add a
"Groups" tab. Group management lives **in the Connections tab header**, next to the existing
filter/type-filter/sort controls:

- A **"Groups" control** in the Connections toolbar: a small button/popover **"Groups ▾"** that opens
  a **manager popover/sheet** listing the user's groups with inline rename (click name → input),
  delete (icon button, confirm), reorder (up/down icon buttons — drag is a non-goal), and a
  "+ New group" input row. This is the CRUD surface. (Design prefs: icon-only actions in dense
  rows, accent-on-hover, `title=` tooltips; popover over a full modal for density.)
- Per design prefs, on `< md` the popover renders as a bottom sheet (mobile disclosure pattern).

### 4.2 Assigning a repo to groups — **per-row multi-select chip dropdown**
Each Connections repo row gets a small **groups affordance**: a tag/chip cluster showing the
group(s) the repo is in, plus a "＋" that opens a **multi-select checkbox dropdown** of all groups
(checked = member). Toggling a checkbox calls `POST`/`DELETE …/members`. Per design prefs:
multi-select → checkboxes; chips are `rounded-full` soft-tinted (`bg-[color]/15 ring-1 …`), color
derived from a deterministic hash of the group name (matches the avatar-tint rule).

Rationale for per-row over drag: with ~60 repos and many-to-many, a per-row checkbox dropdown is
the lowest-friction, most discoverable, and avoids the accordion/drag complexity the design prefs
discourage. The Groups manager popover handles bulk membership via the `PUT …/members` replace
endpoint ("edit which repos are in this group" → a searchable checklist of all repos).

### 4.3 Grouped + collapsible rendering in Connections
The existing single flat `rows: Row[]` (built in the `useMemo`) is **partitioned into sections**:

- Compute `repoIdent` per `Row` (P2 addition).
- Build `groups` from `GET /api/repo-groups`; build inverse `identToGroupIds: Map<string, string[]>`.
- For each group (in `sort_order`), render a **collapsible section header** (group name, member
  count badge, chevron) followed by the rows whose `repoIdent ∈ group.members`.
- **A repo in multiple groups renders under EACH group it belongs to** (duplicated across sections).
  This is the stated rule — it makes "show me everything in group X" complete and is what the
  many-to-many model implies. A subtle "in N groups" hint on the chip cluster signals duplication.
- Rows whose `repoIdent` is in **zero** groups (or whose ident is null/unidentifiable) fall into a
  trailing **"Ungrouped"** section (reserved id `__ungrouped__`), always last, not deletable.
- **Grouping is a view mode, default ON.** A toolbar toggle **"Group by"** (Groups | None) lets the
  user flip back to the current flat table. When "None", current behavior is unchanged. Persist the
  toggle in localStorage (`remo:repos-group-view`) — purely a view pref, not worth a server row.
- Existing **filters/sort still apply within each section** (filter first, then partition; a section
  with zero matching rows after filtering is hidden). Repos sort inside a section by the current
  `SortKey`.

> **Design-prefs tension (call-out):** the prefs say "No section accordions on desktop / one table
> beats N sections." Grouping is an explicit user request that overrides the default for THIS
> surface, and it is opt-in (toggle defaults can be revisited — see Open Questions). Sections are
> collapsible (not forced-open accordions) and the flat view remains one toggle away, which keeps
> the spirit (cross-state scannability stays available). Flag for user confirmation.

### 4.4 Sidebar mirroring
`Sidebar.tsx` renders the session list via `selectSessionList` (`session-list.ts`:
`collapseWorktrees` → `sortConnectedFirst`). Add an **optional grouped layout**:

- Sessions already carry `repo_key`; derive `repoIdent` (`repo_key` → `github://…`; null repo_key →
  `path://<canonical local path>` when available, else "Ungrouped").
- Reuse the SAME groups + collapse-state the Connections tab uses (one source of truth — the
  `/api/repo-groups` data + `/collapse-state`), so a group collapsed in one place can share state.
  **Decision:** collapse state is **shared** between Connections and sidebar (one
  `user_repo_group_state` row). Simpler mental model; one chevron per group everywhere.
- Render group headers (collapsible) above their sessions; orchestrator stays pinned at top,
  ABOVE all groups (unchanged). A session whose repo is in multiple groups appears under each group
  (consistent with Connections rule). Ungrouped sessions → trailing "Ungrouped" section.
- Sidebar grouping is also gated by the same "Group by" view toggle (shared pref) so the two
  surfaces stay consistent; on the collapsed (icon-rail) sidebar, grouping is suppressed (flat
  rail, unchanged).

### 4.5 Expand/collapse persistence
- **Server-persisted, per-user, cross-device** via `user_repo_group_state.collapsed_group_ids`
  (recommended over localStorage so phone + desktop agree). `GET/PATCH
  /api/repo-groups/collapse-state`.
- Client keeps an optimistic local copy; toggling a chevron PATCHes the full array (debounced).
  Mirrors how `user_grid_state` persists active tab/cell.
- The "Group by" view-mode toggle stays in **localStorage** (it's a lightweight per-device view
  pref, not state worth syncing — analogous to `remo:repos-filter`).

### 4.6 New web modules
- `web/src/lib/repo-ident.ts` — `repoIdent()` + `buildGithubIdent(owner,repo)` helpers.
- `web/src/lib/repo-groups.ts` — typed client (`listGroups`, `createGroup`, … , collapse-state).
- `web/src/hooks/useRepoGroups.ts` — fetch + cache groups, inverse ident→groups map, mutations.
- `web/src/components/groups/GroupsManagerPopover.tsx` — CRUD + reorder + bulk membership.
- `web/src/components/groups/RepoGroupChips.tsx` — per-row chips + multi-select dropdown.
- `web/src/components/groups/GroupSection.tsx` — collapsible section header (shared by both surfaces).

---

## 5. Phasing (incrementally shippable, one PR per phase, QC gate each)

Each phase ends with: `bun run check-baseline` green, `bun run build:web` clean, an independent
verifier subagent producing `VERIFICATION.md` (PASS/PARTIAL/MISSING + ship verdict), then the
docs/version/release sweep (rule 14). One branch = one phase = one PR off `main`.

**Assumes `fix/worktree-list-filter` and `feat/mobile-top-nav` land first** (see §6).

### Phase 1 — Data + API (no UI)
- Add the three tables to `schema.sql` (additive; verify idempotent re-run).
- `hub/src/db/repo-groups-dal.ts` + `hub/src/api/repo-groups.ts` (all endpoints, §3).
- Zod validation, ownership checks, 409 on dup name.
- OpenAPI registration in `_openapi.ts` (or `OpenAPIHono` router); `bun run docs:sync`; `docs/repo-grouping.md`.
- Tests: `hub/test/repo-groups.test.ts` (CRUD, many-to-many, ownership isolation across users,
  cascade on group delete, collapse-state round-trip, mount-order/auth-gate).
- **QC gate:** API contract tests green; `/openapi.json` includes the new tag; docs-drift passes.
- **Shippable:** backend ready, no user-visible change yet.

### Phase 2 — Connections grouping UI
- `repo-ident.ts`, `repo-groups.ts` client, `useRepoGroups` hook.
- Add derived `repoIdent` to Connections `Row`.
- `GroupsManagerPopover` (CRUD + reorder + bulk membership) in the Connections toolbar.
- `RepoGroupChips` per-row multi-select assignment.
- `GroupSection` collapsible partitioned rendering + "Group by" toggle (default — see Open Q).
- "Ungrouped" trailing section; multi-group duplication rule.
- Server-persisted collapse state wired.
- **QC gate:** `build:web` clean; manual smoke (create group, assign repo to 2 groups, collapse,
  reload → state persists); no-indigo + accent tests pass.
- **Shippable:** full grouping in Connections.

### Phase 3 — Sidebar grouping
- Extend `session-list.ts` with an optional grouped selector (derive `repoIdent` from `repo_key`).
- `Sidebar.tsx` renders `GroupSection`s sharing the Phase-2 groups + collapse state.
- Orchestrator stays pinned above groups; collapsed icon-rail unchanged.
- Respect the shared "Group by" toggle.
- **QC gate:** sidebar grouped view matches Connections groups; worktree collapse still correct;
  collapsed-rail unaffected.
- **Shippable:** grouping in both surfaces.

### Phase 4 — Reorder, polish, mobile, perf
- Group reorder UX finalized (`PUT /reorder`); member-count badges; empty-group affordance.
- Mobile: manager → bottom sheet; chip dropdown touch targets ≥44px; integrate with
  `feat/mobile-top-nav` header (see §6).
- Perf pass for the multi-group duplicated rendering at ~60 repos × N groups (memoize partitions;
  keep grid-view `react-virtual` parity if list grows).
- Accessibility: chevrons keyboard-toggleable, `aria-expanded`, focus rings (design prefs).
- **QC gate:** Lighthouse/interaction smoke on mobile; no regression in flat view.
- **Shippable:** feature-complete + polished.

> Optional **Phase 5** (only if scope grows): `path://` → `github://` ident auto-migration helper +
> a "merge duplicate idents" cleanup. Deferred unless the local-folder-gains-remote case bites.

---

## 6. Risks / Edge Cases

1. **Many-to-many rendering (duplication).** A repo in N groups appears N times. Decided rule:
   show under each group. Risk: visual repetition + N× action surface. Mitigation: member-count
   hint on chips; "Group by: None" toggle for the flat cross-state view; filters apply per section.
2. **Repo identity across supervisors / worktrees.** GitHub repos collapse to one `repo_key`
   (correct — membership shared across hosts). Local-only folders are `path://` and host-specific:
   the same folder on two machines = two idents = must be assigned per machine. Documented as
   expected; surfaced subtly (group membership won't follow a local-only folder to a new host).
3. **Local folder gains a GitHub remote later.** Its ident flips `path://` → `github://`; old
   membership under the `path://` ident goes stale (renders nothing, harmless). Phase-5 optional
   migration; meanwhile user re-assigns. No data loss.
4. **Null / unidentifiable repos** (no repo_key, no path) → always "Ungrouped"; cannot be assigned
   (the chips dropdown is disabled with a tooltip).
5. **Large lists / perf.** ~60 repos is small, but duplication across many groups multiplies row
   count. Memoize the partition; reuse `@tanstack/react-virtual` if a grouped list exceeds a
   threshold. Group fetch is one `GET` (≤ a few KB).
6. **Stale collapse / membership pointers.** Deleting a group leaves a stale id in
   `collapsed_group_ids`; client ignores unknown ids (non-FK by design, like `user_grid_state`).
7. **Migration/backfill:** none (additive). schema.sql re-run safe (idempotent `IF NOT EXISTS`).
8. **In-flight branch integration:**
   - **`fix/worktree-list-filter`** (Connections list filter): grouping partitions the *already
     filtered + worktree-hidden* `Row[]`. Build P2 **on top of** the cleaned-up filtered list —
     partition AFTER filtering. Risk: both touch the `rows` `useMemo` in `SupervisorPage.tsx` →
     rebase P2 onto it; coordinate the `useMemo` shape. Worktree-hidden rows must not resurface as
     group members.
   - **`feat/mobile-top-nav`** (mobile nav + header): the Groups toolbar control + per-row chips
     must fit the new mobile header/top-icon-bar. P4 explicitly integrates: Groups manager → bottom
     sheet, chips dropdown touch-friendly, ensure the "Group by" toggle has a home in the mobile
     header rather than colliding with the new top-icon-bar. Risk: header real-estate contention →
     coordinate placement; defer the mobile Groups entry point to P4 after `feat/mobile-top-nav`
     lands.
9. **Design-prefs "no desktop accordions" tension** (§4.3) — opt-in, collapsible (not forced),
   flat view one toggle away. Flagged for user sign-off.
10. **Group name uniqueness** is per-user (`UNIQUE(user_id,name)`); 409 surfaced inline in the
    manager. Renaming to an existing name → same 409.

---

## 7. Open Questions (genuine product decisions)

1. **Default view mode:** should grouping be **ON by default** once groups exist, or stay OFF
   (flat) until the user opts in via "Group by: Groups"? (Recommend: OFF until ≥1 group exists,
   then default ON — but confirm.)
2. **Shared vs separate collapse state** between Connections and sidebar: plan assumes **shared**
   (one chevron per group everywhere). OK, or do you want them independent?
3. **Multi-group duplication** confirmed as the rule (repo shown under every group it's in)? The
   alternative — show a repo only under its first/primary group — contradicts many-to-many; plan
   assumes full duplication.
4. **Ungrouped section:** always shown (even when empty / when grouping off)? Plan: shown only in
   grouped mode, hidden when it has zero rows after filtering.
5. **Desktop accordion exception** (§4.3 / §6.9): confirm you're OK overriding the "no desktop
   section accordions" design-pref for this surface, given it's your explicit request + opt-in.
6. **Should group reorder be drag-and-drop** (non-goal in this plan, up/down buttons only) — fine,
   or do you want DnD in P4?

# Repo grouping

User-defined, per-user **groups** for organizing repos in the **Connections** tab
and the sessions **sidebar**. Flat (non-nested) groups, many-to-many: a repo may
belong to 0..N groups and **renders under each** group it belongs to. An implicit,
collapsible **Ungrouped** section trails the user groups.

- Backend: `hub/src/db/repo-groups-dal.ts` + `hub/src/api/repo-groups.ts` (mounted
  `/api/repo-groups`, behind the standard `authMiddleware`, user-scoped).
- Web: `web/src/lib/repo-ident.ts`, `web/src/lib/repo-groups.ts`,
  `web/src/hooks/useRepoGroups.ts`, `web/src/components/groups/*`.
- Grouping is **opt-in** via a "Group by" toggle that **auto-turns-ON the first
  time the user creates a group**. Collapse state is **shared** between the
  Connections list and the sidebar.

## Repo identity (`repo_ident`)

Memberships key repos by a single normalized string:

| Repo kind | `repo_ident` | Notes |
|---|---|---|
| GitHub-backed | `github://<owner>/<repo>` | host-agnostic; matches `hub/src/lib/repo-key.ts` `buildRepoKey`. Worktrees/clones of one repo collapse to one ident → membership shared across hosts. |
| Local-only folder | `path://<absolute-path>` | host-specific fallback (no GitHub remote). |

`repo_ident` is **free TEXT, never foreign-keyed** — repos live transiently in scan
output / `sessions` / `pending_local_repos`, so a membership may reference a repo
not currently scanned. The client tolerates stale idents (same precedent as
`user_grid_state`). The shared helper is `web/src/lib/repo-ident.ts` `repoIdent()`.

## Tables (`hub/src/db/schema.sql` — additive, idempotent, re-runs every boot)

```
repo_groups(id, user_id, name, sort_order, created_at, updated_at)
  UNIQUE(user_id, name);  INDEX(user_id, sort_order, name)
repo_group_members(group_id, user_id, repo_ident, created_at)
  PRIMARY KEY(group_id, repo_ident);  INDEX(user_id, repo_ident); INDEX(group_id)
user_repo_group_state(user_id PK, collapsed_group_ids jsonb, updated_at)
```

Cascade chain: `users → repo_groups → repo_group_members`. Deleting a group
cascades its members (the repos are untouched). `user_id` is denormalized onto
`repo_group_members` so the hot "all of this user's memberships" read is a single
index scan with no join. `collapsed_group_ids` is a JSON array of group-id strings
(reserved literal `__ungrouped__` for the implicit Ungrouped section); absent ids
default to **expanded**. No backfill required (purely additive).

## API (`/api/repo-groups`, user-scoped)

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/repo-groups` | List groups **with members**, ordered by `sort_order, name`. |
| `POST` | `/api/repo-groups` | Create `{ name }` → 201. 409 on duplicate name. |
| `PUT` | `/api/repo-groups/reorder` | Bulk reorder `{ ordered_ids: string[] }`. |
| `PATCH` | `/api/repo-groups/:id` | Rename `{ name }` and/or `{ sort_order }`. 409 on dup name. |
| `DELETE` | `/api/repo-groups/:id` | Delete a group (members cascade). |
| `POST` | `/api/repo-groups/:id/members` | Add `{ repo_ident }` (idempotent upsert). |
| `PUT` | `/api/repo-groups/:id/members` | Replace full member set `{ repo_idents: string[] }`. |
| `DELETE` | `/api/repo-groups/:id/members/:repo_ident` | Remove a repo (`repo_ident` URL-encoded). |
| `GET` | `/api/repo-groups/collapse-state` | `{ collapsed_group_ids: string[] }`. |
| `PATCH` | `/api/repo-groups/collapse-state` | Full-replace `{ collapsed_group_ids: string[] }`. |

- All inputs Zod-validated; `repo_ident` must match `github://owner/repo` or
  `path://<abs>`. Group name 1–64 chars.
- **Ownership leakage policy:** a mutation on another user's group/member returns
  **404** (not 403). Add-member is idempotent (`ON CONFLICT DO NOTHING`).
- OpenAPI: registered (spec-only) in `hub/src/api/_openapi.ts` under tag
  `repo-groups`; the plain-Hono router serves traffic. Run `bun run docs:sync`
  after route changes (docs-drift CI enforces).

## Rendering rules

- **Grouped is a view mode** gated by a "Group by" toggle (localStorage
  `remo:repos-group-view`); auto-ON the first time a group is created.
- Connections grouping partitions the **already-filtered + worktree-hidden** `rows`
  (`web/src/components/SupervisorPage.tsx`) — partition AFTER filtering so hidden
  worktrees never resurface as members. Filters/sort apply within each section.
- Sidebar grouping rides `web/src/lib/session-list.ts` (`groupSessions`) +
  `web/src/components/Sidebar.tsx`, sharing the same groups + collapse state.
  Orchestrator stays pinned above all groups; the collapsed icon-rail is flat.
- A repo in N groups renders under **each** group. Repos in zero groups fall into
  the trailing, collapsible **Ungrouped** section.

## Tests

- `hub/test/repo-groups.test.ts` — Zod schema contract (always-on) + env-gated DAL
  e2e (CRUD, many-to-many, ownership isolation, cascade, collapse-state, reorder).
- `web/test/repo-groups.test.ts` — `repoIdent` mapping + grouping partition
  (multi-group duplication, Ungrouped section, toggle default-on-create).

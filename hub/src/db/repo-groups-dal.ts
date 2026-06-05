/**
 * DAL for repo grouping (per-user, many-to-many).
 *
 * Three tables: `repo_groups` (user-owned named groups), `repo_group_members`
 * (membership rows linking group → repo_ident), and `user_repo_group_state`
 * (per-user collapsed-section state, cross-device).
 *
 * Every query is user-scoped — either directly via `WHERE user_id = $1`, or by
 * verifying group ownership before any membership write. No function trusts the
 * caller for ownership; cross-user access returns null/false (router maps → 404).
 *
 * repo_ident is "github://<owner>/<repo>" (host-agnostic, matches
 * hub/src/lib/repo-key.ts buildRepoKey) or "path://<abs-path>" for local-only
 * folders. It is free TEXT, never FK'd — see schema.sql for rationale.
 */
import { sql } from './postgres.ts'

export interface RepoGroupMember {
  repo_ident: string
  created_at: string
}

export interface RepoGroup {
  id: string
  user_id: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface RepoGroupWithMembers extends RepoGroup {
  members: RepoGroupMember[]
}

/** Raised by createGroup/updateGroup when UNIQUE(user_id,name) is violated. */
export class DuplicateGroupNameError extends Error {
  constructor() {
    super('group name already exists')
    this.name = 'DuplicateGroupNameError'
  }
}

function isUniqueViolation(e: unknown): boolean {
  // postgres.js surfaces the SQLSTATE on `.code`; 23505 = unique_violation.
  return !!e && typeof e === 'object' && (e as any).code === '23505'
}

// ── Groups (+ members) ──────────────────────────────────────────────────────

/** List the user's groups with their members, ordered by sort_order, name. */
export async function listGroupsForUser(userId: string): Promise<RepoGroupWithMembers[]> {
  const groups = await sql<RepoGroup[]>`
    SELECT id, user_id, name, sort_order, created_at, updated_at
    FROM repo_groups
    WHERE user_id = ${userId}
    ORDER BY sort_order ASC, name ASC
  `
  if (groups.length === 0) return []
  const groupIds = groups.map((g) => g.id)
  const members = await sql<({ group_id: string } & RepoGroupMember)[]>`
    SELECT group_id, repo_ident, created_at
    FROM repo_group_members
    WHERE user_id = ${userId}
      AND group_id = ANY(${groupIds})
    ORDER BY created_at ASC
  `
  const byGroup = new Map<string, RepoGroupMember[]>()
  for (const m of members) {
    const arr = byGroup.get(m.group_id) ?? []
    arr.push({ repo_ident: m.repo_ident, created_at: m.created_at })
    byGroup.set(m.group_id, arr)
  }
  return groups.map((g) => ({ ...g, members: byGroup.get(g.id) ?? [] }))
}

export async function getGroup(groupId: string, userId: string): Promise<RepoGroup | null> {
  const rows = await sql<RepoGroup[]>`
    SELECT id, user_id, name, sort_order, created_at, updated_at
    FROM repo_groups
    WHERE id = ${groupId} AND user_id = ${userId}
  `
  return rows[0] ?? null
}

export async function createGroup(userId: string, fields: { name: string }): Promise<RepoGroup> {
  // Next sort_order for this user (max + 1) so new groups append at the end.
  const posRows = await sql<{ pos: number }[]>`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS pos
    FROM repo_groups WHERE user_id = ${userId}
  `
  const sortOrder = posRows[0]?.pos ?? 0
  try {
    const rows = await sql<RepoGroup[]>`
      INSERT INTO repo_groups (user_id, name, sort_order)
      VALUES (${userId}, ${fields.name}, ${sortOrder})
      RETURNING id, user_id, name, sort_order, created_at, updated_at
    `
    return rows[0]!
  } catch (e) {
    if (isUniqueViolation(e)) throw new DuplicateGroupNameError()
    throw e
  }
}

export async function updateGroup(
  groupId: string,
  userId: string,
  fields: { name?: string; sort_order?: number },
): Promise<RepoGroup | null> {
  try {
    const rows = await sql<RepoGroup[]>`
      UPDATE repo_groups SET
        name       = COALESCE(${fields.name ?? null}, name),
        sort_order = COALESCE(${fields.sort_order ?? null}::int, sort_order),
        updated_at = now()
      WHERE id = ${groupId} AND user_id = ${userId}
      RETURNING id, user_id, name, sort_order, created_at, updated_at
    `
    return rows[0] ?? null
  } catch (e) {
    if (isUniqueViolation(e)) throw new DuplicateGroupNameError()
    throw e
  }
}

export async function deleteGroup(groupId: string, userId: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM repo_groups WHERE id = ${groupId} AND user_id = ${userId} RETURNING id
  `
  return rows.length > 0
}

/**
 * Rewrite group sort_order to gap-free order based on the given id list. Any
 * group not in the list keeps its prior order. Scoped to the user; runs in a
 * transaction so the rewrite is atomic.
 */
export async function setGroupOrder(userId: string, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return
  await sql.begin(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx`
        UPDATE repo_groups SET sort_order = ${i}, updated_at = now()
        WHERE id = ${orderedIds[i]} AND user_id = ${userId}
      `
    }
  })
}

// ── Members ─────────────────────────────────────────────────────────────────

/**
 * Add a repo to a group (idempotent). Verifies the group belongs to the user
 * first. Returns false when the group is not owned by the user.
 */
export async function addMember(
  groupId: string,
  userId: string,
  repoIdent: string,
): Promise<boolean> {
  const own = await sql<{ id: string }[]>`
    SELECT id FROM repo_groups WHERE id = ${groupId} AND user_id = ${userId}
  `
  if (!own[0]) return false
  await sql`
    INSERT INTO repo_group_members (group_id, user_id, repo_ident)
    VALUES (${groupId}, ${userId}, ${repoIdent})
    ON CONFLICT (group_id, repo_ident) DO NOTHING
  `
  return true
}

export async function removeMember(
  groupId: string,
  userId: string,
  repoIdent: string,
): Promise<boolean> {
  // Verify ownership first so a non-owner gets 404 (not silent success).
  const own = await sql<{ id: string }[]>`
    SELECT id FROM repo_groups WHERE id = ${groupId} AND user_id = ${userId}
  `
  if (!own[0]) return false
  await sql`
    DELETE FROM repo_group_members
    WHERE group_id = ${groupId} AND user_id = ${userId} AND repo_ident = ${repoIdent}
  `
  return true
}

/**
 * Replace a group's full member set in one transaction. Verifies group
 * ownership first. Returns false when the group is not owned by the user.
 */
export async function replaceMembers(
  groupId: string,
  userId: string,
  repoIdents: string[],
): Promise<boolean> {
  const own = await sql<{ id: string }[]>`
    SELECT id FROM repo_groups WHERE id = ${groupId} AND user_id = ${userId}
  `
  if (!own[0]) return false
  const unique = Array.from(new Set(repoIdents))
  await sql.begin(async (tx) => {
    await tx`DELETE FROM repo_group_members WHERE group_id = ${groupId} AND user_id = ${userId}`
    for (const ident of unique) {
      await tx`
        INSERT INTO repo_group_members (group_id, user_id, repo_ident)
        VALUES (${groupId}, ${userId}, ${ident})
        ON CONFLICT (group_id, repo_ident) DO NOTHING
      `
    }
  })
  return true
}

// ── Collapse state ──────────────────────────────────────────────────────────

export interface CollapseState {
  collapsed_group_ids: string[]
}

/** Read the user's persisted collapse state (defaults to empty = all expanded). */
export async function getCollapseState(userId: string): Promise<CollapseState> {
  const rows = await sql<{ collapsed_group_ids: string[] }[]>`
    SELECT collapsed_group_ids
    FROM user_repo_group_state
    WHERE user_id = ${userId}
  `
  return { collapsed_group_ids: rows[0]?.collapsed_group_ids ?? [] }
}

/**
 * Upsert the user's collapse state (full replace of the collapsed-ids array).
 * Last-write-wins across concurrent tabs — acceptable for a view preference.
 */
export async function setCollapseState(
  userId: string,
  collapsedGroupIds: string[],
): Promise<CollapseState> {
  const rows = await sql<{ collapsed_group_ids: string[] }[]>`
    INSERT INTO user_repo_group_state (user_id, collapsed_group_ids, updated_at)
    VALUES (${userId}, ${sql.json(collapsedGroupIds)}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      collapsed_group_ids = ${sql.json(collapsedGroupIds)},
      updated_at          = now()
    RETURNING collapsed_group_ids
  `
  return { collapsed_group_ids: rows[0]?.collapsed_group_ids ?? [] }
}

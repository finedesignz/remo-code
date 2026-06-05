/**
 * REST router for repo grouping (per-user, many-to-many).
 *
 * Mounted at `/api/repo-groups` behind the existing JWT `authMiddleware`.
 * `userId` is read from the Hono context (set by middleware).
 *
 * Endpoints:
 *   GET    /                          → { groups: RepoGroupWithMembers[] }
 *   POST   /                          → RepoGroup (201) | 409 dup name
 *   PUT    /reorder                   → 204 (bulk reorder)
 *   GET    /collapse-state            → { collapsed_group_ids: string[] }
 *   PATCH  /collapse-state            → { collapsed_group_ids: string[] }
 *   PATCH  /:id                       → RepoGroup | 404 | 409 dup name
 *   DELETE /:id                       → 204 | 404
 *   POST   /:id/members               → 204 (idempotent add) | 404
 *   PUT    /:id/members               → 204 (replace member set) | 404
 *   DELETE /:id/members/:repo_ident   → 204 | 404  (repo_ident URL-encoded)
 *
 * Ownership leakage policy: requests by user A against user B's group/member
 * return 404 (not 403) so existence is not leaked.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  listGroupsForUser,
  createGroup,
  updateGroup,
  deleteGroup,
  setGroupOrder,
  addMember,
  removeMember,
  replaceMembers,
  getCollapseState,
  setCollapseState,
  DuplicateGroupNameError,
} from '../db/repo-groups-dal.ts'

export const repoGroups = new Hono()

// ── Schemas ─────────────────────────────────────────────────────────────────

// repo_ident is "github://owner/repo" or "path://<abs>". Kept permissive on the
// path branch (Windows drive paths, spaces) — only the scheme prefix is enforced.
export const RepoIdent = z
  .string()
  .min(1)
  .max(512)
  .regex(/^(github:\/\/[^/]+\/.+|path:\/\/.+)$/, 'repo_ident must be github://owner/repo or path://<abs>')

const GroupName = z.string().trim().min(1).max(64)

const CreateGroupBody = z.object({ name: GroupName })
const PatchGroupBody = z
  .object({ name: GroupName.optional(), sort_order: z.number().int().min(0).optional() })
  .refine((b) => b.name !== undefined || b.sort_order !== undefined, 'no fields to update')
const ReorderBody = z.object({ ordered_ids: z.array(z.string().uuid()).max(500) })
const AddMemberBody = z.object({ repo_ident: RepoIdent })
const ReplaceMembersBody = z.object({ repo_idents: z.array(RepoIdent).max(2000) })
const CollapseStateBody = z.object({ collapsed_group_ids: z.array(z.string().max(64)).max(2000) })

// ── Routes ──────────────────────────────────────────────────────────────────

repoGroups.get('/', async (c) => {
  const userId = c.get('userId') as string
  const groups = await listGroupsForUser(userId)
  return c.json({ groups })
})

repoGroups.post('/', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = CreateGroupBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  try {
    const group = await createGroup(userId, parsed.data)
    return c.json(group, 201)
  } catch (e) {
    if (e instanceof DuplicateGroupNameError) return c.json({ error: 'group name already exists' }, 409)
    throw e
  }
})

// Literal paths declared BEFORE `/:id` so they win the route match.
repoGroups.put('/reorder', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = ReorderBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  await setGroupOrder(userId, parsed.data.ordered_ids)
  return c.body(null, 204)
})

repoGroups.get('/collapse-state', async (c) => {
  const userId = c.get('userId') as string
  return c.json(await getCollapseState(userId))
})

repoGroups.patch('/collapse-state', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = CollapseStateBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  return c.json(await setCollapseState(userId, parsed.data.collapsed_group_ids))
})

repoGroups.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = PatchGroupBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  try {
    const updated = await updateGroup(id, userId, parsed.data)
    if (!updated) return c.json({ error: 'not_found' }, 404)
    return c.json(updated)
  } catch (e) {
    if (e instanceof DuplicateGroupNameError) return c.json({ error: 'group name already exists' }, 409)
    throw e
  }
})

repoGroups.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const ok = await deleteGroup(c.req.param('id'), userId)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

repoGroups.post('/:id/members', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = AddMemberBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  const ok = await addMember(c.req.param('id'), userId, parsed.data.repo_ident)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

repoGroups.put('/:id/members', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = ReplaceMembersBody.safeParse(body)
  if (!parsed.success) return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  const ok = await replaceMembers(c.req.param('id'), userId, parsed.data.repo_idents)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

repoGroups.delete('/:id/members/:repo_ident', async (c) => {
  const userId = c.get('userId') as string
  const repoIdent = decodeURIComponent(c.req.param('repo_ident'))
  const ok = await removeMember(c.req.param('id'), userId, repoIdent)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

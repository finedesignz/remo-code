/**
 * REST router for multichat grid view tabs (Phase 03 / PLAN-001 / T4).
 *
 * Mounted at `/api/chat-tabs` behind the existing JWT `authMiddleware`.
 * `userId` is read from the Hono context (set by middleware).
 *
 * Endpoints:
 *   GET    /                       → ChatTabWithSessions[]
 *   POST   /                       → ChatTab
 *   PATCH  /order                  → 204 (bulk reorder tabs)
 *   PATCH  /:id                    → ChatTab
 *   DELETE /:id                    → 204
 *   POST   /:id/sessions           → 204 (body { session_id })
 *   DELETE /:id/sessions/:sid      → 204
 *   PATCH  /:id/sessions           → 204 (bulk reorder memberships)
 *
 * Ownership leakage policy: requests by user A against user B's tab/membership
 * return 404 (not 403) so existence is not leaked.
 */
import { Hono } from 'hono'
import { z } from 'zod'
import {
  listTabsForUser,
  getTab,
  createTab,
  updateTab,
  deleteTab,
  setTabPositions,
  addSessionToTab,
  removeSessionFromTab,
  setTabSessionPositions,
  getGridState,
  setGridState,
} from '../db/chat-tabs-dal.ts'

export const chatTabs = new Hono()

// ── Schemas ───────────────────────────────────────────────────────────────────

const LayoutEnum = z.enum(['3x3', '4x3', 'auto-fit'])

const CreateBody = z.object({
  name: z.string().trim().min(1).max(64),
  layout: LayoutEnum.optional(),
})

const PatchBody = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  layout: LayoutEnum.optional(),
  position: z.number().int().min(0).optional(),
})

const OrderTabsBody = z.object({
  ordered_tab_ids: z.array(z.string().uuid()).min(1).max(200),
})

const AddSessionBody = z.object({
  session_id: z.string().min(1).max(100),
})

const ReorderSessionsBody = z.object({
  ordered_session_ids: z.array(z.string().min(1).max(100)).min(1).max(50),
})

// Grid UI state (Phase 13). active_tab_id is free text: the virtual Default tab
// uses the reserved literal '__default__'; user tabs use the chat_tabs UUID.
const GridStateBody = z.object({
  active_tab_id: z.string().min(1).max(64).nullable().optional(),
  active_session_id: z.string().min(1).max(100).nullable().optional(),
})

// ── Routes ────────────────────────────────────────────────────────────────────

chatTabs.get('/', async (c) => {
  const userId = c.get('userId') as string
  const tabs = await listTabsForUser(userId)
  return c.json({ tabs })
})

chatTabs.post('/', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = CreateBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const tab = await createTab(userId, parsed.data)
  return c.json(tab, 201)
})

// Grid UI state — MUST be declared before `/:id` so the literal path wins.
chatTabs.get('/grid-state', async (c) => {
  const userId = c.get('userId') as string
  return c.json(await getGridState(userId))
})

chatTabs.patch('/grid-state', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = GridStateBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  return c.json(await setGridState(userId, parsed.data))
})

// MUST be declared before `/:id` so it doesn't get captured by the param route.
chatTabs.patch('/order', async (c) => {
  const userId = c.get('userId') as string
  const body = await c.req.json().catch(() => null)
  const parsed = OrderTabsBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  await setTabPositions(userId, parsed.data.ordered_tab_ids)
  return c.body(null, 204)
})

chatTabs.patch('/:id', async (c) => {
  const userId = c.get('userId') as string
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = PatchBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const updated = await updateTab(id, userId, parsed.data)
  if (!updated) return c.json({ error: 'not_found' }, 404)
  return c.json(updated)
})

chatTabs.delete('/:id', async (c) => {
  const userId = c.get('userId') as string
  const ok = await deleteTab(c.req.param('id'), userId)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

chatTabs.post('/:id/sessions', async (c) => {
  const userId = c.get('userId') as string
  const tabId = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = AddSessionBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const ok = await addSessionToTab(tabId, userId, parsed.data.session_id)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

chatTabs.delete('/:id/sessions/:sid', async (c) => {
  const userId = c.get('userId') as string
  const ok = await removeSessionFromTab(c.req.param('id'), userId, c.req.param('sid'))
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

chatTabs.patch('/:id/sessions', async (c) => {
  const userId = c.get('userId') as string
  const tabId = c.req.param('id')
  const body = await c.req.json().catch(() => null)
  const parsed = ReorderSessionsBody.safeParse(body)
  if (!parsed.success) {
    return c.json({ error: 'invalid_body', issues: parsed.error.issues }, 400)
  }
  const ok = await setTabSessionPositions(tabId, userId, parsed.data.ordered_session_ids)
  if (!ok) return c.json({ error: 'not_found' }, 404)
  return c.body(null, 204)
})

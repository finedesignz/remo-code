/**
 * Typed fetch wrappers for `/api/chat-tabs` + the batch-messages endpoint.
 *
 * Mirrors the Zod schemas in `hub/src/api/chat-tabs.ts` and the DAL shapes in
 * `hub/src/db/chat-tabs-dal.ts`. Used exclusively by `useChatTabs` and
 * `GridPage`. Single-purpose — do not bloat with unrelated calls.
 */
import { hubFetch } from './api'
import type { ChatMessage } from '../hooks/useChat'

export type TabLayout = '3x3' | '4x3' | 'auto-fit'

/** Hard cap on cells rendered per tab. Mirrors the server-side limit. */
export const MAX_CELLS_PER_TAB = 12

/**
 * Reserved id for the VIRTUAL "Default" tab (Phase 13). This tab has no
 * `chat_tabs` row and no `chat_tab_sessions` memberships — its cells are
 * computed client-side from all currently-active sessions (List-View parity).
 * It can't be renamed, deleted, or reordered.
 */
export const DEFAULT_TAB_ID = '__default__'

export interface ChatTab {
  id: string
  user_id: string
  name: string
  layout: TabLayout
  position: number
  created_at: string
  updated_at: string
}

export interface SessionRef {
  session_id: string
  position: number
  name: string
  project_dir: string | null
  status: string
}

export interface TabWithSessions extends ChatTab {
  sessions: SessionRef[]
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

export async function listTabs(token: string): Promise<TabWithSessions[]> {
  const data = await hubFetch<{ tabs: TabWithSessions[] }>(token, '/api/chat-tabs')
  return data.tabs ?? []
}

export async function createTab(
  token: string,
  fields: { name: string; layout?: TabLayout },
): Promise<ChatTab> {
  return hubFetch<ChatTab>(token, '/api/chat-tabs', {
    method: 'POST',
    json: fields,
  })
}

export async function patchTab(
  token: string,
  id: string,
  fields: { name?: string; layout?: TabLayout; position?: number },
): Promise<ChatTab> {
  return hubFetch<ChatTab>(token, `/api/chat-tabs/${id}`, {
    method: 'PATCH',
    json: fields,
  })
}

export async function deleteTab(token: string, id: string): Promise<void> {
  await hubFetch(token, `/api/chat-tabs/${id}`, { method: 'DELETE', raw: true })
}

export async function reorderTabs(token: string, orderedIds: string[]): Promise<void> {
  await hubFetch(token, '/api/chat-tabs/order', {
    method: 'PATCH',
    json: { ordered_tab_ids: orderedIds },
    raw: true,
  })
}

// ── Memberships ───────────────────────────────────────────────────────────────

export async function addSessionToTab(
  token: string,
  tabId: string,
  sessionId: string,
): Promise<void> {
  await hubFetch(token, `/api/chat-tabs/${tabId}/sessions`, {
    method: 'POST',
    json: { session_id: sessionId },
    raw: true,
  })
}

export async function removeSessionFromTab(
  token: string,
  tabId: string,
  sessionId: string,
): Promise<void> {
  await hubFetch(token, `/api/chat-tabs/${tabId}/sessions/${sessionId}`, {
    method: 'DELETE',
    raw: true,
  })
}

export async function reorderTabSessions(
  token: string,
  tabId: string,
  orderedSessionIds: string[],
): Promise<void> {
  await hubFetch(token, `/api/chat-tabs/${tabId}/sessions`, {
    method: 'PATCH',
    json: { ordered_session_ids: orderedSessionIds },
    raw: true,
  })
}

// ── Grid UI state (Phase 13) ──────────────────────────────────────────────────

export interface GridState {
  active_tab_id: string | null
  active_session_id: string | null
}

export async function getGridState(token: string): Promise<GridState> {
  return hubFetch<GridState>(token, '/api/chat-tabs/grid-state')
}

export async function patchGridState(
  token: string,
  fields: { active_tab_id?: string | null; active_session_id?: string | null },
): Promise<GridState> {
  return hubFetch<GridState>(token, '/api/chat-tabs/grid-state', {
    method: 'PATCH',
    json: fields,
  })
}

// ── Batch messages ────────────────────────────────────────────────────────────

/**
 * Fetch last `limit` messages per session in ONE round-trip. Used to hydrate
 * all cells of a tab on activation. Hard cap of 12 ids enforced server-side.
 */
export async function batchMessages(
  token: string,
  sessionIds: string[],
  limit = 30,
): Promise<Record<string, ChatMessage[]>> {
  if (sessionIds.length === 0) return {}
  const ids = sessionIds.join(',')
  return hubFetch<Record<string, ChatMessage[]>>(
    token,
    `/api/sessions/messages?ids=${encodeURIComponent(ids)}&limit=${limit}`,
  )
}

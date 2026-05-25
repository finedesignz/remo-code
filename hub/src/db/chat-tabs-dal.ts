/**
 * DAL for multichat grid view (Phase 03).
 *
 * Two tables: `chat_tabs` (user-owned named tabs) and `chat_tab_sessions`
 * (membership rows linking tab → session with `position` for ordering).
 *
 * Every query touching these tables is user-scoped — either directly via
 * `WHERE user_id = $1` on `chat_tabs`, or via a JOIN through `chat_tabs`
 * for `chat_tab_sessions`. No function trusts the caller for ownership.
 *
 * Reorder helpers (`setTabPositions`, `setTabSessionPositions`) run inside
 * a transaction (`sql.begin`) so the rewrite is atomic.
 */
import { sql } from './postgres.ts'

export type TabLayout = '3x3' | '4x3' | 'auto-fit'

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

export async function listTabsForUser(userId: string): Promise<TabWithSessions[]> {
  const tabs = await sql<ChatTab[]>`
    SELECT id, user_id, name, layout, position, created_at, updated_at
    FROM chat_tabs
    WHERE user_id = ${userId}
    ORDER BY position ASC, created_at ASC
  `
  if (tabs.length === 0) return []
  const tabIds = tabs.map((t) => t.id)
  const memberships = await sql<SessionRef[] & { tab_id: string }[]>`
    SELECT cts.tab_id, cts.session_id, cts.position, s.name, s.project_dir, s.status
    FROM chat_tab_sessions cts
    JOIN chat_tabs ct ON ct.id = cts.tab_id
    JOIN sessions s ON s.id = cts.session_id
    WHERE ct.user_id = ${userId}
      AND cts.tab_id = ANY(${tabIds})
      AND s.deleted_at IS NULL
    ORDER BY cts.tab_id, cts.position ASC, cts.created_at ASC
  `
  const byTab = new Map<string, SessionRef[]>()
  for (const m of memberships as any[]) {
    const arr = byTab.get(m.tab_id) ?? []
    arr.push({
      session_id: m.session_id,
      position: m.position,
      name: m.name,
      project_dir: m.project_dir,
      status: m.status,
    })
    byTab.set(m.tab_id, arr)
  }
  return tabs.map((t) => ({ ...t, sessions: byTab.get(t.id) ?? [] }))
}

export async function getTab(tabId: string, userId: string): Promise<TabWithSessions | null> {
  const rows = await sql<ChatTab[]>`
    SELECT id, user_id, name, layout, position, created_at, updated_at
    FROM chat_tabs
    WHERE id = ${tabId} AND user_id = ${userId}
  `
  if (!rows[0]) return null
  const sessions = await listSessionsForTab(tabId, userId)
  return { ...rows[0], sessions }
}

export async function createTab(
  userId: string,
  fields: { name: string; layout?: TabLayout },
): Promise<ChatTab> {
  // Pick next position for this user (max + 1).
  const posRows = await sql<{ pos: number }[]>`
    SELECT COALESCE(MAX(position), -1) + 1 AS pos
    FROM chat_tabs WHERE user_id = ${userId}
  `
  const position = posRows[0]?.pos ?? 0
  const rows = await sql<ChatTab[]>`
    INSERT INTO chat_tabs (user_id, name, layout, position)
    VALUES (${userId}, ${fields.name}, ${fields.layout ?? 'auto-fit'}, ${position})
    RETURNING id, user_id, name, layout, position, created_at, updated_at
  `
  return rows[0]!
}

export async function updateTab(
  tabId: string,
  userId: string,
  fields: { name?: string; layout?: TabLayout; position?: number },
): Promise<ChatTab | null> {
  // Build a CASE-expression update so we can patch any subset in one round-trip,
  // and still scope by user_id.
  const rows = await sql<ChatTab[]>`
    UPDATE chat_tabs SET
      name       = COALESCE(${fields.name ?? null}, name),
      layout     = COALESCE(${fields.layout ?? null}, layout),
      position   = COALESCE(${fields.position ?? null}::int, position),
      updated_at = now()
    WHERE id = ${tabId} AND user_id = ${userId}
    RETURNING id, user_id, name, layout, position, created_at, updated_at
  `
  return rows[0] ?? null
}

export async function deleteTab(tabId: string, userId: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM chat_tabs WHERE id = ${tabId} AND user_id = ${userId} RETURNING id
  `
  return rows.length > 0
}

/**
 * Rewrite tab positions to gap-free order based on the given id list.
 * Any tab not in the list keeps its prior position. Runs in a transaction.
 */
export async function setTabPositions(userId: string, orderedIds: string[]): Promise<void> {
  if (orderedIds.length === 0) return
  await sql.begin(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx`
        UPDATE chat_tabs SET position = ${i}, updated_at = now()
        WHERE id = ${orderedIds[i]} AND user_id = ${userId}
      `
    }
  })
}

// ── Memberships ───────────────────────────────────────────────────────────────

export async function listSessionsForTab(tabId: string, userId: string): Promise<SessionRef[]> {
  const rows = await sql<SessionRef[]>`
    SELECT cts.session_id, cts.position, s.name, s.project_dir, s.status
    FROM chat_tab_sessions cts
    JOIN chat_tabs ct ON ct.id = cts.tab_id
    JOIN sessions s ON s.id = cts.session_id
    WHERE cts.tab_id = ${tabId}
      AND ct.user_id = ${userId}
      AND s.deleted_at IS NULL
    ORDER BY cts.position ASC, cts.created_at ASC
  `
  return rows
}

/**
 * Add a session to a tab. Verifies the tab belongs to user AND the session
 * belongs to user before inserting. Auto-assigns position = max+1.
 * Returns false if either ownership check fails.
 */
export async function addSessionToTab(
  tabId: string,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  // Verify both belong to user in a single query
  const own = await sql<{ ok: boolean }[]>`
    SELECT
      EXISTS(SELECT 1 FROM chat_tabs WHERE id = ${tabId} AND user_id = ${userId})
      AND EXISTS(SELECT 1 FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL)
      AS ok
  `
  if (!own[0]?.ok) return false
  const posRows = await sql<{ pos: number }[]>`
    SELECT COALESCE(MAX(position), -1) + 1 AS pos
    FROM chat_tab_sessions WHERE tab_id = ${tabId}
  `
  const position = posRows[0]?.pos ?? 0
  await sql`
    INSERT INTO chat_tab_sessions (tab_id, session_id, position)
    VALUES (${tabId}, ${sessionId}, ${position})
    ON CONFLICT (tab_id, session_id) DO NOTHING
  `
  return true
}

export async function removeSessionFromTab(
  tabId: string,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM chat_tab_sessions
    WHERE tab_id = ${tabId}
      AND session_id = ${sessionId}
      AND tab_id IN (SELECT id FROM chat_tabs WHERE user_id = ${userId})
    RETURNING tab_id
  `
  return rows.length > 0
}

/**
 * Bulk reorder of memberships within a tab. Rewrites positions to gap-free
 * order in a transaction. Silently skips ids that aren't members of the tab.
 */
export async function setTabSessionPositions(
  tabId: string,
  userId: string,
  orderedSessionIds: string[],
): Promise<boolean> {
  // Verify tab ownership before any writes
  const own = await sql<{ id: string }[]>`
    SELECT id FROM chat_tabs WHERE id = ${tabId} AND user_id = ${userId}
  `
  if (!own[0]) return false
  if (orderedSessionIds.length === 0) return true
  await sql.begin(async (tx) => {
    for (let i = 0; i < orderedSessionIds.length; i++) {
      await tx`
        UPDATE chat_tab_sessions SET position = ${i}
        WHERE tab_id = ${tabId} AND session_id = ${orderedSessionIds[i]}
      `
    }
  })
  return true
}

// ── Batch messages ────────────────────────────────────────────────────────────

export interface BatchMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  status: 'streaming' | 'complete' | 'interrupted'
  created_at: string
}

/**
 * Fetch the last `limit` messages (oldest-first within each session) for
 * each of the requested `sessionIds`, filtered to sessions the user owns.
 * Runs in a single SQL round-trip using a window function.
 */
export async function getMessagesForSessions(
  userId: string,
  sessionIds: string[],
  limit: number,
): Promise<Record<string, BatchMessage[]>> {
  if (sessionIds.length === 0) return {}
  const rows = await sql<(BatchMessage & { rn: number })[]>`
    WITH ranked AS (
      SELECT m.id, m.session_id, m.role, m.content, m.status, m.created_at,
             ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.created_at DESC) AS rn
      FROM messages m
      WHERE m.session_id = ANY(${sessionIds})
        AND m.session_id IN (
          SELECT id FROM sessions
          WHERE user_id = ${userId} AND deleted_at IS NULL
        )
    )
    SELECT id, session_id, role, content, status, created_at
    FROM ranked
    WHERE rn <= ${limit}
    ORDER BY session_id, created_at ASC
  `
  const grouped: Record<string, BatchMessage[]> = {}
  for (const r of rows) {
    const arr = grouped[r.session_id] ?? []
    arr.push({
      id: r.id,
      session_id: r.session_id,
      role: r.role,
      content: r.content,
      status: r.status,
      created_at: r.created_at,
    })
    grouped[r.session_id] = arr
  }
  return grouped
}

/**
 * GridPage — desktop multichat grid view (Phase 03 / PLAN-004).
 *
 * Mounted at `#/grid` and `#/grid/:tabId`. Top: tab bar. Body: CSS grid of
 * `<ChatSurface density="cell">` for the active tab's sessions.
 *
 * Data ownership:
 *  - Tab list fetched here via `chat-tabs-api.listTabs`.
 *  - Per-cell messages: ONE batch fetch (`batchMessages`) on tab activation,
 *    seeded into each `<ChatSurface>` (which then takes over via its WS sub).
 *  - WS subscription: each cell subscribes for its own sessionId via the
 *    self-owned data path on `<ChatSurface>` (see useChatSurface).
 *
 * Active cell:
 *  - Tracked in component state + `sessionStorage` (NOT URL — too noisy per
 *    Phase 03 CONTEXT.md).
 *  - Document-level paste/drop are scoped via `data-chat-surface-cell-id` so
 *    typing in cell A's input keeps paste routed to A, not the active cell.
 */
import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { useWebSocket } from '../hooks/useWebSocket'
import { ChatSurface } from './ChatSurface'
import {
  type TabWithSessions,
  type TabLayout,
  MAX_CELLS_PER_TAB,
  listTabs,
  createTab,
  patchTab,
  deleteTab,
  reorderTabs as reorderTabsApi,
  removeSessionFromTab,
  batchMessages,
} from '../lib/chat-tabs-api'
import { SessionPicker } from './SessionPicker'
import { MobileAccordion } from './MobileAccordion'
import type { ChatMessage } from '../hooks/useChat'
import type { CodeSession } from '../hooks/useSessions'

const ACTIVE_CELL_KEY = (tabId: string) => `grid:lastActiveCell:${tabId}`

interface Props {
  token: string
  tabId?: string
}

export function GridPage({ token, tabId: tabIdFromUrl }: Props) {
  const { connected, connectionId, send, subscribe } = useWebSocket(token)

  const [tabs, setTabs] = useState<TabWithSessions[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [activeTabId, setActiveTabId] = useState<string | undefined>(tabIdFromUrl)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [seedByTab, setSeedByTab] = useState<Record<string, Record<string, ChatMessage[]>>>({})
  const [activeCellId, setActiveCellIdState] = useState<string | null>(null)

  // Persist active cell per tab to sessionStorage (NOT URL).
  const setActiveCellId = useCallback((id: string | null) => {
    setActiveCellIdState(id)
    if (!activeTabId) return
    try {
      if (id) sessionStorage.setItem(ACTIVE_CELL_KEY(activeTabId), id)
      else sessionStorage.removeItem(ACTIVE_CELL_KEY(activeTabId))
    } catch {}
  }, [activeTabId])

  // Initial load
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listTabs(token)
      .then((list) => {
        if (cancelled) return
        setTabs(list)
        setLoading(false)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e?.message ?? 'Failed to load tabs')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [token])

  // Sync activeTabId ← URL. Replace (not push) to keep history clean.
  useEffect(() => {
    if (loading) return
    if (tabIdFromUrl && tabs.some(t => t.id === tabIdFromUrl)) {
      setActiveTabId(tabIdFromUrl)
      return
    }
    // No tab in URL: pick most-recent (last by updated_at) if any.
    if (tabs.length > 0) {
      const sorted = [...tabs].sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
      const newest = sorted[0]
      if (newest) {
        setActiveTabId(newest.id)
        window.location.replace(`#/grid/${newest.id}`)
      }
    } else {
      setActiveTabId(undefined)
    }
  }, [tabs, tabIdFromUrl, loading])

  // Active-cell-scoped paste/drop. ChatSurface already handles paste on its
  // textarea + drop on its root. The remaining case: focus is OUTSIDE all
  // cells (e.g. tab chip, page background) — route to the active cell by
  // synthesizing a paste/drop into its root.
  useEffect(() => {
    if (!activeCellId) return
    const handlePaste = (e: ClipboardEvent) => {
      const target = document.activeElement as HTMLElement | null
      // If focus is inside ANY cell (its own textarea), let the cell handle it.
      if (target?.closest?.('[data-chat-surface-cell-id]')) return
      // Only act if there are actual files (images) on the clipboard.
      const items = e.clipboardData?.items
      if (!items) return
      const hasFile = Array.from(items).some(it => it.kind === 'file')
      if (!hasFile) return
      const activeRoot = document.querySelector(`[data-chat-surface-cell-id="${activeCellId}"]`)
      if (!activeRoot) return
      // Bubble a synthetic paste into the active cell's textarea.
      const ta = activeRoot.querySelector('textarea') as HTMLTextAreaElement | null
      if (!ta) return
      e.preventDefault()
      ta.focus()
      // Manually dispatch a new ClipboardEvent on the textarea so its onPaste fires.
      try {
        const dt = new DataTransfer()
        for (const it of items) {
          if (it.kind === 'file') {
            const f = it.getAsFile()
            if (f) dt.items.add(f)
          }
        }
        const synthetic = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
        ta.dispatchEvent(synthetic)
      } catch {}
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [activeCellId])

  // Restore active cell for current tab from sessionStorage.
  useEffect(() => {
    if (!activeTabId) {
      setActiveCellIdState(null)
      return
    }
    try {
      const saved = sessionStorage.getItem(ACTIVE_CELL_KEY(activeTabId))
      setActiveCellIdState(saved)
    } catch {
      setActiveCellIdState(null)
    }
  }, [activeTabId])

  const activeTab = useMemo(
    () => tabs.find(t => t.id === activeTabId) ?? null,
    [tabs, activeTabId],
  )

  // Visible session ids (capped at 12 per Phase 03 lock).
  const visibleSessions = useMemo(() => {
    if (!activeTab) return []
    const sorted = [...activeTab.sessions].sort((a, b) => a.position - b.position)
    return sorted.slice(0, MAX_CELLS_PER_TAB)
  }, [activeTab])

  const overflowCount = (activeTab?.sessions.length ?? 0) - visibleSessions.length

  // Default active cell = first visible cell.
  useEffect(() => {
    if (!activeTab) return
    if (!activeCellId || !visibleSessions.some(s => s.session_id === activeCellId)) {
      const first = visibleSessions[0]?.session_id ?? null
      setActiveCellId(first)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, visibleSessions.length])

  // One batch fetch on tab activation. Seed all cells from a single round-trip.
  useEffect(() => {
    if (!activeTabId || visibleSessions.length === 0) return
    if (seedByTab[activeTabId]) return // already hydrated
    const ids = visibleSessions.map(s => s.session_id)
    let cancelled = false
    batchMessages(token, ids, 30)
      .then((grouped) => {
        if (cancelled) return
        setSeedByTab(prev => ({ ...prev, [activeTabId]: grouped }))
      })
      .catch(() => {
        if (cancelled) return
        // On failure each cell falls back to its own /api/messages/:id fetch.
        setSeedByTab(prev => ({ ...prev, [activeTabId]: {} }))
      })
    return () => { cancelled = true }
  }, [activeTabId, visibleSessions, token, seedByTab])

  // ── Tab CRUD ────────────────────────────────────────────────────────────────

  const onCreateTab = useCallback(async (name: string) => {
    const t = await createTab(token, { name })
    setTabs(prev => [...prev, { ...t, sessions: [] }])
    setActiveTabId(t.id)
    window.location.hash = `#/grid/${t.id}`
  }, [token])

  const onRenameTab = useCallback(async (id: string, name: string) => {
    const prevTabs = tabs
    setTabs(prev => prev.map(t => t.id === id ? { ...t, name } : t))
    try {
      await patchTab(token, id, { name })
    } catch (e) {
      setTabs(prevTabs)
      throw e
    }
  }, [token, tabs])

  const onDeleteTab = useCallback(async (id: string) => {
    if (!confirm(`Delete tab "${tabs.find(t => t.id === id)?.name ?? id}"?`)) return
    await deleteTab(token, id)
    setTabs(prev => prev.filter(t => t.id !== id))
    if (activeTabId === id) {
      const rest = tabs.filter(t => t.id !== id)
      const next = rest[0]?.id
      if (next) window.location.replace(`#/grid/${next}`)
      else window.location.replace('#/grid')
    }
  }, [token, tabs, activeTabId])

  const onReorderTab = useCallback(async (id: string, dir: -1 | 1) => {
    const sorted = [...tabs].sort((a, b) => a.position - b.position)
    const idx = sorted.findIndex(t => t.id === id)
    if (idx < 0) return
    const swapWith = idx + dir
    if (swapWith < 0 || swapWith >= sorted.length) return
    const reordered = [...sorted]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(swapWith, 0, moved)
    const orderedIds = reordered.map(t => t.id)
    // Optimistic
    setTabs(prev => {
      const map = new Map(prev.map(t => [t.id, t]))
      return orderedIds
        .map((tid, i) => {
          const t = map.get(tid)
          return t ? { ...t, position: i } : null
        })
        .filter((t): t is TabWithSessions => t != null)
    })
    try {
      await reorderTabsApi(token, orderedIds)
    } catch {
      // Refetch on failure.
      const fresh = await listTabs(token)
      setTabs(fresh)
    }
  }, [token, tabs])

  // Membership: refresh tabs after picker submit so positions are accurate.
  const onMembershipChange = useCallback(async () => {
    const fresh = await listTabs(token)
    setTabs(fresh)
    // Invalidate seed for the active tab so the next render re-hydrates.
    if (activeTabId) {
      setSeedByTab(prev => {
        const next = { ...prev }
        delete next[activeTabId]
        return next
      })
    }
  }, [token, activeTabId])

  const onRemoveFromTab = useCallback(async (sessionId: string) => {
    if (!activeTabId) return
    await removeSessionFromTab(token, activeTabId, sessionId)
    await onMembershipChange()
  }, [activeTabId, token, onMembershipChange])

  // ── Empty + loading ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--bg-primary)]">
        <div className="text-[var(--text-muted)] text-sm">Loading grid…</div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full bg-[var(--bg-primary)]">
        <div className="text-red-400 text-sm">{error}</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)] min-h-0">
      <GridTabBar
        tabs={tabs}
        activeTabId={activeTabId}
        onSelect={(id) => { window.location.hash = `#/grid/${id}` }}
        onCreate={onCreateTab}
        onRename={onRenameTab}
        onDelete={onDeleteTab}
        onReorder={onReorderTab}
        wsConnected={connected}
      />

      {tabs.length === 0 && (
        <EmptyState
          title="Create your first tab"
          body="Tabs let you watch multiple Claude Code sessions side-by-side. Click + above to create one."
        />
      )}

      {tabs.length > 0 && activeTab && visibleSessions.length === 0 && (
        <EmptyState
          title="This tab has no sessions yet"
          body="Add sessions from the picker below."
          action={
            <button
              onClick={() => setPickerOpen(true)}
              className="mt-3 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] text-sm font-medium transition-colors"
            >
              + Add sessions
            </button>
          }
        />
      )}

      {tabs.length > 0 && activeTab && visibleSessions.length > 0 && (
        <>
          {/* Desktop: tab toolbar + CSS grid */}
          <div
            id="grid-tab-panel"
            role="tabpanel"
            aria-labelledby={activeTabId}
            className="hidden md:flex flex-col flex-1 min-h-0"
          >
            <div className="px-4 pt-3 flex items-center gap-2 shrink-0">
              <button
                onClick={() => setPickerOpen(true)}
                className="px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-tertiary)]/50 text-[var(--text-secondary)] text-xs transition-colors"
              >
                + Add sessions
              </button>
              <LayoutPicker
                value={activeTab.layout}
                onChange={async (next) => {
                  if (next === activeTab.layout) return
                  const prevTabs = tabs
                  setTabs(prev => prev.map(t => t.id === activeTab.id ? { ...t, layout: next } : t))
                  try { await patchTab(token, activeTab.id, { layout: next }) }
                  catch { setTabs(prevTabs) }
                }}
              />
              {overflowCount > 0 && (
                <span className="text-[11px] text-amber-400" role="status">
                  {MAX_CELLS_PER_TAB}-cell cap reached — {overflowCount} more hidden
                </span>
              )}
            </div>
            <div
              role="grid"
              aria-label={`Session grid (${visibleSessions.length} of ${activeTab.sessions.length})`}
              className="flex-1 min-h-0 grid gap-3 p-4 auto-rows-fr"
              style={{
                gridTemplateColumns:
                  activeTab.layout === '3x3' ? 'repeat(3, 1fr)' :
                  activeTab.layout === '4x3' ? 'repeat(4, 1fr)' :
                  'repeat(auto-fit, minmax(320px, 1fr))',
              }}
            >
              {visibleSessions.map(s => (
                <GridCell
                  key={s.session_id}
                  sessionRef={s}
                  isActive={s.session_id === activeCellId}
                  onActivate={() => setActiveCellId(s.session_id)}
                  onRemove={() => onRemoveFromTab(s.session_id)}
                  subscribe={subscribe}
                  send={send}
                  connectionId={connectionId}
                  token={token}
                  wsConnected={connected}
                  seedMessages={seedByTab[activeTabId!]?.[s.session_id]}
                />
              ))}
            </div>
          </div>

          {/* Mobile: accordion (one ChatSurface mounted at a time). CSS-only swap. */}
          <div className="md:hidden flex-1 min-h-0">
            <MobileAccordion
              sessions={visibleSessions.map<CodeSession>(s => ({
                id: s.session_id,
                name: s.name,
                project_dir: s.project_dir,
                status: s.status,
                last_activity: null,
                created_at: '',
              }))}
              subscribe={subscribe}
              send={send}
              connectionId={connectionId}
              token={token}
              wsConnected={connected}
              tabId={activeTabId}
            />
          </div>
        </>
      )}

      {pickerOpen && activeTab && (
        <SessionPicker
          token={token}
          tab={activeTab}
          onClose={() => setPickerOpen(false)}
          onAdded={async () => { await onMembershipChange() }}
        />
      )}
    </div>
  )
}

// ── Tab bar ──────────────────────────────────────────────────────────────────

interface GridTabBarProps {
  tabs: TabWithSessions[]
  activeTabId?: string
  onSelect: (id: string) => void
  onCreate: (name: string) => Promise<void>
  onRename: (id: string, name: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
  onReorder: (id: string, dir: -1 | 1) => Promise<void>
  wsConnected: boolean
}

function GridTabBar({ tabs, activeTabId, onSelect, onCreate, onRename, onDelete, onReorder, wsConnected }: GridTabBarProps) {
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')

  const sorted = useMemo(
    () => [...tabs].sort((a, b) => a.position - b.position),
    [tabs],
  )

  const submitCreate = async () => {
    const trimmed = newName.trim()
    if (!trimmed) { setCreating(false); return }
    await onCreate(trimmed)
    setNewName('')
    setCreating(false)
  }

  const startRename = (id: string, current: string) => {
    setRenamingId(id)
    setRenameValue(current)
  }

  const commitRename = async () => {
    const id = renamingId
    if (!id) return
    const trimmed = renameValue.trim()
    if (trimmed) {
      try { await onRename(id, trimmed) } catch {}
    }
    setRenamingId(null)
  }

  const focusTabAt = (i: number) => {
    if (i < 0 || i >= sorted.length) return
    const id = sorted[i].id
    onSelect(id)
    // Move DOM focus to the chip so screen readers announce the new tab.
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-grid-tab-id="${id}"]`)
      el?.focus()
    })
  }

  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>, i: number) => {
    if (renamingId) return
    if (e.key === 'ArrowRight') { e.preventDefault(); focusTabAt(i + 1 < sorted.length ? i + 1 : 0) }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); focusTabAt(i - 1 >= 0 ? i - 1 : sorted.length - 1) }
    else if (e.key === 'Home') { e.preventDefault(); focusTabAt(0) }
    else if (e.key === 'End') { e.preventDefault(); focusTabAt(sorted.length - 1) }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(sorted[i].id) }
    else if (e.key === 'F2') { e.preventDefault(); startRename(sorted[i].id, sorted[i].name) }
  }

  return (
    <div
      role="tablist"
      aria-label="Grid tabs"
      className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border-color)]/60 bg-[var(--bg-secondary)]/40 backdrop-blur-sm shrink-0 overflow-x-auto"
    >
      <span className="text-xs text-[var(--text-muted)] mr-1 shrink-0" aria-live="polite">
        {wsConnected ? '● Live' : <span className="text-amber-400">○ Reconnecting</span>}
      </span>
      {sorted.map((t, i) => {
        const isActive = t.id === activeTabId
        const isRenaming = renamingId === t.id
        return (
          <div
            key={t.id}
            data-grid-tab-id={t.id}
            role="tab"
            aria-selected={isActive}
            aria-controls="grid-tab-panel"
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(e) => onTabKeyDown(e, i)}
            className={`group flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs shrink-0 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 ${
              isActive
                ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-[var(--text-primary)]'
                : 'bg-[var(--bg-secondary)]/60 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'
            }`}
            onClick={() => !isRenaming && onSelect(t.id)}
            onDoubleClick={(e) => { e.stopPropagation(); startRename(t.id, t.name) }}
            title="Double-click or F2 to rename"
          >
            {isRenaming ? (
              <input
                autoFocus
                value={renameValue}
                onChange={e => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); commitRename() }
                  if (e.key === 'Escape') { e.preventDefault(); setRenamingId(null) }
                }}
                onClick={e => e.stopPropagation()}
                className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded px-1.5 py-0.5 text-xs w-32 text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            ) : (
              <>
                <span className="font-medium">{t.name}</span>
                <span className="text-[10px] text-[var(--text-muted)]">{t.sessions.length}</span>
                <span className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 ml-1 transition-opacity">
                  <button
                    onClick={e => { e.stopPropagation(); onReorder(t.id, -1) }}
                    disabled={i === 0}
                    className="px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
                    title="Move left"
                  >‹</button>
                  <button
                    onClick={e => { e.stopPropagation(); onReorder(t.id, 1) }}
                    disabled={i === sorted.length - 1}
                    className="px-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] disabled:opacity-30"
                    title="Move right"
                  >›</button>
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(t.id) }}
                    className="px-1 text-red-400 hover:text-red-300"
                    title="Delete tab"
                  >×</button>
                </span>
              </>
            )}
          </div>
        )
      })}
      {creating ? (
        <input
          autoFocus
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onBlur={submitCreate}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); submitCreate() }
            if (e.key === 'Escape') { e.preventDefault(); setCreating(false); setNewName('') }
          }}
          placeholder="New tab name…"
          className="bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg px-3 py-1.5 text-xs w-40 text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      ) : (
        <button
          onClick={() => setCreating(true)}
          className="px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-tertiary)]/50 text-[var(--text-secondary)] text-xs shrink-0 transition-colors"
          title="Create new tab"
        >
          + New
        </button>
      )}
    </div>
  )
}

// ── Cell ─────────────────────────────────────────────────────────────────────

interface GridCellProps {
  sessionRef: { session_id: string; name: string; status: string; project_dir: string | null }
  isActive: boolean
  onActivate: () => void
  onRemove: () => void
  subscribe: (handler: (msg: any) => void) => () => void
  send: (msg: object) => void
  connectionId: number
  token: string
  wsConnected: boolean
  seedMessages?: ChatMessage[]
}

function GridCell({ sessionRef, isActive, onActivate, onRemove, subscribe, send, connectionId, token, wsConnected, seedMessages }: GridCellProps) {
  const isOnline = sessionRef.status === 'online' || sessionRef.status === 'thinking'
  return (
    <div
      role="gridcell"
      aria-label={`Session ${sessionRef.name}`}
      aria-selected={isActive}
      data-chat-surface-cell-id={sessionRef.session_id}
      className={`flex flex-col min-h-0 rounded-xl bg-[var(--bg-secondary)]/60 overflow-hidden transition-shadow ${
        isActive ? 'ring-1 ring-indigo-500/30' : ''
      }`}
      onMouseDown={onActivate}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border-color)] shrink-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          sessionRef.status === 'thinking' ? 'bg-amber-400 animate-pulse' :
          isOnline ? 'bg-emerald-400' :
          'bg-[var(--text-muted)]'
        }`} />
        <span className="text-xs font-medium text-[var(--text-primary)] truncate flex-1" title={sessionRef.project_dir ?? sessionRef.name}>
          {sessionRef.name}
        </span>
        {/* TODO: scheduled-task queue badge — wire up once useSessionQueueState ships (PLAN-004 T7). */}
        {/* TODO: ↗ open-in-single-chat — needs single-chat route to accept a sessionId param
            before re-enabling (was navigating to `#/` and losing context). */}
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${sessionRef.name} from tab`}
          className="text-[10px] text-red-400 hover:text-red-300 px-1"
          title="Remove from tab"
        >×</button>
      </div>
      <div className="flex-1 min-h-0">
        <ChatSurface
          density="cell"
          sessionId={sessionRef.session_id}
          subscribe={subscribe}
          send={send}
          connectionId={connectionId}
          token={token}
          wsConnected={wsConnected}
          seedMessages={seedMessages}
          onActivate={onActivate}
        />
      </div>
    </div>
  )
}

// ── Empty state ──────────────────────────────────────────────────────────────

// ── Layout-mode picker ───────────────────────────────────────────────────────

function LayoutPicker({ value, onChange }: { value: TabLayout; onChange: (next: TabLayout) => void | Promise<void> }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const label: Record<TabLayout, string> = { '3x3': '3 × 3', '4x3': '4 × 3', 'auto-fit': 'Auto-fit' }
  const options: TabLayout[] = ['3x3', '4x3', 'auto-fit']
  return (
    <div ref={ref} className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Grid layout: ${label[value]}`}
        className="px-3 py-1.5 rounded-lg bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-tertiary)]/50 text-[var(--text-secondary)] text-xs transition-colors flex items-center gap-1.5"
        title="Grid layout"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <rect x="2" y="2" width="4.5" height="4.5" rx="0.8" />
          <rect x="9.5" y="2" width="4.5" height="4.5" rx="0.8" />
          <rect x="2" y="9.5" width="4.5" height="4.5" rx="0.8" />
          <rect x="9.5" y="9.5" width="4.5" height="4.5" rx="0.8" />
        </svg>
        {label[value]}
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Grid layout options"
          className="absolute left-0 top-full mt-1 z-20 min-w-[120px] rounded-lg bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] shadow-xl py-1"
        >
          {options.map(opt => (
            <button
              key={opt}
              type="button"
              role="option"
              aria-selected={opt === value}
              onClick={() => { setOpen(false); onChange(opt) }}
              className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                opt === value
                  ? 'bg-indigo-600/20 text-[var(--text-primary)] ring-1 ring-indigo-500/30'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'
              }`}
            >
              {label[opt]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div className="rounded-xl bg-[var(--bg-secondary)]/60 p-8 max-w-md text-center">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">{title}</h3>
        <p className="text-xs text-[var(--text-muted)]">{body}</p>
        {action}
      </div>
    </div>
  )
}

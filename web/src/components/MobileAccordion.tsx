import { useState, useCallback } from 'react'
import { MobileAccordionRow } from './MobileAccordionRow'
import type { CodeSession } from '../hooks/useSessions'

interface Props {
  sessions: CodeSession[]
  // WS plumbing forwarded to ChatSurface (self-owned mode)
  subscribe: (handler: (msg: any) => void) => () => void
  send: (msg: object) => void
  connectionId: number
  token: string
  wsConnected: boolean
  /** Optional context-only; not used internally yet (reserved for analytics). */
  tabId?: string
  /** When true, rows render the raw-terminal TerminalSurface instead of ChatSurface. */
  ptyInteractive?: boolean
}

/**
 * <MobileAccordion>
 *
 * Vertical list of compact session rows; tapping a row expands an
 * inline square <ChatSurface density="mobile-expanded"> below it.
 *
 * Invariants:
 *  - Only ONE row may be expanded at a time. Opening row B atomically
 *    collapses row A (single state setter).
 *  - The ChatSurface inside a row is CONDITIONALLY RENDERED — when a
 *    row collapses, its ChatSurface unmounts (drops its WS subscription,
 *    frees the virtualized list). Confirms only one ChatSurface lives
 *    in the React tree on mobile.
 *  - Sizing uses `aspect-ratio: 1/1` + `max-height: 100dvh` (never
 *    `100vh`) — see <MobileAccordionRow>.
 *
 * Wiring: this component is the mobile branch of <GridPage>. The
 * parent (GridPage on viewports below `md:`) is responsible for
 * passing the right sessions list (one per tab session) and the
 * shared WebSocket tuple.
 */
export function MobileAccordion({
  sessions,
  subscribe,
  send,
  connectionId,
  token,
  wsConnected,
  ptyInteractive = false,
}: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const handleToggle = useCallback((id: string) => {
    setExpandedId(prev => (prev === id ? null : id))
  }, [])

  if (sessions.length === 0) {
    return (
      <div className="h-full flex items-center justify-center px-6 text-center">
        <div className="text-sm text-[var(--text-muted)]">
          No sessions yet. Connect a repo to get started.
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-[var(--bg-primary)] p-2 space-y-1">
      {sessions.map(s => (
        <MobileAccordionRow
          key={s.id}
          session={s}
          expanded={expandedId === s.id}
          onToggle={() => handleToggle(s.id)}
          subscribe={subscribe}
          send={send}
          connectionId={connectionId}
          token={token}
          wsConnected={wsConnected}
          ptyInteractive={ptyInteractive}
        />
      ))}
    </div>
  )
}

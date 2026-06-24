import { useEffect, useRef } from 'react'
import { ChatSurface } from './ChatSurface'
import { TerminalSurface } from './TerminalSurface'
import type { CodeSession } from '../hooks/useSessions'
import { sessionLabel, shortId } from './SessionDropdown'

interface Props {
  session: CodeSession
  expanded: boolean
  onToggle: () => void
  // WS plumbing forwarded to ChatSurface (self-owned data mode)
  subscribe: (handler: (msg: any) => void) => () => void
  send: (msg: object) => void
  connectionId: number
  token: string
  wsConnected: boolean
  /** When true, render the raw-terminal TerminalSurface instead of ChatSurface. */
  ptyInteractive?: boolean
}

/**
 * <MobileAccordionRow>
 *
 * Compact session row that expands inline to host a square <ChatSurface
 * density="mobile-expanded"> panel. The ChatSurface is CONDITIONALLY
 * RENDERED — when `expanded` flips to false, the surface unmounts (drops
 * its WS subscription, frees virtualized list, etc.). Only one row in a
 * <MobileAccordion> is expanded at a time, so only one ChatSurface lives
 * in the React tree on mobile.
 *
 * Sizing: the expanded panel uses `aspect-ratio: 1 / 1` with `max-height:
 * 100dvh` (dynamic viewport — survives iOS keyboard open without
 * collapsing). Never `100vh`. The whole row uses a CSS `max-height`
 * transition (no JS measurement) for the expand/collapse animation.
 */
export function MobileAccordionRow({
  session,
  expanded,
  onToggle,
  subscribe,
  send,
  connectionId,
  token,
  wsConnected,
  ptyInteractive = false,
}: Props) {
  const rootRef = useRef<HTMLDivElement | null>(null)

  // When the row expands, scroll its header into view so the input field
  // below (and the iOS soft keyboard) doesn't push it off-screen. The
  // CSS max-height transition is 200ms; wait one frame so the new height
  // is measured before scrolling.
  useEffect(() => {
    if (!expanded) return
    const el = rootRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      } catch {
        el.scrollIntoView()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [expanded])

  const statusDotClass =
    session.status === 'thinking'
      ? 'bg-amber-400 animate-pulse'
      : session.status === 'online'
      ? 'bg-emerald-400'
      : 'bg-[var(--text-muted)]'

  return (
    <div
      ref={rootRef}
      className="rounded-lg overflow-hidden transition-[max-height] duration-200 ease-out scroll-mt-2"
      style={{
        // Collapsed: just the row (~44px button + padding). Expanded:
        // row + square panel + safe-area inset, capped at viewport height
        // so wide-mobile/landscape doesn't overflow. `dvh` (dynamic viewport
        // height) survives iOS soft-keyboard open; `vh` is the legacy
        // fallback for any browser without dvh. Inner `aspect-ratio: 1/1`
        // still controls the real square sizing — this is just an upper bound.
        maxHeight: expanded
          ? 'min(calc(100dvh - 16px), calc(100vw + 88px))'
          : '52px',
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={`mobile-row-panel-${session.id}`}
        className={`w-full text-left px-3 py-2.5 rounded-lg text-sm transition-colors ${
          expanded
            ? 'bg-blue-600/20 text-[var(--text-primary)] ring-1 ring-blue-500/30'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 active:bg-[var(--bg-tertiary)]/70'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusDotClass}`} />
          <span className="truncate font-medium flex-1">{sessionLabel(session)}</span>
          <span className="text-[10px] text-[var(--text-muted)] font-mono shrink-0">
            {shortId(session)}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`shrink-0 transition-transform duration-200 ${
              expanded ? 'rotate-180' : ''
            }`}
            aria-hidden="true"
          >
            <path d="M4 6l4 4 4-4" />
          </svg>
        </div>
      </button>

      {expanded && (
        <div
          id={`mobile-row-panel-${session.id}`}
          className="mt-2 rounded-xl bg-[var(--bg-secondary)]/60 overflow-hidden"
          style={{
            // dvh first, svh fallback via @supports — both are widely
            // supported in current iOS/Android browsers and survive the
            // soft-keyboard open without collapsing the layout.
            paddingBottom: 'env(safe-area-inset-bottom)',
          }}
        >
          {ptyInteractive ? (
            // PTY-interactive: raw-terminal surface. aspect-square gives the
            // terminal a bounded box so xterm's own scrollback scrolls inside
            // the cell (toolbar stays sticky on top) rather than scrolling the
            // whole page.
            <div className="aspect-square w-full overflow-hidden">
              <TerminalSurface
                sessionId={session.id}
                subscribe={subscribe}
                send={send}
                className="h-full p-1"
              />
            </div>
          ) : (
            <ChatSurface
              density="mobile-expanded"
              sessionId={session.id}
              subscribe={subscribe}
              send={send}
              connectionId={connectionId}
              token={token}
              wsConnected={wsConnected}
            />
          )}
        </div>
      )}
    </div>
  )
}

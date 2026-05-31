/**
 * SessionActionButton — the ONE standard square action button for play / stop /
 * disconnect used across every session-list surface (sidebar, grid, settings
 * Connections table, pickers).
 *
 * Design-prefs compliance:
 *  - Square icon button, small Lucide-style glyph (14–18px) in padding so the
 *    clickable area is ≥ 44 × 44px (min-w/min-h-[44px]) per WCAG 2.5.5.
 *  - Blue app accent (the only cool accent allowed); red for stop/disconnect.
 *  - Tooltip via `title=` + accessible `aria-label`.
 *  - Disabled + loading (spinner) states; loading spin honours
 *    `prefers-reduced-motion` (motion-reduce:animate-none).
 *  - Focus ring: `ring-2 ring-blue-500`.
 *
 * Sizing aligns with ChatSurface's `btnSquare` convention; `size="sm"` keeps a
 * 28px visual square inside a 44px hit area for dense rows.
 */
import type { ReactNode } from 'react'

export type SessionActionKind = 'play' | 'stop' | 'disconnect'

interface Props {
  kind: SessionActionKind
  onClick: () => void
  disabled?: boolean
  loading?: boolean
  /** Override the default tooltip/aria label for the kind. */
  label?: string
  /** 'sm' (dense rows, ~28px glyph box) | 'md' (~36px). Hit area stays ≥44px. */
  size?: 'sm' | 'md'
  className?: string
}

const GLYPH = 16

function PlayIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path d="M6 4l10 6-10 6V4z" />
    </svg>
  )
}
function StopIcon() {
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <rect x="5" y="5" width="10" height="10" rx="1" />
    </svg>
  )
}
function DisconnectIcon() {
  // Lucide "unplug" — a disconnected plug.
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m19 5 3-3" />
      <path d="m2 22 3-3" />
      <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
      <path d="M7.5 13.5 10 11" />
      <path d="M10.5 16.5 13 14" />
      <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
    </svg>
  )
}

function Spinner() {
  return (
    <svg width={GLYPH} height={GLYPH} viewBox="0 0 24 24" fill="none" className="animate-spin motion-reduce:animate-none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

const KIND_DEFAULTS: Record<SessionActionKind, { label: string; icon: ReactNode; tone: 'accent' | 'danger' }> = {
  play: { label: 'Start session', icon: <PlayIcon />, tone: 'accent' },
  stop: { label: 'Stop session', icon: <StopIcon />, tone: 'danger' },
  disconnect: { label: 'Disconnect session', icon: <DisconnectIcon />, tone: 'danger' },
}

export function SessionActionButton({ kind, onClick, disabled, loading, label, size = 'sm', className = '' }: Props) {
  const def = KIND_DEFAULTS[kind]
  const text = label ?? def.label
  const box = size === 'md' ? 'w-9 h-9' : 'w-7 h-7'
  const toneCls = def.tone === 'danger'
    ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10'
    : 'text-blue-400 hover:text-blue-300 hover:bg-blue-500/10'
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (!disabled && !loading) onClick() }}
      disabled={disabled || loading}
      title={text}
      aria-label={text}
      aria-busy={loading || undefined}
      className={`inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${toneCls} ${className}`}
    >
      <span className={`inline-flex items-center justify-center ${box}`}>
        {loading ? <Spinner /> : def.icon}
      </span>
    </button>
  )
}

export default SessionActionButton

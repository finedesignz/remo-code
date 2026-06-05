/**
 * Collapsible group-section header — shared by the Connections table and the
 * sessions sidebar. Renders the chevron (keyboard-toggleable, aria-expanded),
 * group name, and a member-count badge. Children (the rows) render only when
 * expanded. Accent = blue per design-preferences.
 */
import type { ReactNode } from 'react'

export function GroupSection({
  id,
  name,
  count,
  collapsed,
  onToggle,
  isUngrouped = false,
  dense = false,
  children,
}: {
  id: string
  name: string
  count: number
  collapsed: boolean
  onToggle: (id: string) => void
  isUngrouped?: boolean
  /** Tighter paddings for the sidebar. */
  dense?: boolean
  children: ReactNode
}) {
  const pad = dense ? 'px-2 py-1.5' : 'px-3 py-2'
  return (
    <div className="repo-group-section">
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name} group`}
        className={`w-full flex items-center gap-2 ${pad} text-left text-[11px] uppercase tracking-wider font-medium text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/30 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50 rounded-md`}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`shrink-0 transition-transform ${collapsed ? '' : 'rotate-90'}`}
          aria-hidden="true"
        >
          <path d="M7 5l6 5-6 5" />
        </svg>
        <span className={`truncate ${isUngrouped ? 'italic' : ''}`}>{name}</span>
        <span className="ml-1 shrink-0 rounded-full bg-blue-600/15 ring-1 ring-blue-500/25 text-blue-300 px-1.5 py-0.5 text-[10px] tabular-nums normal-case tracking-normal">
          {count}
        </span>
      </button>
      {!collapsed && <div>{children}</div>}
    </div>
  )
}

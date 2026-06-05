/**
 * Per-row groups affordance for a Connections repo row: soft-tinted chips for
 * the group(s) the repo is in, plus a "+" that opens a multi-select checkbox
 * dropdown of all groups (checked = member). Toggling calls add/remove member.
 *
 * Design prefs: multi-select → checkboxes; chips rounded-full soft-tinted with a
 * deterministic per-name hue; accent = blue; icon-only "+" with title tooltip.
 * Disabled (with tooltip) when the repo has no identity (cannot be grouped).
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RepoGroup } from '../../lib/repo-groups'

// Deterministic hue from the group name (matches the avatar-tint rule).
function hueOf(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

function Chip({ name }: { name: string }) {
  const hue = hueOf(name)
  return (
    <span
      className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 max-w-[120px] truncate"
      style={{
        backgroundColor: `hsl(${hue} 70% 50% / 0.15)`,
        color: `hsl(${hue} 70% 75%)`,
        borderColor: `hsl(${hue} 70% 50% / 0.35)`,
      }}
      title={name}
    >
      {name}
    </span>
  )
}

export function RepoGroupChips({
  repoIdent,
  groups,
  memberGroupIds,
  onToggleMembership,
}: {
  repoIdent: string | null
  groups: RepoGroup[]
  memberGroupIds: string[]
  onToggleMembership: (groupId: string, repoIdent: string, member: boolean) => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const memberSet = new Set(memberGroupIds)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('[data-repo-group-menu]')) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  const openMenu = () => {
    const r = btnRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.bottom + 4, left: Math.max(8, r.right - 220) })
    setOpen(true)
  }

  const disabled = !repoIdent || groups.length === 0
  const memberChips = groups.filter((g) => memberSet.has(g.id))

  return (
    <span className="flex items-center gap-1 min-w-0" data-repo-group-menu>
      {memberChips.map((g) => (
        <Chip key={g.id} name={g.name} />
      ))}
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          if (!disabled) openMenu()
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          !repoIdent
            ? 'This repo has no identity and cannot be grouped'
            : groups.length === 0
              ? 'No groups yet — create one from "Groups"'
              : 'Add to group'
        }
        aria-label="Edit groups for this repo"
        className="inline-flex items-center justify-center w-6 h-6 min-w-[24px] rounded-md text-[var(--text-muted)] hover:text-blue-300 hover:bg-blue-500/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-1 focus-visible:ring-blue-500/50"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="3" y1="8" x2="13" y2="8" />
        </svg>
      </button>

      {open && pos && repoIdent &&
        createPortal(
          <div
            data-repo-group-menu
            role="menu"
            style={{ position: 'fixed', top: pos.top, left: pos.left, zIndex: 70, minWidth: 200, maxWidth: 260 }}
            className="bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-lg shadow-xl p-2 max-h-[50vh] overflow-y-auto"
          >
            <div className="px-1.5 pb-1.5 text-[10px] uppercase tracking-wider text-[var(--text-muted)]">In groups</div>
            {groups.map((g) => {
              const checked = memberSet.has(g.id)
              return (
                <label
                  key={g.id}
                  className="flex items-center gap-2 px-1.5 py-1.5 rounded-md text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => { e.stopPropagation(); void onToggleMembership(g.id, repoIdent, e.target.checked) }}
                    className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
                  />
                  <span className="truncate">{g.name}</span>
                </label>
              )
            })}
          </div>,
          document.body,
        )}
    </span>
  )
}

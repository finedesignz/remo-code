/**
 * MobileSessionControls — per-session controls for the ACTIVE session, shown in
 * the mobile chat session strip (< md only). Replaces the old "Manage sessions"
 * 3-dot that opened the full desktop `Sidebar` as a slide-over (garbled on
 * phones). NO sidebar on mobile: the session row's actions live here directly.
 *
 *  - Stop / interrupt the running turn (wired to `onCancel` → WS `cancel`),
 *    enabled only while the agent is busy (status === 'thinking') — mirrors the
 *    desktop ESC-interrupt Stop.
 *  - Kebab popover with the remaining session-row actions the desktop sidebar
 *    exposes: Disconnect (frees slot, resumes with history), Delete (two-step
 *    confirm), Auto-nudge toggle, Skip-approval-prompts toggle.
 *
 * Touch-friendly: every control has a ≥44px hit area; blue app accent.
 */
import { useState, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { CodeSession } from '../hooks/useSessions'
import { githubOwnerRepo } from '../hooks/useSessions'
import { sessionLabel, shortId } from './SessionDropdown'
import { SessionActionButton } from './SessionActionButton'
import { Toggle } from './ui/Toggle'

interface Props {
  session: CodeSession
  /** Interrupt the running turn (WS `cancel`) — NOT a teardown. */
  onCancel: () => void
  onDeleteSession: (id: string) => Promise<void>
  onDisconnectSession?: (id: string) => Promise<{ ok: boolean; error?: string }>
  globalNudgeDefault?: boolean
  onSetAutoNudge?: (id: string, value: boolean | null) => Promise<{ ok: boolean; error?: string }>
  onSetSkipPermissions?: (id: string, enabled: boolean) => Promise<{ ok: boolean; error?: string }>
}

export function MobileSessionControls({
  session: s,
  onCancel,
  onDeleteSession,
  onDisconnectSession,
  globalNudgeDefault = true,
  onSetAutoNudge,
  onSetSkipPermissions,
}: Props) {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)

  const label = githubOwnerRepo(s) ?? sessionLabel(s)
  const busy = s.status === 'thinking'

  const openMenu = () => {
    const el = btnRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setAnchor({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
    setConfirmingDelete(false)
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onDown = (e: Event) => {
      const t = e.target as HTMLElement | null
      if (t && t.closest('[data-mobile-session-menu]')) return
      setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  return (
    <span className="md:hidden flex items-center gap-0.5 shrink-0">
      {/* Stop / interrupt the running turn — enabled only while busy. */}
      <SessionActionButton
        kind="stop"
        onClick={onCancel}
        disabled={!busy}
        label={busy ? `Stop ${label} — interrupt the running turn` : 'Stop (nothing running)'}
      />
      {/* Kebab — opens the per-session action popover. */}
      <button
        ref={btnRef}
        type="button"
        data-mobile-session-menu
        onClick={() => (open ? setOpen(false) : openMenu())}
        className="inline-flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        title={`Session controls for ${label}`}
        aria-label={`Session controls for ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <circle cx="10" cy="4" r="1.5" />
          <circle cx="10" cy="10" r="1.5" />
          <circle cx="10" cy="16" r="1.5" />
        </svg>
      </button>

      {open && anchor && createPortal(
        <div
          data-mobile-session-menu
          role="dialog"
          aria-label={`Session controls for ${label}`}
          style={{ position: 'fixed', top: anchor.top, right: anchor.right, zIndex: 70, minWidth: 232 }}
          className="bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-xl shadow-xl p-3 space-y-2.5"
        >
          <div className="text-[11px] text-[var(--text-muted)]">
            <div className="font-medium text-[var(--text-secondary)] truncate" title={label}>{label}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span>Session</span>
              <span className="font-mono text-[var(--text-primary)]">{shortId(s)}</span>
            </div>
          </div>

          {onSetAutoNudge && (
            <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]">
              <span>Auto-nudge when idle</span>
              <Toggle
                checked={s.auto_nudge ?? globalNudgeDefault}
                onChange={(next) => { void onSetAutoNudge(s.id, next) }}
                aria-label={`Auto-nudge when idle for ${label}`}
              />
            </label>
          )}
          {onSetSkipPermissions && (
            <label className="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]">
              <span>Skip approval prompts</span>
              <Toggle
                checked={s.dangerously_skip_permissions === true}
                onChange={(next) => { void onSetSkipPermissions(s.id, next) }}
                aria-label={`Skip approval prompts for ${label}`}
              />
            </label>
          )}

          <div className="pt-1 border-t border-[var(--border-color)]/40 space-y-1">
            {onDisconnectSession && (
              <button
                type="button"
                onClick={() => { setOpen(false); void onDisconnectSession(s.id) }}
                className="w-full flex items-center gap-2 min-h-[44px] px-2 rounded-lg text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m19 5 3-3" /><path d="m2 22 3-3" />
                  <path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z" />
                  <path d="M7.5 13.5 10 11" /><path d="M10.5 16.5 13 14" />
                  <path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z" />
                </svg>
                Disconnect session
              </button>
            )}
            {confirmingDelete ? (
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => { setOpen(false); void onDeleteSession(s.id) }}
                  className="flex-1 min-h-[44px] px-2 rounded-lg text-[13px] font-medium text-white bg-red-600 hover:bg-red-500 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
                >
                  Confirm delete
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(false)}
                  className="min-h-[44px] px-3 rounded-lg text-[13px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="w-full flex items-center gap-2 min-h-[44px] px-2 rounded-lg text-[13px] text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
              >
                <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 5h14" /><path d="M7 5V3.5h6V5" />
                  <path d="M5.5 5l.7 10a1 1 0 0 0 1 .9h5.6a1 1 0 0 0 1-.9l.7-10" />
                </svg>
                Delete session
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </span>
  )
}

export default MobileSessionControls

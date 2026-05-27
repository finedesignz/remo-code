import { useState } from 'react'
import type { CodeSession } from '../hooks/useSessions'

interface Props {
  session: CodeSession
  /** Hook helper from useSessions — call to POST /api/sessions/:id/launch. */
  launchSession: (id: string) => Promise<{ ok: boolean; error?: string; detail?: string }>
  /**
   * Called with a transient toast string when the launch attempt produces a
   * user-visible result (success or recoverable failure). The host can render
   * this however it likes; if omitted, errors are silently swallowed.
   */
  onToast?: (msg: string) => void
}

/**
 * Small "Launch" button that asks the hub to start the supervisor-side runner
 * for an offline GitHub-keyed session. Visibility is the caller's concern —
 * Sidebar should only mount this when `session.status === 'offline'` and the
 * session has a known `project_dir` (the launch endpoint also resolves the
 * canonical local_path from inventory, so a missing `project_dir` is not a
 * hard block, but the UX is cleanest when both are present).
 *
 * On success the session transitions to `online` via the existing
 * `session_status` WS broadcast — no local state needed beyond the in-flight
 * spinner.
 */
export function LaunchButton({ session, launchSession, onToast }: Props) {
  const [busy, setBusy] = useState(false)

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const res = await launchSession(session.id)
      if (!res.ok) {
        switch (res.error) {
          case 'supervisor_offline':
            onToast?.('Supervisor is offline')
            break
          case 'local_path_missing':
            onToast?.('Repo is not on this machine — use Clone here.')
            break
          case 'already_online':
            onToast?.('Session is already online.')
            break
          default:
            onToast?.(`Launch failed: ${res.error ?? 'unknown'}`)
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="px-2 py-1 text-[11px] font-medium rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 disabled:cursor-not-allowed text-white transition-colors inline-flex items-center gap-1"
      title="Launch this session on the supervisor"
      aria-label={`Launch ${session.name}`}
    >
      {busy ? (
        <>
          <Spinner />
          <span>Launching</span>
        </>
      ) : (
        <>
          <PlayIcon />
          <span>Launch</span>
        </>
      )}
    </button>
  )
}

function Spinner() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" className="animate-spin" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M8 1.5a6.5 6.5 0 1 1-6.5 6.5" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M3.5 2.5v11l10-5.5z" />
    </svg>
  )
}

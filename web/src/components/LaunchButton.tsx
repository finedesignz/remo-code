import { useMemo, useState } from 'react'
import type { CodeSession } from '../hooks/useSessions'

interface Props {
  session: CodeSession
  /**
   * Hook helper from useSessions — call to POST /api/sessions/:id/launch.
   * Phase 08.6: optional `local_path` lets the caller pin a specific worktree.
   */
  launchSession: (
    id: string,
    body?: { cli_kind?: 'claude' | 'codex'; local_path?: string },
  ) => Promise<{ ok: boolean; error?: string; detail?: string }>
  /**
   * Called with a transient toast string when the launch attempt produces a
   * user-visible result (success or recoverable failure). The host can render
   * this however it likes; if omitted, errors are silently swallowed.
   */
  onToast?: (msg: string) => void
}

/**
 * Small "Launch" affordance for offline GitHub-keyed sessions.
 *
 * Phase 08.6: when the supervisor reports more than one local working tree for
 * the session's `repo_key`, we render a `<select>` next to the button so the
 * user picks WHICH worktree/branch to launch. With 0 or 1 known paths we fall
 * back to the simpler single-button shape.
 */
export function LaunchButton({ session, launchSession, onToast }: Props) {
  const [busy, setBusy] = useState(false)
  const paths = session.local_paths ?? []
  // Default: canonical (sorted first by the hub), else first entry.
  const defaultPath = paths[0]?.local_path ?? null
  const [picked, setPicked] = useState<string | null>(defaultPath)

  const visibleSelect = paths.length > 1
  const target = useMemo(() => paths.find((p) => p.local_path === picked) ?? null, [paths, picked])

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (busy) return
    setBusy(true)
    try {
      const res = await launchSession(session.id, picked ? { local_path: picked } : {})
      if (!res.ok) {
        switch (res.error) {
          case 'supervisor_offline':
            onToast?.('Supervisor is offline')
            break
          case 'local_path_missing':
            onToast?.('Repo is not on this machine — use Clone here.')
            break
          case 'invalid_local_path':
            onToast?.('That worktree is no longer in the supervisor inventory.')
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
    <div className="inline-flex items-center gap-1.5">
      {visibleSelect && (
        <select
          value={picked ?? ''}
          onChange={(e) => { e.stopPropagation(); setPicked(e.target.value) }}
          onClick={(e) => e.stopPropagation()}
          disabled={busy}
          className="px-1.5 py-1 text-[11px] rounded bg-[var(--bg-tertiary)]/80 text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/40 max-w-[180px]"
          title="Pick a worktree / branch to launch"
          aria-label="Worktree to launch"
        >
          {paths.map((p) => (
            <option key={p.local_path} value={p.local_path}>
              {labelFor(p)}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={handleClick}
        disabled={busy}
        className="px-2 py-1 text-[11px] font-medium rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 disabled:cursor-not-allowed text-white transition-colors inline-flex items-center gap-1"
        title={target ? `Launch ${target.local_path}` : 'Launch this session on the supervisor'}
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
    </div>
  )
}

function labelFor(p: { local_path: string; branch: string | null; is_worktree: boolean }): string {
  const base = p.local_path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p.local_path
  const branch = p.branch ? ` · ${p.branch}` : ''
  const tag = p.is_worktree ? ' [worktree]' : ''
  return `${base}${branch}${tag}`
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

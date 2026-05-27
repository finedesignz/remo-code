import { useState } from 'react'
import { usePendingLocalRepos, type PendingLocalRepo } from '../hooks/usePendingLocalRepos'
import { CreateGithubRepoModal } from './CreateGithubRepoModal'
import { useSessions } from '../hooks/useSessions'

interface Props {
  token: string | null
  /**
   * Resolve a sessionId for a given (hostname, project_dir). Required for the
   * "Create on GitHub" action — the hub keys create-github-repo on a session
   * id. When null/unavailable, the Create button is rendered disabled with a
   * tooltip.
   */
  resolveSessionId?: (hostname: string, project_dir: string) => string | null
  /**
   * Hub WS subscribe — forwarded to CreateGithubRepoModal so it can render a
   * progress bar driven by `repo_create_progress` events. When omitted the
   * modal falls back to a "Creating…" indeterminate state.
   */
  subscribe?: (handler: (msg: any) => void) => () => void
  /** Called after a create job finishes successfully (so caller can refetch). */
  onCreated?: () => void
}

/**
 * Sidebar banner listing folders the user has been seen running Claude/Codex
 * against that are NOT on GitHub yet (or not even a git repo) and have not
 * been dismissed. Each row offers two actions:
 *   - Create   → POST /api/sessions/:id/create-github-repo
 *   - Dismiss  → POST /api/sessions/dismiss-local
 *
 * Hidden entirely when there's nothing pending.
 */
export function PendingLocalRepoPrompt({ token, resolveSessionId, subscribe, onCreated }: Props) {
  const { pending, dismiss, refetch } = usePendingLocalRepos(token)
  // Reuse the launch-flow hook for `createGithubRepo` so the modal sees the
  // same wire surface across entry points (Sidebar prompt + future "Create"
  // CTAs on the session detail view).
  const { createGithubRepo } = useSessions(token)
  const [expanded, setExpanded] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [errorFor, setErrorFor] = useState<{ key: string; msg: string; scopeMissing: boolean } | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [modalFor, setModalFor] = useState<{ sessionId: string; defaultName: string } | null>(null)

  if (pending.length === 0) return null

  const rowKey = (p: PendingLocalRepo) => `${p.hostname}::${p.project_dir}`

  const handleCreate = (p: PendingLocalRepo) => {
    const sessionId = resolveSessionId?.(p.hostname, p.project_dir) ?? null
    const k = rowKey(p)
    if (!sessionId) {
      setErrorFor({
        key: k,
        msg: 'No session yet — open this folder in Remo Code first.',
        scopeMissing: false,
      })
      return
    }
    setErrorFor(null)
    const basename = p.project_dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'repo'
    setModalFor({ sessionId, defaultName: basename })
  }

  const handleDismiss = async (p: PendingLocalRepo) => {
    const k = rowKey(p)
    setBusy(k)
    await dismiss(p.hostname, p.project_dir)
    setBusy(null)
  }

  return (
    <div className="mx-2 mt-2 mb-1 rounded-lg bg-amber-500/5 ring-1 ring-amber-500/20">
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-medium text-amber-200/90 hover:text-amber-100 transition-colors"
        aria-expanded={expanded}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 1.5l6.5 11.5h-13z" />
          <line x1="8" y1="6" x2="8" y2="9.5" />
          <circle cx="8" cy="11.5" r="0.4" fill="currentColor" />
        </svg>
        <span className="flex-1">
          {pending.length} folder{pending.length !== 1 ? 's' : ''} not on GitHub yet
        </span>
        <svg
          width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
          className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <polyline points="4,6 8,10 12,6" />
        </svg>
      </button>

      {expanded && (
        <ul className="pb-2 px-1.5 space-y-1">
          {pending.map(p => {
            const k = rowKey(p)
            const basename = p.project_dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p.project_dir
            const isBusy = busy === k
            const err = errorFor && errorFor.key === k ? errorFor : null
            return (
              <li key={k} className="rounded-lg px-2.5 py-2 bg-[var(--bg-secondary)]/60 hover:bg-[var(--bg-tertiary)]/40 transition-colors">
                <div className="flex items-center gap-2">
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-[var(--text-muted)] shrink-0">
                    <path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
                  </svg>
                  <span className="text-sm text-[var(--text-primary)] truncate flex-1" title={p.project_dir}>
                    {basename}
                  </span>
                  <span className="text-[10px] text-[var(--text-muted)] shrink-0">{p.hostname}</span>
                </div>
                <div className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate pl-5" title={p.project_dir}>
                  {p.project_dir}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 pl-5">
                  <button
                    onClick={() => handleCreate(p)}
                    disabled={isBusy || (err?.scopeMissing ?? false)}
                    className="px-2 py-1 text-[11px] font-medium rounded bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-600/40 disabled:cursor-not-allowed text-white transition-colors"
                    title={err?.scopeMissing ? err.msg : 'Create this folder on GitHub'}
                  >
                    {isBusy ? 'Creating…' : 'Create'}
                  </button>
                  <button
                    onClick={() => handleDismiss(p)}
                    disabled={isBusy}
                    className="px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60 rounded transition-colors disabled:opacity-50"
                  >
                    Dismiss
                  </button>
                </div>
                {err && (
                  <p className={`text-[11px] mt-1 pl-5 ${err.scopeMissing ? 'text-amber-300' : 'text-red-300'}`}>
                    {err.msg}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {toast && (
        <div className="px-3 py-1.5 text-[11px] text-emerald-300 border-t border-amber-500/10">
          {toast}
        </div>
      )}
      {modalFor && token && (
        <CreateGithubRepoModal
          token={token}
          sessionId={modalFor.sessionId}
          defaultName={modalFor.defaultName}
          createGithubRepo={createGithubRepo}
          subscribe={subscribe ?? (() => () => {})}
          onClose={() => setModalFor(null)}
          onCompleted={() => {
            setToast(`Created ${modalFor.defaultName} on GitHub`)
            window.setTimeout(() => setToast(null), 4000)
            refetch()
            onCreated?.()
          }}
        />
      )}
    </div>
  )
}

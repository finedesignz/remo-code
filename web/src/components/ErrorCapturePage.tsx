import { useState } from 'react'
import { useErrorProjects, type ErrorProject, type ErrorProjectCreateInput } from '../hooks/useErrorProjects'
import { useSessions } from '../hooks/useSessions'
import { ErrorProjectEditor } from './ErrorProjectEditor'
import { ErrorDetailDrawer } from './ErrorDetailDrawer'

interface Props {
  token: string
  onBack?: () => void
  /** Subscribe to WS for live error updates inside drawer. Optional. */
  subscribe?: (handler: (msg: any) => void) => () => void
}

function formatTs(iso: string | null | undefined): string {
  if (!iso) return '—'
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

export function ErrorCapturePage({ token, onBack, subscribe }: Props) {
  const { projects, loading, error, create, update, remove, toggle } = useErrorProjects(token)
  const { sessions } = useSessions(token)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<ErrorProject | null>(null)
  const [drawerProject, setDrawerProject] = useState<ErrorProject | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  const handleNew = () => { setEditing(null); setEditorOpen(true) }
  const handleEdit = (p: ErrorProject) => { setEditing(p); setEditorOpen(true) }
  const handleClose = () => { setEditorOpen(false); setEditing(null) }

  const handleSave = async (data: ErrorProjectCreateInput, id?: string): Promise<ErrorProject> => {
    if (id) return update(id, data)
    return create(data)
  }

  const handleDelete = async (id: string) => {
    try { await remove(id) } catch {}
    setConfirmingDelete(null)
  }

  const copyDsn = async (p: ErrorProject) => {
    try {
      await navigator.clipboard.writeText(p.dsn)
      setCopiedId(p.id)
      setTimeout(() => setCopiedId(c => c === p.id ? null : c), 1200)
    } catch {}
  }

  const sessionName = (id: string): string => {
    const s = sessions.find(x => x.id === id)
    if (!s) return id
    return s.name || s.id
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
        {onBack && (
          <button
            onClick={onBack}
            className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
            aria-label="Back"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4l-6 6 6 6" />
            </svg>
          </button>
        )}
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] flex-1">Error Capture</h2>
        <button
          onClick={handleNew}
          className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors inline-flex items-center gap-1.5"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="8" y1="3" x2="8" y2="13" /><line x1="3" y1="8" x2="13" y2="8" />
          </svg>
          New project
        </button>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-4 md:px-6 py-6 space-y-4">
          {error && (
            <div className="rounded-lg bg-red-900/30 ring-1 ring-red-500/30 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {loading && projects.length === 0 && (
            <p className="text-sm text-[var(--text-muted)] text-center py-12">Loading…</p>
          )}

          {!loading && projects.length === 0 && (
            <div className="rounded-xl bg-[var(--bg-secondary)]/60 p-8 text-center">
              <h3 className="text-base font-semibold text-[var(--text-primary)] mb-2">No error-capture projects yet</h3>
              <p className="text-sm text-[var(--text-secondary)] max-w-md mx-auto">
                Create a project to get a DSN you can drop into any Sentry SDK. Captured errors are dispatched
                into the session you choose so Claude can investigate.
              </p>
              <button
                onClick={handleNew}
                className="mt-4 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
              >
                Create your first project
              </button>
            </div>
          )}

          {projects.map(p => (
            <div key={p.id} className="rounded-xl bg-[var(--bg-secondary)]/60 p-5 space-y-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)] truncate">{p.name}</h3>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 ring-1 ring-indigo-500/30 font-medium">
                      → {sessionName(p.session_id)}
                    </span>
                    {!p.enabled && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-300 ring-1 ring-gray-500/30 font-medium">
                        Disabled
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                    Dedupe {p.dedupe_window_seconds}s · {p.rate_limit_per_hour}/hr · daily cap {p.daily_dispatch_cap}
                  </div>
                </div>

                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => setDrawerProject(p)}
                    className="px-2.5 py-1.5 text-xs text-indigo-300 hover:text-indigo-200 hover:bg-[var(--bg-tertiary)]/40 rounded-lg transition-colors font-medium"
                    title="View errors"
                  >
                    View errors
                  </button>
                  <button
                    onClick={() => toggle(p.id, !p.enabled)}
                    className={`p-1.5 rounded-lg transition-colors ${
                      p.enabled
                        ? 'text-emerald-400 hover:bg-[var(--bg-tertiary)]/40'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'
                    }`}
                    title={p.enabled ? 'Disable' : 'Enable'}
                    aria-label={p.enabled ? 'Disable project' : 'Enable project'}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      {p.enabled ? <path d="M3 8l3 3 7-7" /> : <circle cx="8" cy="8" r="6" />}
                    </svg>
                  </button>
                  <button
                    onClick={() => handleEdit(p)}
                    className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 rounded-lg transition-colors"
                    title="Edit"
                    aria-label="Edit project"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11.5 2.5l2 2L5 13H3v-2z" />
                    </svg>
                  </button>
                  {confirmingDelete === p.id ? (
                    <>
                      <button
                        onClick={() => handleDelete(p.id)}
                        className="px-2 py-1 text-[11px] font-medium text-white bg-red-600 hover:bg-red-500 rounded transition-colors"
                      >
                        Delete
                      </button>
                      <button
                        onClick={() => setConfirmingDelete(null)}
                        className="px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60 rounded transition-colors"
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmingDelete(p.id)}
                      className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded-lg transition-colors"
                      title="Delete"
                      aria-label="Delete project"
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 4h10M6 4V2.5h4V4M5 4l.5 9h5L11 4" />
                      </svg>
                    </button>
                  )}
                </div>
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] mb-1">DSN</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-2 py-1.5 text-xs rounded bg-[var(--code-bg)] text-[var(--text-primary)] font-mono break-all">
                    {p.dsn}
                  </code>
                  <button
                    onClick={() => copyDsn(p)}
                    className="px-3 py-1.5 text-xs rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)]/70 text-[var(--text-secondary)] hover:text-[var(--text-primary)] font-medium transition-colors shrink-0"
                  >
                    {copiedId === p.id ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>

              <div className="text-[11px] text-[var(--text-muted)]">
                Created {formatTs(p.created_at)}
              </div>
            </div>
          ))}
        </div>
      </div>

      {editorOpen && (
        <ErrorProjectEditor
          token={token}
          existing={editing}
          onClose={handleClose}
          onSave={handleSave}
        />
      )}

      {drawerProject && (
        <ErrorDetailDrawer
          token={token}
          project={drawerProject}
          subscribe={subscribe}
          onClose={() => setDrawerProject(null)}
        />
      )}
    </div>
  )
}

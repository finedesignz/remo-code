import { useEffect, useRef, useState } from 'react'
import { hubFetch, HubFetchError } from '../lib/api'
import { validateRoot, MAX_ROOTS } from '../lib/roots-validate'

interface Props {
  token: string
  supervisorId: string
  roots: string[]
  online: boolean
  /** Called after a successful PATCH so the parent can refetch authoritative state. */
  onSaved?: () => void
}

/** Map a hub 400 `error` code to a friendly message (fallback to the raw code). */
function serverErrorMessage(body: any): string {
  const code = typeof body?.error === 'string' ? body.error : ''
  const map: Record<string, string> = {
    root_not_absolute: 'Path must be absolute.',
    root_has_parent_traversal: 'Path cannot contain ".." segments.',
    root_is_drive_root: 'A whole drive root is too broad — pick a subfolder.',
    root_is_system_dir: 'System directories cannot be scan roots.',
    root_too_long: 'Path is too long.',
    root_empty: 'Path cannot be empty.',
    too_many_roots: `A supervisor can have at most ${MAX_ROOTS} root folders.`,
  }
  const suffix = body?.value ? ` (${body.value})` : ''
  return (map[code] || code || 'The supervisor rejected that path.') + suffix
}

function expandedStorageKey(supervisorId: string): string {
  return `remo:rootsEditor:expanded:${supervisorId}`
}

function readStoredExpanded(supervisorId: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(expandedStorageKey(supervisorId))
    if (raw === null) return null
    return raw === '1'
  } catch {
    return null
  }
}

function writeStoredExpanded(supervisorId: string, expanded: boolean) {
  try {
    window.localStorage.setItem(expandedStorageKey(supervisorId), expanded ? '1' : '0')
  } catch {
    // ignore — per-viewer convenience only
  }
}

/**
 * Per-supervisor root-folder manager for the Connections tab. Lists the
 * supervisor's current scan roots (each removable), and takes a new absolute
 * path — including custom, non-GitHub folders like `D:\ClientWork`. Every edit
 * PATCHes the FULL desired array to `PATCH /api/supervisors/:id/roots`; the hub
 * persists it and pushes `supervisor.set_roots` so the supervisor rescans.
 *
 * The route is step-up gated (recent-auth). A `re_auth_required` 401 surfaces
 * the "request a fresh magic link" hint inline (same wording the credentials
 * flow uses) rather than a dead error.
 *
 * Collapses to a small icon button (folder + count badge) once at least one
 * root is configured — the first-run affordance stays expanded when there
 * are zero roots. Expanded/collapsed state persists per viewer in
 * localStorage, keyed by supervisor.
 */
export function SupervisorRootsEditor({ token, supervisorId, roots, online, onSaved }: Props) {
  // Local optimistic copy; re-seed when the authoritative list changes.
  const [items, setItems] = useState<string[]>(roots)
  const rootsKey = roots.join('\0')
  useEffect(() => { setItems(roots) }, [rootsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const [expanded, setExpanded] = useState<boolean>(() => {
    const stored = readStoredExpanded(supervisorId)
    if (stored !== null) return stored
    return roots.length === 0
  })
  // Zero roots always forces the first-run affordance open.
  useEffect(() => {
    if (items.length === 0) setExpanded(true)
  }, [items.length])

  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev
      writeStoredExpanded(supervisorId, next)
      return next
    })
  }

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current) }, [])

  const flashNotice = (msg: string) => {
    setNotice(msg)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setNotice(null), 5000)
  }

  const save = async (nextRoots: string[], optimistic: string[]) => {
    setBusy(true); setError(null)
    const prev = items
    setItems(optimistic)
    try {
      const res = await hubFetch<{ ok: boolean; applied: 'live' | 'queued'; roots: string[]; supervisor_error: string | null }>(
        token,
        `/api/supervisors/${supervisorId}/roots`,
        { method: 'PATCH', json: { roots: nextRoots } },
      )
      setItems(res.roots)
      setDraft('')
      if (res.applied === 'live') {
        flashNotice('Saved — supervisor is rescanning for repos.')
      } else if (res.supervisor_error) {
        flashNotice(`Saved. Supervisor will pick it up on reconnect (${res.supervisor_error}).`)
      } else {
        flashNotice('Saved. Supervisor is offline — it will apply this on reconnect.')
      }
      onSaved?.()
    } catch (e) {
      setItems(prev) // roll back optimistic change
      if (e instanceof HubFetchError) {
        if (e.status === 401 && e.body?.error === 're_auth_required') {
          setError('Your session is too old for this sensitive action. Sign out and sign back in with a fresh magic link, then retry.')
        } else if (e.status === 400) {
          setError(serverErrorMessage(e.body))
        } else {
          setError(typeof e.body?.error === 'string' ? e.body.error : e.message)
        }
      } else {
        setError(e instanceof Error ? e.message : 'Failed to save roots')
      }
    } finally {
      setBusy(false)
    }
  }

  const addRoot = () => {
    const trimmed = draft.trim()
    const clientError = validateRoot(trimmed)
    if (clientError) { setError(clientError); return }
    if (items.some((r) => r.toLowerCase() === trimmed.toLowerCase())) {
      setError('That folder is already a root.'); return
    }
    if (items.length >= MAX_ROOTS) {
      setError(`A supervisor can have at most ${MAX_ROOTS} root folders.`); return
    }
    const next = [...items, trimmed]
    void save(next, next)
  }

  const removeRoot = (path: string) => {
    const next = items.filter((r) => r !== path)
    void save(next, next)
  }

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={toggleExpanded}
        aria-label={`Root folders (${items.length})`}
        title={`Root folders (${items.length})`}
        className="relative flex items-center justify-center w-11 h-11 rounded-lg text-[var(--text-muted)] bg-[var(--bg-tertiary)]/40 hover:bg-[var(--bg-tertiary)]/60 hover:text-[var(--text-primary)] transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
        <span className="absolute -top-1 -right-1 min-w-[15px] h-[15px] px-[3px] flex items-center justify-center rounded-full bg-blue-600 text-[9px] leading-none text-[var(--text-on-accent)]">
          {items.length}
        </span>
      </button>
    )
  }

  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-3 space-y-2 w-full">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-[var(--text-secondary)]">Root folders</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-[var(--text-muted)]">
            {items.length}/{MAX_ROOTS} · scanned for repos
          </span>
          {items.length > 0 && (
            <button
              type="button"
              onClick={toggleExpanded}
              aria-label="Collapse root folders"
              title="Collapse"
              className="flex items-center justify-center w-11 h-11 -m-2.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 transition-colors"
            >
              <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
            </button>
          )}
        </div>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)] px-1 py-1">
          No root folders. Add an absolute path below to tell this supervisor where to look for repos.
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((path) => (
            <li
              key={path}
              className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-[var(--bg-tertiary)]/40"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-[var(--text-muted)] shrink-0" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
              <span className="flex-1 min-w-0 truncate font-mono text-xs text-[var(--text-primary)]" title={path}>{path}</span>
              <button
                type="button"
                onClick={() => removeRoot(path)}
                disabled={busy}
                aria-label={`Remove ${path}`}
                title="Remove root folder"
                className="shrink-0 flex items-center justify-center w-11 h-11 -m-2.5 rounded-md text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-0.5">
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); if (error) setError(null) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRoot() } }}
          placeholder="Add folder — e.g. D:\ClientWork"
          spellCheck={false}
          disabled={busy}
          className="flex-1 min-w-0 px-3 py-1.5 text-sm font-mono bg-[var(--bg-tertiary)]/40 rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:bg-[var(--bg-tertiary)]/60 focus:ring-1 focus:ring-blue-500/50 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={addRoot}
          disabled={busy || draft.trim().length === 0}
          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-[var(--text-on-accent)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {busy ? 'Saving…' : 'Add folder'}
        </button>
      </div>

      {!online && (
        <p className="text-[10px] text-amber-400/90 px-1">
          Supervisor is offline — changes save now and apply when it reconnects.
        </p>
      )}
      {error && <div className="px-2 py-1.5 bg-red-900/30 rounded-lg text-xs text-red-200">{error}</div>}
      {notice && <div className="px-2 py-1.5 bg-emerald-900/30 rounded-lg text-xs text-emerald-200">{notice}</div>}
    </div>
  )
}

export default SupervisorRootsEditor

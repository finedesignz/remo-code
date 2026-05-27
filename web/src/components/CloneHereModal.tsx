import { useEffect, useMemo, useState } from 'react'
import { hubFetch } from '../lib/api'

interface Supervisor {
  id: string
  hostname: string
  online: boolean
  roots?: string[]
}

interface Props {
  token: string
  /** Session that the clone is being done for — must be GitHub-keyed (has repo_key). */
  sessionId: string
  /** Display label — usually `owner/repo`. */
  repoLabel: string
  /**
   * cloneHere helper from useSessions. Modal calls this with the selected
   * supervisorId (informational — the hub picks the first online supervisor
   * for the user today) + target_root.
   */
  cloneHere: (id: string, targetRoot: string) => Promise<{ ok: boolean; error?: string; target_path?: string }>
  onClose: () => void
  /** Optional toast hook for success / error surfaces. */
  onToast?: (msg: string) => void
}

/**
 * "Clone here" modal — opens from the SessionTooltip / sidebar's
 * "Not on this machine" indicator. The user picks which supervisor and which
 * configured root to clone into; the hub dispatches a `repo.clone` to the
 * supervisor and re-scans inventory on completion.
 *
 * The actual clone progress is asynchronous — this modal closes after the
 * dispatch and the supervisor reports back via `repo_inventory` updates.
 */
export function CloneHereModal({ token, sessionId, repoLabel, cloneHere, onClose, onToast }: Props) {
  const [supervisors, setSupervisors] = useState<Supervisor[]>([])
  const [loading, setLoading] = useState(true)
  const [supervisorId, setSupervisorId] = useState<string>('')
  const [root, setRoot] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    hubFetch<{ supervisors: Supervisor[] } | Supervisor[]>(token, '/api/supervisors')
      .then(data => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : data?.supervisors ?? []
        setSupervisors(list)
        const firstOnline = list.find(s => s.online && (s.roots?.length ?? 0) > 0)
        if (firstOnline) {
          setSupervisorId(firstOnline.id)
          setRoot(firstOnline.roots?.[0] ?? '')
        }
      })
      .catch(() => { if (!cancelled) setError('Failed to load supervisors.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  const selected = useMemo(() => supervisors.find(s => s.id === supervisorId), [supervisors, supervisorId])
  const roots = selected?.roots ?? []
  const canSubmit = !submitting && !!supervisorId && !!root

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await cloneHere(sessionId, root)
      if (!res.ok) {
        const code = res.error ?? 'unknown'
        const friendly =
          code === 'supervisor_offline' ? 'Supervisor is offline.'
          : code === 'no_repo_key' ? 'This session is not linked to a GitHub repo.'
          : code === 'target_root_not_in_inventory' ? 'Selected root is not configured on the supervisor.'
          : code === 'no_root_configured' ? 'Supervisor has no configured repo roots.'
          : `Clone failed: ${code}`
        setError(friendly)
        return
      }
      onToast?.(`Cloning ${repoLabel}…`)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  const onlineWithRoots = supervisors.filter(s => s.online && (s.roots?.length ?? 0) > 0)

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl bg-[var(--bg-secondary)] p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Clone repo locally</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{repoLabel}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/40"
          >
            Close
          </button>
        </div>

        {loading ? (
          <p className="text-xs text-[var(--text-muted)]">Loading supervisors…</p>
        ) : onlineWithRoots.length === 0 ? (
          <p className="text-xs text-amber-300">
            No online supervisor with configured roots. Configure at least one root in Settings → Supervisor.
          </p>
        ) : (
          <div className="space-y-4">
            <label className="block">
              <span className="block text-xs text-[var(--text-muted)] mb-1">Supervisor</span>
              <select
                value={supervisorId}
                onChange={e => {
                  const id = e.target.value
                  setSupervisorId(id)
                  const sup = supervisors.find(s => s.id === id)
                  setRoot(sup?.roots?.[0] ?? '')
                }}
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]"
              >
                {onlineWithRoots.map(s => (
                  <option key={s.id} value={s.id}>{s.hostname}</option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="block text-xs text-[var(--text-muted)] mb-1">Target root</span>
              <select
                value={root}
                onChange={e => setRoot(e.target.value)}
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] font-mono"
                disabled={roots.length === 0}
              >
                {roots.length === 0 && <option value="">No roots configured</option>}
                {roots.map(r => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </label>

            {error && (
              <div className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-xs text-red-300">
                {error}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-xs text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {submitting ? 'Cloning…' : 'Clone'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

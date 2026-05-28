import { useEffect, useState } from 'react'
import { hubFetch } from '../lib/api'
import { useRepoCreateJob, stageLabel } from '../hooks/useRepoCreateJob'

interface OrgListResponse {
  orgs?: Array<{ login: string }>
}

interface CreateResult { ok: boolean; job_id?: string; error?: string; scopeMissing?: boolean }

interface Props {
  token: string
  /** Session that owns the folder we want to push to GitHub. */
  sessionId: string
  /** Defaults the repo-name field to a lower-cased folder basename. */
  defaultName: string
  /** Helper from useSessions. */
  createGithubRepo: (id: string, opts: { name: string; private: boolean; org?: string | null }) => Promise<CreateResult>
  /**
   * Hub WS subscribe (forwarded from useWebSocket) — needed for the progress
   * bar to receive `repo_create_progress` / `repo_create_failed`.
   */
  subscribe: (handler: (msg: any) => void) => () => void
  onClose: () => void
  /** Called when the job finishes successfully so the sidebar can refetch. */
  onCompleted?: () => void
}

/**
 * Create a brand-new GitHub repo from a local folder a supervisor already
 * knows about. The hub validates GitHub App scope (412 → missing
 * administration:write), enqueues a background job, and streams progress over
 * the websocket.
 *
 * Stages map onto a single horizontal progress bar — see `stageLabel` /
 * `useRepoCreateJob` for the source of truth on the hub's wire vocabulary.
 */
export function CreateGithubRepoModal({
  token, sessionId, defaultName, createGithubRepo, subscribe, onClose, onCompleted,
}: Props) {
  const [name, setName] = useState(defaultName.toLowerCase())
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [owner, setOwner] = useState<string>('user') // 'user' or an org login
  const [orgs, setOrgs] = useState<string[] | null>(null) // null = loading
  const [orgsError, setOrgsError] = useState<string | null>(null)

  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [scopeMissing, setScopeMissing] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useRepoCreateJob(jobId, subscribe)

  // Fetch org list — endpoint may not exist yet; stub gracefully.
  useEffect(() => {
    let cancelled = false
    hubFetch<OrgListResponse>(token, '/api/github/orgs')
      .then(data => {
        if (cancelled) return
        const logins = (data.orgs ?? []).map(o => o.login).filter(Boolean)
        setOrgs(logins)
      })
      .catch(() => { if (!cancelled) { setOrgs([]); setOrgsError('orgs_unavailable') } })
    return () => { cancelled = true }
  }, [token])

  // Auto-close on success after a brief beat so the user sees "Done".
  useEffect(() => {
    if (!job.finished) return
    onCompleted?.()
    const t = window.setTimeout(() => onClose(), 800)
    return () => window.clearTimeout(t)
  }, [job.finished, onClose, onCompleted])

  const handleSubmit = async () => {
    if (submitting || jobId) return
    const trimmed = name.trim()
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      setSubmitError('Name may only contain letters, numbers, dots, dashes, and underscores.')
      return
    }
    setSubmitting(true)
    setSubmitError(null)
    setScopeMissing(false)
    try {
      const res = await createGithubRepo(sessionId, {
        name: trimmed,
        private: visibility === 'private',
        org: owner === 'user' ? null : owner,
      })
      if (!res.ok) {
        if (res.scopeMissing) {
          setScopeMissing(true)
          setSubmitError('GitHub App is missing administration:write — re-install with the required permission or configure a PAT.')
        } else {
          setSubmitError(`Create failed: ${res.error ?? 'unknown'}`)
        }
        return
      }
      setJobId(res.job_id ?? null)
    } finally {
      setSubmitting(false)
    }
  }

  const retry = () => {
    setJobId(null)
    setSubmitError(null)
  }

  // While the job is active or done, lock the form and show progress.
  const showProgress = !!jobId
  const isFailure = job.stage === 'failed' || (!!submitError && !showProgress)
  const pct = Math.min(100, Math.max(0, job.percent))

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
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">Create GitHub repo</h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">Push this folder to a new remote</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/40"
          >
            Close
          </button>
        </div>

        {!showProgress && (
          <div className="space-y-4">
            <label className="block">
              <span className="block text-xs text-[var(--text-muted)] mb-1">Repo name</span>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="my-repo"
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] font-mono"
                spellCheck={false}
                autoCapitalize="off"
              />
            </label>

            <fieldset className="block">
              <span className="block text-xs text-[var(--text-muted)] mb-1">Visibility</span>
              <div className="flex items-center gap-3 text-sm">
                <label className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                  <input
                    type="radio"
                    name="visibility"
                    value="private"
                    checked={visibility === 'private'}
                    onChange={() => setVisibility('private')}
                  />
                  <span>Private</span>
                </label>
                <label className="inline-flex items-center gap-2 text-[var(--text-secondary)]">
                  <input
                    type="radio"
                    name="visibility"
                    value="public"
                    checked={visibility === 'public'}
                    onChange={() => setVisibility('public')}
                  />
                  <span>Public</span>
                </label>
              </div>
            </fieldset>

            <label className="block">
              <span className="block text-xs text-[var(--text-muted)] mb-1">Owner</span>
              <select
                value={owner}
                onChange={e => setOwner(e.target.value)}
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]"
                disabled={orgs === null}
              >
                <option value="user">Your account</option>
                {orgs === null && <option disabled>Loading orgs…</option>}
                {(orgs ?? []).map(o => (
                  <option key={o} value={o}>{o}</option>
                ))}
              </select>
              {orgsError && (
                <span className="text-[11px] text-[var(--text-muted)] mt-1 block">
                  Org list unavailable — defaulting to your account.
                </span>
              )}
            </label>

            {submitError && (
              <div className={`rounded-lg px-3 py-2 text-xs ${
                scopeMissing
                  ? 'bg-amber-500/10 ring-1 ring-amber-500/30 text-amber-200'
                  : 'bg-red-500/10 ring-1 ring-red-500/30 text-red-300'
              }`}>
                {submitError}
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
                disabled={submitting || scopeMissing || !name.trim()}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-xs text-[var(--text-on-accent)] hover:bg-indigo-500 disabled:opacity-50"
              >
                {submitting ? 'Creating…' : 'Create'}
              </button>
            </div>
          </div>
        )}

        {showProgress && (
          <div className="space-y-3">
            <div className="text-xs text-[var(--text-secondary)] flex items-center justify-between">
              <span>{stageLabel(job.stage)}</span>
              <span className="font-mono text-[var(--text-muted)]">{pct}%</span>
            </div>
            <div className="h-2 rounded bg-[var(--bg-tertiary)] overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  job.stage === 'failed' ? 'bg-red-500' : 'bg-indigo-500'
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {job.message && (
              <p className="text-[11px] text-[var(--text-muted)] truncate" title={job.message}>{job.message}</p>
            )}
            {isFailure && (
              <div className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 px-3 py-2 text-xs text-red-300">
                <div>{job.error ?? submitError ?? 'Job failed.'}</div>
                <div className="mt-2 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={retry}
                    className="rounded-lg px-2 py-1 text-[11px] bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)]"
                  >
                    Retry
                  </button>
                  <button
                    type="button"
                    onClick={onClose}
                    className="rounded-lg px-2 py-1 text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
            {job.finished && (
              <div className="rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30 px-3 py-2 text-xs text-emerald-300">
                Done — repo created.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

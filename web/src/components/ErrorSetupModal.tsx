import { useEffect, useState } from 'react'
import { hubFetch } from '../lib/api'
import { useErrorSetup } from '../hooks/useErrorSetup'

interface Props {
  token: string
  projectId: string
  projectName: string
  onClose: () => void
}

interface Supervisor {
  id: string
  hostname: string
  online: boolean
}

/**
 * One-click SDK install modal (W5).
 *
 * Pairs an error_project with a supervisor + repo path, runs stack
 * detection, injects the Sentry init snippet, commits + pushes to the
 * default branch, and (optionally) pushes SENTRY_DSN to a Coolify app.
 *
 * Wiring: W4's ErrorCapturePage should render a "Setup" button per
 * project row that opens this modal with the projectId. See note in
 * the final task report for the suggested integration point.
 */
export function ErrorSetupModal({ token, projectId, projectName, onClose }: Props) {
  const [supervisors, setSupervisors] = useState<Supervisor[]>([])
  const [supervisorId, setSupervisorId] = useState<string>('')
  const [repoPath, setRepoPath] = useState('')
  const [coolifyAppUuid, setCoolifyAppUuid] = useState('')
  const [redeploy, setRedeploy] = useState(false)
  const setup = useErrorSetup(token)

  useEffect(() => {
    let cancelled = false
    hubFetch<{ supervisors: Supervisor[] } | Supervisor[]>(token, '/api/supervisors')
      .then(data => {
        if (cancelled) return
        const list = Array.isArray(data) ? data : data?.supervisors ?? []
        setSupervisors(list)
        const firstOnline = list.find(s => s.online)
        if (firstOnline) setSupervisorId(firstOnline.id)
      })
      .catch(() => { /* swallow — UI shows empty dropdown */ })
    return () => { cancelled = true }
  }, [token])

  const canSubmit = !setup.loading && supervisorId && repoPath.trim().length > 0

  function onSubmit() {
    if (!canSubmit) return
    setup.run(projectId, {
      supervisor_id: supervisorId,
      repo_path: repoPath.trim(),
      coolify_app_uuid: coolifyAppUuid.trim() || undefined,
      redeploy,
    })
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-xl bg-[var(--bg-secondary)] p-5 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[var(--text-primary)]">
              Install Sentry SDK
            </h2>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Detect stack and inject SDK in {projectName}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:bg-[var(--bg-tertiary)]/40"
          >
            Close
          </button>
        </div>

        <div className="space-y-4">
          <label className="block">
            <span className="block text-xs text-[var(--text-muted)] mb-1">Supervisor</span>
            <select
              value={supervisorId}
              onChange={e => setSupervisorId(e.target.value)}
              className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)]"
            >
              {supervisors.length === 0 && <option value="">No supervisors</option>}
              {supervisors.map(s => (
                <option key={s.id} value={s.id} disabled={!s.online}>
                  {s.hostname} {s.online ? '' : '(offline)'}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="block text-xs text-[var(--text-muted)] mb-1">
              Repo path (absolute, on the supervisor host)
            </span>
            <input
              type="text"
              value={repoPath}
              onChange={e => setRepoPath(e.target.value)}
              placeholder="/home/user/projects/my-app"
              className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </label>

          <label className="block">
            <span className="block text-xs text-[var(--text-muted)] mb-1">
              Coolify app UUID (optional — pushes SENTRY_DSN env var)
            </span>
            <input
              type="text"
              value={coolifyAppUuid}
              onChange={e => setCoolifyAppUuid(e.target.value)}
              placeholder="leave blank to skip Coolify env push"
              className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={redeploy}
              onChange={e => setRedeploy(e.target.checked)}
              disabled={!coolifyAppUuid.trim()}
            />
            <span>
              Redeploy Coolify app after setup
              {!coolifyAppUuid.trim() && <span className="text-[var(--text-muted)]"> (set UUID first)</span>}
            </span>
          </label>

          {setup.error && <ErrorPanel error={setup.error} />}
          {setup.result && <ResultPanel result={setup.result} />}

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => { setup.reset(); onClose() }}
              className="rounded-lg px-3 py-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40"
            >
              {setup.result?.ok ? 'Done' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-xs text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {setup.loading ? 'Working…' : 'Detect stack & install'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ErrorPanel({ error }: { error: { error: string; tried?: string[]; missing?: string[]; hint?: string; detail?: string } }) {
  return (
    <div className="rounded-lg bg-red-500/10 ring-1 ring-red-500/30 p-3 text-xs">
      <div className="font-semibold text-red-300">{prettyError(error.error)}</div>
      {error.detail && <div className="mt-1 text-red-200/80">{error.detail}</div>}
      {error.missing && error.missing.length > 0 && (
        <div className="mt-2 text-red-200/80">
          Missing supervisor command{error.missing.length > 1 ? 's' : ''}: {error.missing.join(', ')}
        </div>
      )}
      {error.hint && <div className="mt-2 text-red-200/80">{error.hint}</div>}
      {error.tried && error.tried.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-red-300/80">Signals tried</summary>
          <ul className="mt-1 ml-4 list-disc text-red-200/70">
            {error.tried.map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </details>
      )}
    </div>
  )
}

function ResultPanel({ result }: { result: NonNullable<ReturnType<typeof useErrorSetup>['result']> }) {
  return (
    <div className="rounded-lg bg-emerald-500/10 ring-1 ring-emerald-500/30 p-3 text-xs space-y-1">
      <div className="font-semibold text-emerald-300">
        {result.alreadyConfigured ? 'Already configured' : 'Setup complete'}
      </div>
      <Row label="Stack" value={result.stack} />
      <Row label="Entry file" value={result.entry_file} />
      <Row label="Manifest" value={result.manifest_file} />
      <Row label="DSN" value={result.dsn} mono />
      <Row label="Commit pushed" value={String(result.commit_pushed ?? result.alreadyConfigured ?? false)} />
      {result.supervisor_error && (
        <div className="text-red-300/80">Supervisor: {result.supervisor_error}</div>
      )}
      {result.coolify_env_set !== null && result.coolify_env_set !== undefined && (
        <Row label="Coolify env set" value={String(result.coolify_env_set)} />
      )}
      {result.coolify_env_error && (
        <div className="text-red-300/80">Coolify env: {result.coolify_env_error}</div>
      )}
      {result.redeployed !== null && result.redeployed !== undefined && (
        <Row label="Redeployed" value={String(result.redeployed)} />
      )}
      {result.redeploy_error && (
        <div className="text-red-300/80">Redeploy: {result.redeploy_error}</div>
      )}
    </div>
  )
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-emerald-200/70">{label}</span>
      <span className={`text-emerald-100 ${mono ? 'font-mono text-[10px] break-all text-right' : ''}`}>{value}</span>
    </div>
  )
}

function prettyError(code: string): string {
  switch (code) {
    case 'supervisor_offline': return 'Supervisor is offline'
    case 'supervisor_command_missing': return 'Supervisor companion not installed'
    case 'stack_not_detected': return 'Could not detect a supported stack'
    case 'project_not_found': return 'Project not found'
    case 'forbidden': return 'Not allowed'
    case 'bad_request': return 'Bad request'
    case 'entry_file_not_probed': return 'Entry file outside probe list'
    case 'supervisor_read_failed': return 'Supervisor failed to read repo files'
    default: return code
  }
}

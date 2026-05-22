import { useEffect, useState, useCallback } from 'react'

interface Props {
  token: string
  onBack?: () => void
  embedded?: boolean
}

interface Supervisor {
  id: string
  hostname: string
  version: string | null
  os: string | null
  roots: string[]
  state: string
  current_run_id: string | null
  last_seen_at: string
  online: boolean
}

interface LocalRepo {
  path: string
  name: string
  remote: string | null
  branch: string | null
  dirty: boolean
  last_commit: string | null
}

interface GitHubRepo {
  id: number
  full_name: string
  name: string
  owner: string
  default_branch: string
  installation_id: number
  account: string
  private: boolean
}

const hubUrl = import.meta.env.VITE_HUB_URL || ''

function apiFetch(token: string, path: string, init?: RequestInit) {
  return fetch(`${hubUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers || {}),
    },
  })
}

export function SupervisorPage({ token, onBack, embedded = false }: Props) {
  const [supervisors, setSupervisors] = useState<Supervisor[]>([])
  const [activeSupervisorId, setActiveSupervisorId] = useState<string | null>(null)
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([])
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([])
  const [githubConfigured, setGithubConfigured] = useState(false)
  const [installations, setInstallations] = useState<any[]>([])
  const [scanning, setScanning] = useState(false)
  const [filter, setFilter] = useState<'all' | 'local' | 'github'>('all')
  const [search, setSearch] = useState('')
  const [startTarget, setStartTarget] = useState<{ kind: 'local'; repo: LocalRepo } | { kind: 'github'; repo: GitHubRepo } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)

  const activeSupervisor = supervisors.find((s) => s.id === activeSupervisorId)

  const loadSupervisors = useCallback(async () => {
    const r = await apiFetch(token, '/api/supervisors')
    if (!r.ok) return
    const data = await r.json()
    setSupervisors(data.supervisors || [])
    if (!activeSupervisorId && data.supervisors?.[0]) setActiveSupervisorId(data.supervisors[0].id)
  }, [token, activeSupervisorId])

  const loadGitHub = useCallback(async () => {
    const r = await apiFetch(token, '/api/github/installations')
    if (!r.ok) return
    const data = await r.json()
    setGithubConfigured(!!data.configured)
    setInstallations(data.installations || [])
    if (data.configured && (data.installations || []).length > 0) {
      const rr = await apiFetch(token, '/api/github/repos')
      if (rr.ok) {
        const dd = await rr.json()
        setGithubRepos(dd.repos || [])
      }
    }
  }, [token])

  const scan = useCallback(async () => {
    if (!activeSupervisorId) return
    setScanning(true)
    setError(null)
    try {
      const r = await apiFetch(token, `/api/supervisors/${activeSupervisorId}/scan`, { method: 'POST' })
      if (!r.ok) { setError((await r.json()).error || 'scan failed'); return }
      const data = await r.json()
      setLocalRepos(data.repos || [])
    } catch (e: any) { setError(e.message) }
    finally { setScanning(false) }
  }, [token, activeSupervisorId])

  useEffect(() => { loadSupervisors(); loadGitHub() }, [])
  useEffect(() => { if (activeSupervisorId && activeSupervisor?.online) scan() }, [activeSupervisorId])

  // Poll supervisor list every 10s for state updates
  useEffect(() => {
    const t = setInterval(loadSupervisors, 10_000)
    return () => clearInterval(t)
  }, [loadSupervisors])

  // Local + GitHub merged, filtered, searched
  const mergedRepos = (() => {
    const localPaths = new Set(localRepos.map((r) => r.remote))
    const items: Array<{ kind: 'local' | 'github' | 'both'; local?: LocalRepo; github?: GitHubRepo; key: string }> = []
    if (filter !== 'github') {
      for (const r of localRepos) items.push({ kind: 'local', local: r, key: r.path })
    }
    if (filter !== 'local' && githubConfigured) {
      for (const g of githubRepos) {
        const matchLocal = localRepos.find((l) => l.remote?.includes(g.full_name))
        if (matchLocal && filter !== 'github') continue
        items.push({ kind: matchLocal ? 'both' : 'github', github: g, local: matchLocal, key: g.full_name })
      }
    }
    const q = search.toLowerCase().trim()
    if (q) return items.filter((it) => (it.local?.name || it.github?.full_name || '').toLowerCase().includes(q))
    return items
  })()

  const stopActive = async () => {
    if (!activeSupervisorId) return
    await apiFetch(token, `/api/supervisors/${activeSupervisorId}/stop`, { method: 'POST', body: JSON.stringify({ reason: 'user' }) })
    loadSupervisors()
  }

  const connectGitHub = async () => {
    const r = await apiFetch(token, '/api/github/install_url')
    if (!r.ok) { setError('GitHub App not configured on hub'); return }
    const data = await r.json()
    window.location.href = data.url
  }

  const body = (
    <div className="space-y-5">
          {/* removed page chrome — embedded inside Settings */}
          {error && <div className="p-3 bg-red-900/30 border border-red-800/60 rounded-lg text-sm text-red-200">{error}</div>}
          {info && <div className="p-3 bg-emerald-900/30 border border-emerald-800/60 rounded-lg text-sm text-emerald-200">{info}</div>}

          {/* Supervisor card */}
          <div className="bg-[var(--bg-secondary)]/60 border border-[var(--border-color)] rounded-xl p-5">
            <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-3">My machines</h3>
            {supervisors.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)]">
                No supervisor has registered yet.<br />
                Run this on the machine you want to control:<br />
                <code className="block mt-2 p-2 bg-[var(--code-bg)] rounded text-xs text-indigo-300 font-mono">
                  npx remo-code-supervisor install --api-key &lt;your_api_key&gt; --roots "C:\Users\you\GitHub"
                </code>
              </div>
            ) : (
              <div className="space-y-2">
                {supervisors.map((s) => (
                  <div
                    key={s.id}
                    onClick={() => setActiveSupervisorId(s.id)}
                    className={`p-3 rounded-lg border cursor-pointer transition-colors ${s.id === activeSupervisorId ? 'border-indigo-500/70 bg-indigo-500/10' : 'border-[var(--border-color)] hover:bg-[var(--bg-tertiary)]/40'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${s.online ? (s.state === 'running' ? 'bg-amber-400' : s.state === 'crashed' || s.state === 'stopped' ? 'bg-red-400' : 'bg-emerald-400') : 'bg-gray-500'}`} />
                        <span className="text-sm font-medium text-[var(--text-primary)]">{s.hostname}</span>
                        <span className="text-xs text-[var(--text-muted)]">{s.online ? s.state : 'offline'}</span>
                      </div>
                      <span className="text-xs text-[var(--text-muted)]">v{s.version || '?'}</span>
                    </div>
                    <div className="text-xs text-[var(--text-muted)] mt-1">{s.roots.join(' · ') || 'no roots'}</div>
                    {s.state === 'running' && s.id === activeSupervisorId && (
                      <div className="mt-2">
                        <button onClick={stopActive} className="px-3 py-1 text-xs bg-red-600/80 hover:bg-red-500 rounded text-white">Stop</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* GitHub */}
          <div className="bg-[var(--bg-secondary)]/60 border border-[var(--border-color)] rounded-xl p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">GitHub</h3>
              {!githubConfigured ? (
                <span className="text-xs text-amber-400">App not configured on hub</span>
              ) : installations.length === 0 ? (
                <button onClick={connectGitHub} className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 rounded text-white">Connect GitHub</button>
              ) : (
                <span className="text-xs text-[var(--text-muted)]">{installations.length} install{installations.length === 1 ? '' : 's'} · {githubRepos.length} repos</span>
              )}
            </div>
            {githubConfigured && installations.length > 0 && (
              <button onClick={connectGitHub} className="mt-3 px-3 py-1.5 text-xs border border-[var(--border-color)] rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40">Add another installation</button>
            )}
          </div>

          {/* Repo list */}
          <div className="bg-[var(--bg-secondary)]/60 border border-[var(--border-color)] rounded-xl p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Repos</h3>
              <div className="flex items-center gap-2">
                <button onClick={scan} disabled={!activeSupervisor?.online || scanning} className="px-2 py-1 text-xs bg-[var(--bg-tertiary)]/60 hover:bg-[var(--bg-tertiary)] rounded text-[var(--text-secondary)] disabled:opacity-50">{scanning ? 'Scanning…' : 'Rescan'}</button>
              </div>
            </div>
            <div className="flex gap-2 mb-3">
              {(['all', 'local', 'github'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={`px-2 py-1 text-xs rounded ${filter === f ? 'bg-indigo-600 text-white' : 'bg-[var(--bg-tertiary)]/60 text-[var(--text-secondary)]'}`}>{f}</button>
              ))}
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="flex-1 px-2 py-1 text-xs bg-[var(--bg-primary)]/60 border border-[var(--border-color)] rounded text-[var(--text-primary)] placeholder-[var(--text-muted)]"
              />
            </div>
            {mergedRepos.length === 0 ? (
              <div className="text-sm text-[var(--text-muted)] py-6 text-center">No repos to show.</div>
            ) : (
              <div className="space-y-1">
                {mergedRepos.map((it) => (
                  <div key={it.key} className="flex items-center justify-between gap-2 px-3 py-2 rounded hover:bg-[var(--bg-tertiary)]/40">
                    <div className="min-w-0">
                      <div className="text-sm text-[var(--text-primary)] truncate">{it.local?.name || it.github?.name}</div>
                      <div className="text-xs text-[var(--text-muted)] truncate">
                        {it.local && <>local · {it.local.branch || 'detached'}{it.local.dirty && <span className="text-amber-400"> · dirty</span>}</>}
                        {it.kind === 'both' && <> · </>}
                        {it.github && <>github · {it.github.full_name}</>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {it.local ? (
                        <button
                          onClick={() => setStartTarget({ kind: 'local', repo: it.local! })}
                          disabled={!activeSupervisor?.online || activeSupervisor?.state !== 'idle'}
                          className="px-2 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 rounded text-white disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          Start
                        </button>
                      ) : it.github ? (
                        <button
                          onClick={() => setStartTarget({ kind: 'github', repo: it.github! })}
                          disabled={!activeSupervisor?.online || activeSupervisor?.state !== 'idle'}
                          className="px-2 py-1 text-xs bg-indigo-600/70 hover:bg-indigo-500 rounded text-white disabled:opacity-40"
                        >
                          Clone & Start
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

      {startTarget && activeSupervisor && (
        <StartDialog
          token={token}
          supervisorId={activeSupervisor.id}
          target={startTarget}
          onClose={() => setStartTarget(null)}
          onStarted={(runId) => { setStartTarget(null); setInfo(`Started run ${runId.slice(0, 8)}`); setTimeout(() => setInfo(null), 4000); loadSupervisors() }}
          onError={(msg) => { setError(msg); setTimeout(() => setError(null), 6000) }}
        />
      )}
    </div>
  )

  if (embedded) return body

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
        {onBack && (
          <button onClick={onBack} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors" aria-label="Back to chat">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 4l-6 6 6 6" />
            </svg>
          </button>
        )}
        <h2 className="text-sm font-semibold text-[var(--text-secondary)]">Supervisor</h2>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto p-4 sm:p-6">
          {body}
        </div>
      </div>
    </div>
  )
}

function StartDialog(props: {
  token: string
  supervisorId: string
  target: { kind: 'local'; repo: LocalRepo } | { kind: 'github'; repo: GitHubRepo }
  onClose: () => void
  onStarted: (runId: string) => void
  onError: (msg: string) => void
}) {
  const { token, supervisorId, target, onClose, onStarted, onError } = props
  const localRepo = target.kind === 'local' ? target.repo : null
  const githubRepo = target.kind === 'github' ? target.repo : null

  const [branch, setBranch] = useState<string>(localRepo?.branch || githubRepo?.default_branch || '')
  const [pull, setPull] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [branches, setBranches] = useState<string[]>([])

  useEffect(() => {
    if (githubRepo) {
      apiFetch(token, `/api/github/repos/${githubRepo.owner}/${githubRepo.name}/branches`)
        .then((r) => r.ok ? r.json() : { branches: [] })
        .then((d) => setBranches(d.branches?.map((b: any) => b.name) || []))
        .catch(() => {})
    }
  }, [])

  const handleStart = async () => {
    setBusy(true)
    try {
      let repoPath = localRepo?.path || ''
      if (githubRepo) {
        // Clone first
        const cloneRes = await apiFetch(token, `/api/supervisors/${supervisorId}/clone`, {
          method: 'POST',
          body: JSON.stringify({
            installation_id: githubRepo.installation_id,
            owner: githubRepo.owner,
            repo: githubRepo.name,
            target_dir_name: githubRepo.name,
          }),
        })
        if (!cloneRes.ok) { onError((await cloneRes.json()).error || 'clone failed'); return }
        const cd = await cloneRes.json()
        if (!cd.ok) { onError(cd.error || 'clone failed'); return }
        repoPath = cd.data?.path
      }
      const r = await apiFetch(token, `/api/supervisors/${supervisorId}/start`, {
        method: 'POST',
        body: JSON.stringify({
          repo_path: repoPath,
          branch: branch || undefined,
          pull,
          initial_prompt: prompt || undefined,
        }),
      })
      if (!r.ok) { onError((await r.json()).error || 'start failed'); return }
      const data = await r.json()
      onStarted(data.run_id)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="w-full max-w-md bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl p-6 shadow-xl">
        <h3 className="text-base font-semibold text-[var(--text-primary)] mb-4">
          Start in {localRepo?.name || githubRepo?.name}
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Branch</label>
            {branches.length > 0 ? (
              <select value={branch} onChange={(e) => setBranch(e.target.value)} className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-primary)]">
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-primary)]" />
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />
            git pull before starting {localRepo?.dirty && <span className="text-amber-400 text-xs">(disabled: dirty)</span>}
          </label>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Initial prompt (optional)</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="What should Claude work on?" className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)]" />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 rounded-lg">Cancel</button>
          <button onClick={handleStart} disabled={busy || (localRepo?.dirty && pull)} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-white">
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useSessions } from '../hooks/useSessions'

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

interface ActiveRun {
  id: string
  repo_path: string
  branch: string | null
  started_at: string
  restart_count: number
  state?: string
}

type FilterKey = 'all' | 'running' | 'idle'
type SortKey = 'status' | 'repo' | 'seen'
type SortDir = 'asc' | 'desc'

interface Row {
  key: string
  name: string         // org/repo or repo name for display
  fullName: string     // org/repo when known
  branch: string | null
  path: string | null
  dirty: boolean
  hasLocal: boolean
  hasGithub: boolean
  github?: GitHubRepo
  local?: LocalRepo
  run?: ActiveRun
  status: 'running' | 'idle' | 'starting' | 'error'
  lastSeen: number     // ms since epoch (run started_at or local last_commit) — for sort
}

const hubUrl = import.meta.env.VITE_HUB_URL || ''
const FILTER_LS_KEY = 'remo:repos-filter'

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

function timeAgo(ms: number): string {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`
  return `${Math.floor(d / 86_400_000)}d ago`
}

function truncateMiddle(s: string, max = 50): string {
  if (!s || s.length <= max) return s
  const head = Math.ceil(max / 2) - 1
  const tail = Math.floor(max / 2) - 2
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

// Inline Lucide-style icons
const Icon = {
  Play: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6 4l10 6-10 6V4z" /></svg>
  ),
  Stop: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1" /></svg>
  ),
  Open: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 10h12" /><path d="M11 5l5 5-5 5" /></svg>
  ),
  Refresh: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 10a7 7 0 0 1 12-4.95L17 7" /><path d="M17 3v4h-4" /><path d="M17 10a7 7 0 0 1-12 4.95L3 13" /><path d="M3 17v-4h4" /></svg>
  ),
  X: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" /></svg>
  ),
  ChevronUpDown: (p: any) => (
    <svg {...p} width="10" height="10" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 8l4-4 4 4" /><path d="M6 12l4 4 4-4" /></svg>
  ),
  Back: (p: any) => (
    <svg {...p} width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 4l-6 6 6 6" /></svg>
  ),
}

function StatusDot({ status, online = true }: { status: Row['status']; online?: boolean }) {
  if (!online) return <span title="supervisor offline" className="inline-block w-2.5 h-2.5 rounded-full bg-gray-500" />
  const map: Record<Row['status'], { cls: string; label: string }> = {
    running: { cls: 'bg-emerald-400', label: 'running' },
    starting: { cls: 'bg-amber-400', label: 'starting' },
    error: { cls: 'bg-red-400', label: 'error' },
    idle: { cls: 'bg-gray-500', label: 'idle' },
  }
  const m = map[status]
  return <span title={m.label} className={`inline-block w-2.5 h-2.5 rounded-full ${m.cls}`} />
}

export function SupervisorPage({ token, onBack, embedded = false }: Props) {
  const [supervisors, setSupervisors] = useState<Supervisor[]>([])
  const [activeSupervisorId, setActiveSupervisorId] = useState<string | null>(null)
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([])
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>([])
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>([])
  const [githubConfigured, setGithubConfigured] = useState(false)
  const [installations, setInstallations] = useState<any[]>([])
  const [selectedInstallationId, setSelectedInstallationId] = useState<number | 'all'>('all')
  const [scanning, setScanning] = useState(false)
  const [filter, setFilter] = useState<FilterKey>(() => {
    try {
      const v = localStorage.getItem(FILTER_LS_KEY)
      if (v === 'all' || v === 'running' || v === 'idle') return v
    } catch {}
    return 'all'
  })
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('seen')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const { sessions } = useSessions(token)
  const lastActivityByPath = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of sessions) {
      if (!s.project_dir || !s.last_activity) continue
      m.set(s.project_dir, Date.parse(s.last_activity))
    }
    return m
  }, [sessions])
  const [startTarget, setStartTarget] = useState<{ kind: 'local'; repo: LocalRepo } | { kind: 'github'; repo: GitHubRepo } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [refreshingGh, setRefreshingGh] = useState(false)

  const activeSupervisor = supervisors.find((s) => s.id === activeSupervisorId)

  useEffect(() => {
    try { localStorage.setItem(FILTER_LS_KEY, filter) } catch {}
  }, [filter])

  const loadSupervisors = useCallback(async () => {
    const r = await apiFetch(token, '/api/supervisors')
    if (!r.ok) return
    const data = await r.json()
    setSupervisors(data.supervisors || [])
    if (!activeSupervisorId && data.supervisors?.[0]) setActiveSupervisorId(data.supervisors[0].id)
  }, [token, activeSupervisorId])

  const loadGitHub = useCallback(async () => {
    setRefreshingGh(true)
    try {
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
    } finally { setRefreshingGh(false) }
  }, [token])

  const scan = useCallback(async () => {
    if (!activeSupervisorId) return
    setScanning(true); setError(null)
    try {
      const r = await apiFetch(token, `/api/supervisors/${activeSupervisorId}/scan`, { method: 'POST' })
      if (!r.ok) { setError((await r.json()).error || 'scan failed'); return }
      const data = await r.json()
      setLocalRepos(data.repos || [])
    } catch (e: any) { setError(e.message) }
    finally { setScanning(false) }
  }, [token, activeSupervisorId])

  const loadActiveRuns = useCallback(async () => {
    if (!activeSupervisorId) { setActiveRuns([]); return }
    const r = await apiFetch(token, `/api/supervisors/${activeSupervisorId}/active`)
    if (r.ok) {
      const d = await r.json()
      setActiveRuns(d.runs || [])
    }
  }, [token, activeSupervisorId])

  useEffect(() => {
    loadSupervisors()
    loadGitHub()
    const onFocus = () => { loadGitHub() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  useEffect(() => { if (activeSupervisorId && activeSupervisor?.online) scan() }, [activeSupervisorId])
  useEffect(() => { loadActiveRuns() }, [loadActiveRuns])
  useEffect(() => { const t = setInterval(loadSupervisors, 10_000); return () => clearInterval(t) }, [loadSupervisors])
  useEffect(() => { const t = setInterval(loadActiveRuns, 5_000); return () => clearInterval(t) }, [loadActiveRuns])

  const stopRun = async (runId: string) => {
    if (!activeSupervisorId) return
    await apiFetch(token, `/api/supervisors/${activeSupervisorId}/stop`, { method: 'POST', body: JSON.stringify({ reason: 'user', run_id: runId }) })
    loadActiveRuns()
  }

  const connectGitHub = async () => {
    const r = await apiFetch(token, '/api/github/install_url')
    if (!r.ok) { setError('GitHub App not configured on hub'); return }
    const data = await r.json()
    window.location.href = data.url
  }

  // Build unified row set
  const rows: Row[] = useMemo(() => {
    const out: Row[] = []
    const seen = new Set<string>()

    // helper: locate run by repo_path
    const runByPath = (p: string | null | undefined) => activeRuns.find((r) => r.repo_path === p)
    // helper: locate run by github full_name (matches via repo_path basename or local mapping)
    const runByLocal = (l: LocalRepo | undefined) => (l ? runByPath(l.path) : undefined)

    const ghFiltered = selectedInstallationId === 'all'
      ? githubRepos
      : githubRepos.filter((g) => g.installation_id === selectedInstallationId)

    // 1) Locals (always shown if scanned)
    for (const l of localRepos) {
      const matchedGh = githubRepos.find((g) => l.remote?.includes(g.full_name))
      // installation filter: if user picked one and local has matched gh from another install, hide
      if (selectedInstallationId !== 'all' && matchedGh && matchedGh.installation_id !== selectedInstallationId) continue
      // if installation filter is set and local has no matched gh, still show (it's local-only)
      const run = runByLocal(l)
      const key = `local:${l.path}`
      seen.add(key)
      if (matchedGh) seen.add(`gh:${matchedGh.full_name}`)
      const status: Row['status'] = run ? 'running' : 'idle'
      // last activity = latest of: active run start, session last_activity (from chat history)
      const sessionLast = lastActivityByPath.get(l.path) || 0
      const runStart = run ? Date.parse(run.started_at) : 0
      const lastSeen = Math.max(sessionLast, runStart)
      out.push({
        key,
        name: matchedGh?.full_name || l.name,
        fullName: matchedGh?.full_name || l.name,
        branch: run?.branch || l.branch,
        path: l.path,
        dirty: l.dirty,
        hasLocal: true,
        hasGithub: !!matchedGh,
        github: matchedGh,
        local: l,
        run,
        status,
        lastSeen,
      })
    }

    // 2) GitHub-only (not cloned locally)
    for (const g of ghFiltered) {
      const key = `gh:${g.full_name}`
      if (seen.has(key)) continue
      out.push({
        key,
        name: g.full_name,
        fullName: g.full_name,
        branch: g.default_branch,
        path: null,
        dirty: false,
        hasLocal: false,
        hasGithub: true,
        github: g,
        status: 'idle',
        lastSeen: 0,
      })
    }

    // Search
    const q = search.toLowerCase().trim()
    let filtered = q ? out.filter((r) => r.name.toLowerCase().includes(q) || (r.path || '').toLowerCase().includes(q)) : out

    // Filter chip
    if (filter === 'running') filtered = filtered.filter((r) => r.status === 'running')
    else if (filter === 'idle') filtered = filtered.filter((r) => r.status !== 'running')

    // Sort
    const dir = sortDir === 'asc' ? 1 : -1
    filtered = [...filtered].sort((a, b) => {
      if (sortKey === 'status') {
        // running first by default (asc = running first)
        const rank = (r: Row) => (r.status === 'running' ? 0 : r.status === 'starting' ? 1 : r.status === 'error' ? 2 : 3)
        const diff = rank(a) - rank(b)
        if (diff !== 0) return diff * dir
        return b.lastSeen - a.lastSeen
      }
      if (sortKey === 'repo') return a.name.localeCompare(b.name) * dir
      if (sortKey === 'seen') return (b.lastSeen - a.lastSeen) * dir
      return 0
    })

    return filtered
  }, [localRepos, githubRepos, activeRuns, selectedInstallationId, search, filter, sortKey, sortDir, lastActivityByPath])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'seen' ? 'desc' : 'asc') }
  }

  const handleRowClick = (row: Row) => {
    if (row.run) {
      // open chat for run — no wiring yet; surface info
      setInfo(`Chat for ${row.name} — session ${row.run.id.slice(0, 8)}`)
      setTimeout(() => setInfo(null), 2500)
    }
  }

  const startRow = (row: Row) => {
    if (row.local) setStartTarget({ kind: 'local', repo: row.local })
    else if (row.github) setStartTarget({ kind: 'github', repo: row.github })
  }

  const body = (
    <div className="space-y-4 w-full">
      {error && <div className="px-3 py-2 bg-red-900/30 rounded-lg text-sm text-red-200">{error}</div>}
      {info && <div className="px-3 py-2 bg-emerald-900/30 rounded-lg text-sm text-emerald-200">{info}</div>}

      {/* Supervisor selector row */}
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-3">
        {supervisors.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)] p-2">
            No supervisor registered. Run on the machine you want to control:
            <code className="block mt-2 p-2 bg-[var(--code-bg)] rounded text-xs text-indigo-300 font-mono">
              npx remo-code-supervisor install --api-key &lt;your_api_key&gt; --roots "C:\Users\you\GitHub"
            </code>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-muted)] px-1">Machine:</span>
            <select
              value={activeSupervisorId || ''}
              onChange={(e) => setActiveSupervisorId(e.target.value)}
              className="px-2 py-1 text-sm bg-[var(--bg-tertiary)]/60 rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
            >
              {supervisors.map((s) => (
                <option key={s.id} value={s.id}>{s.hostname} · {s.online ? s.state : 'offline'} · v{s.version || '?'}</option>
              ))}
            </select>
            {githubConfigured && installations.length > 0 && (
              <>
                <span className="text-xs text-[var(--text-muted)] px-1">Install:</span>
                <select
                  value={String(selectedInstallationId)}
                  onChange={(e) => setSelectedInstallationId(e.target.value === 'all' ? 'all' : Number(e.target.value))}
                  className="px-2 py-1 text-sm bg-[var(--bg-tertiary)]/60 rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-indigo-500/50"
                >
                  <option value="all">All ({installations.length})</option>
                  {installations.map((i: any) => (
                    <option key={i.installation_id || i.id} value={i.installation_id || i.id}>{i.account || i.account_login || `#${i.installation_id || i.id}`}</option>
                  ))}
                </select>
                <button onClick={connectGitHub} className="px-2 py-1 text-xs rounded-lg text-[var(--text-secondary)] bg-[var(--bg-tertiary)]/60 hover:bg-[var(--bg-tertiary)]">Add installation</button>
              </>
            )}
            {githubConfigured && installations.length === 0 && (
              <button onClick={connectGitHub} className="px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white">Connect GitHub</button>
            )}
            {!githubConfigured && (
              <span className="text-xs text-amber-400">GitHub App not configured on hub</span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {activeRuns.length > 0 && (
                <span className="text-xs text-emerald-400">{activeRuns.length} running</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Repos table */}
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2.5 border-b border-[var(--border-color)]/40">
          <div className="flex items-center gap-1">
            {(['all', 'running', 'idle'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${filter === f ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'}`}
              >
                {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Idle'}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repos…"
            className="flex-1 min-w-[160px] px-3 py-1.5 text-sm bg-[var(--bg-tertiary)]/40 rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:bg-[var(--bg-tertiary)]/60 focus:ring-1 focus:ring-indigo-500/50"
          />
          <button
            onClick={() => { loadGitHub(); scan() }}
            disabled={refreshingGh || scanning}
            title="Refresh repos"
            aria-label="Refresh repos"
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 disabled:opacity-50"
          >
            <Icon.Refresh className={refreshingGh || scanning ? 'animate-spin' : ''} />
          </button>
        </div>

        {/* Table — desktop */}
        <div className="hidden md:block">
          <div className="grid grid-cols-[28px_minmax(0,2.2fr)_minmax(0,2fr)_minmax(0,1fr)_auto] gap-3 px-3 py-2 text-[11px] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-color)]/40">
            <button onClick={() => toggleSort('status')} className="flex items-center gap-1 hover:text-[var(--text-secondary)] text-left">
              <span aria-hidden>•</span>
            </button>
            <button onClick={() => toggleSort('repo')} className="flex items-center gap-1 hover:text-[var(--text-secondary)] text-left">
              Repo <Icon.ChevronUpDown />
            </button>
            <div>Path</div>
            <button onClick={() => toggleSort('seen')} className="flex items-center gap-1 hover:text-[var(--text-secondary)] text-left">
              Last seen <Icon.ChevronUpDown />
            </button>
            <div className="text-right pr-1">Actions</div>
          </div>
          {rows.length === 0 ? (
            <EmptyState onClear={() => { setSearch(''); setFilter('all') }} />
          ) : (
            <div className="divide-y divide-[var(--border-color)]/30">
              {rows.map((row) => (
                <div
                  key={row.key}
                  onClick={() => handleRowClick(row)}
                  className={`grid grid-cols-[28px_minmax(0,2.2fr)_minmax(0,2fr)_minmax(0,1fr)_auto] gap-3 items-center px-3 py-2.5 hover:bg-[var(--bg-tertiary)]/40 ${row.run ? 'cursor-pointer' : ''}`}
                >
                  <div><StatusDot status={row.status} online={!!activeSupervisor?.online} /></div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-[var(--text-primary)] truncate">{row.name}</div>
                    <div className="text-xs text-[var(--text-muted)] truncate">
                      {row.branch || 'default branch'}
                      {row.dirty && <span className="text-amber-400"> · dirty</span>}
                      {row.hasGithub && !row.hasLocal && <span> · not cloned</span>}
                      {!row.hasGithub && row.hasLocal && <span> · local only</span>}
                    </div>
                  </div>
                  <div className="min-w-0 text-xs text-[var(--text-muted)] font-mono truncate" title={row.path || ''}>
                    {row.path ? truncateMiddle(row.path, 60) : <span className="italic">—</span>}
                  </div>
                  <div className="text-xs text-[var(--text-muted)]">
                    {row.lastSeen > 0 ? timeAgo(row.lastSeen) : <span className="opacity-60">—</span>}
                  </div>
                  <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                    <RowActions row={row} online={!!activeSupervisor?.online} onStart={() => startRow(row)} onStop={() => row.run && stopRun(row.run.id)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Mobile card list */}
        <div className="md:hidden">
          {rows.length === 0 ? (
            <EmptyState onClear={() => { setSearch(''); setFilter('all') }} />
          ) : (
            <div className="divide-y divide-[var(--border-color)]/30">
              {rows.map((row) => (
                <div key={row.key} onClick={() => handleRowClick(row)} className={`px-3 py-2.5 ${row.run ? 'cursor-pointer' : ''} hover:bg-[var(--bg-tertiary)]/40`}>
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusDot status={row.status} online={!!activeSupervisor?.online} />
                    <div className="text-sm font-medium text-[var(--text-primary)] truncate flex-1">{row.name}</div>
                    {row.run && <span className="text-xs text-emerald-400 shrink-0">{timeAgo(Date.parse(row.run.started_at))}</span>}
                  </div>
                  <div className="mt-1 text-xs text-[var(--text-muted)] truncate">
                    {row.branch || 'default'}{row.dirty && <span className="text-amber-400"> · dirty</span>}
                    {row.path && <span className="font-mono"> · {truncateMiddle(row.path, 40)}</span>}
                  </div>
                  <div className="mt-2 flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <RowActions row={row} online={!!activeSupervisor?.online} onStart={() => startRow(row)} onStop={() => row.run && stopRun(row.run.id)} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {startTarget && activeSupervisor && (
        <StartDialog
          token={token}
          supervisorId={activeSupervisor.id}
          target={startTarget}
          onClose={() => setStartTarget(null)}
          onStarted={(runId) => { setStartTarget(null); setInfo(`Started run ${runId.slice(0, 8)}`); setTimeout(() => setInfo(null), 4000); loadSupervisors(); loadActiveRuns() }}
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
            <Icon.Back />
          </button>
        )}
        <h2 className="text-sm font-semibold text-[var(--text-secondary)]">Supervisor</h2>
      </header>
      <div className="flex-1 overflow-y-auto">
        <div className="w-full px-4 sm:px-6 lg:px-8 py-4 sm:py-6">
          {body}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onClear }: { onClear: () => void }) {
  return (
    <div className="px-3 py-8 text-center text-sm text-[var(--text-muted)]">
      No repos match. <button onClick={onClear} className="text-indigo-400 hover:text-indigo-300 underline-offset-2 hover:underline">Clear filter</button>
    </div>
  )
}

function IconBtn({ onClick, disabled, title, tone = 'muted', children }: { onClick?: () => void; disabled?: boolean; title: string; tone?: 'muted' | 'accent' | 'danger'; children: React.ReactNode }) {
  const toneCls =
    tone === 'danger' ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10' :
    tone === 'accent' ? 'text-indigo-300 hover:text-indigo-200 hover:bg-indigo-500/10' :
    'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60'
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={title} className={`p-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${toneCls}`}>{children}</button>
  )
}

function RowActions({ row, online, onStart, onStop }: { row: Row; online: boolean; onStart: () => void; onStop: () => void }) {
  return (
    <>
      {row.run ? (
        <>
          <IconBtn title="Open chat" tone="accent" onClick={() => { /* row click handles */ }}><Icon.Open /></IconBtn>
          <IconBtn title="Stop session" tone="danger" onClick={onStop}><Icon.Stop /></IconBtn>
        </>
      ) : (
        <IconBtn title={row.hasLocal ? 'Start session' : 'Clone & start'} tone="accent" disabled={!online} onClick={onStart}><Icon.Play /></IconBtn>
      )}
    </>
  )
}

interface StartDialogProps {
  token: string
  supervisorId: string
  target: { kind: 'local'; repo: LocalRepo } | { kind: 'github'; repo: GitHubRepo }
  onClose: () => void
  onStarted: (runId: string) => void
  onError: (msg: string) => void
}

function StartDialog(props: StartDialogProps) {
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
      <div className="w-full max-w-md bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-xl p-6 shadow-xl">
        <h3 className="text-base font-semibold text-[var(--text-primary)] mb-4">
          Start in {localRepo?.name || githubRepo?.name}
        </h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Branch</label>
            {branches.length > 0 ? (
              <select value={branch} onChange={(e) => setBranch(e.target.value)} className="w-full px-3 py-2 bg-[var(--bg-tertiary)]/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500/50 text-sm text-[var(--text-primary)]">
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            ) : (
              <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" className="w-full px-3 py-2 bg-[var(--bg-tertiary)]/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500/50 text-sm text-[var(--text-primary)]" />
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />
            git pull before starting {localRepo?.dirty && <span className="text-amber-400 text-xs">(disabled: dirty)</span>}
          </label>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Initial prompt (optional)</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="What should Claude work on?" className="w-full px-3 py-2 bg-[var(--bg-tertiary)]/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-500/50 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)]" />
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

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useSessions } from '../hooks/useSessions'
import { useSupervisors } from '../hooks/useSupervisors'
import { useWebSocketContext } from '../hooks/useWebSocket'
import { Modal, Button } from './ui'
import { SessionActionButton } from './SessionActionButton'
import { isWorktreeOrNonCanonicalRepo } from '../lib/session-list'

type OrchestratorSnapshot = {
  enabled: boolean
  name: string
  custom_instructions: string | null
  session_id: string | null
  status: 'disabled' | 'enabled_idle' | 'running'
}

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
  // Worktree introspection (optional — absent on the legacy scan shape).
  // When present, worktree entries are hidden from the list so only the
  // canonical repo shows. Missing → treated as a canonical, non-worktree repo.
  is_worktree?: boolean
  is_canonical?: boolean
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
type TypeFilter = 'all' | 'repos' | 'folders'
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
const TYPE_FILTER_LS_KEY = 'remo:repos-type-filter'
const LOCAL_REPOS_LS_KEY = 'remo:local-repos'
const GITHUB_REPOS_LS_KEY = 'remo:github-repos'

function apiFetch(token: string, path: string, init?: RequestInit) {
  // Read csrf_token cookie (double-submit) and attach to mutating requests.
  let csrf: string | null = null
  if (typeof document !== 'undefined') {
    for (const part of (document.cookie || '').split(';')) {
      const c = part.trim()
      if (c.startsWith('csrf_token=')) { csrf = decodeURIComponent(c.slice('csrf_token='.length)); break }
    }
  }
  const method = (init?.method || 'GET').toUpperCase()
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE'
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...((init?.headers || {}) as Record<string, string>),
  }
  if (mutating && csrf) headers['X-CSRF-Token'] = csrf
  return fetch(`${hubUrl}${path}`, {
    ...init,
    headers,
    credentials: 'include',
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
  Github: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 .25a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8.25 8 8 0 0 0 8 .25z" /></svg>
  ),
  Folder: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M1.5 4a1 1 0 0 1 1-1h3l1.5 1.5H13.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" /></svg>
  ),
  // Orchestrator marker — a "sparkle/hub" glyph distinct from repo/folder.
  Orchestrator: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 2l1.6 4.4L16 8l-4.4 1.6L10 14l-1.6-4.4L4 8l4.4-1.6L10 2z" /><circle cx="15.5" cy="14.5" r="1.4" /><circle cx="4.5" cy="14.5" r="1.4" /></svg>
  ),
  Power: (p: any) => (
    <svg {...p} width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3v6" /><path d="M5.5 5.5a6 6 0 1 0 9 0" /></svg>
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
  const { subscribe, connectionId } = useWebSocketContext()
  const { supervisors: supervisorsRaw } = useSupervisors(token, subscribe, connectionId)
  const supervisors: Supervisor[] = useMemo(
    () =>
      (supervisorsRaw || []).map((r) => ({
        id: r.id,
        hostname: r.hostname || '',
        version: r.version,
        os: r.os,
        roots: r.roots || [],
        state: r.state,
        current_run_id: r.current_run_id,
        last_seen_at: r.last_seen_at || '',
        online: r.online,
      })),
    [supervisorsRaw],
  )
  const [activeSupervisorId, setActiveSupervisorId] = useState<string | null>(null)
  const [activeRuns, setActiveRuns] = useState<ActiveRun[]>([])
  const [localRepos, setLocalRepos] = useState<LocalRepo[]>(() => {
    try { const v = localStorage.getItem(LOCAL_REPOS_LS_KEY); if (v) return JSON.parse(v) } catch {}
    return []
  })
  const [githubRepos, setGithubRepos] = useState<GitHubRepo[]>(() => {
    try { const v = localStorage.getItem(GITHUB_REPOS_LS_KEY); if (v) return JSON.parse(v) } catch {}
    return []
  })
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
  const [typeFilter, setTypeFilter] = useState<TypeFilter>(() => {
    try {
      const v = localStorage.getItem(TYPE_FILTER_LS_KEY)
      if (v === 'all' || v === 'repos' || v === 'folders') return v
    } catch {}
    return 'all'
  })
  const [search, setSearch] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('repo')
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const { sessions } = useSessions(token, subscribe, connectionId)
  const lastActivityByPath = useMemo(() => {
    const m = new Map<string, number>()
    // Guard: `sessions` is set from a fetch body in useSessions; a non-array
    // 200 body would make `for…of` throw `sessions is not iterable` and crash
    // the settings:connections ErrorBoundary. Coerce defensively.
    for (const s of (Array.isArray(sessions) ? sessions : [])) {
      if (!s.project_dir || !s.last_activity) continue
      m.set(s.project_dir, Date.parse(s.last_activity))
    }
    return m
  }, [sessions])
  const [startTarget, setStartTarget] = useState<
    | { kind: 'local'; repo: LocalRepo; githubFallback?: GitHubRepo }
    | { kind: 'github'; repo: GitHubRepo }
    | null
  >(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [refreshingGh, setRefreshingGh] = useState(false)
  // Batch-launch selection: set of Row.key for checked repos.
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [launchingAll, setLaunchingAll] = useState(false)

  const activeSupervisor = supervisors.find((s) => s.id === activeSupervisorId)

  // ── Orchestrator (Phase 09): logic ported from the retired OrchestratorTab.
  // Its root folder = the active supervisor's roots[0]; controls live in the
  // pinned top row of the repo table.
  const orch = useOrchestrator(token)
  const orchRoot = activeSupervisor?.roots?.[0] || null

  useEffect(() => {
    try { localStorage.setItem(FILTER_LS_KEY, filter) } catch {}
  }, [filter])

  useEffect(() => {
    try { localStorage.setItem(TYPE_FILTER_LS_KEY, typeFilter) } catch {}
  }, [typeFilter])

  useEffect(() => {
    try { localStorage.setItem(LOCAL_REPOS_LS_KEY, JSON.stringify(localRepos)) } catch {}
  }, [localRepos])

  useEffect(() => {
    try { localStorage.setItem(GITHUB_REPOS_LS_KEY, JSON.stringify(githubRepos)) } catch {}
  }, [githubRepos])

  // Auto-select the first supervisor once useSupervisors() resolves.
  useEffect(() => {
    if (!activeSupervisorId && supervisors.length > 0) {
      setActiveSupervisorId(supervisors[0].id)
    }
  }, [activeSupervisorId, supervisors])

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
    loadGitHub()
    const onFocus = () => { loadGitHub() }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [])
  useEffect(() => { if (activeSupervisorId && activeSupervisor?.online) scan() }, [activeSupervisorId])
  useEffect(() => { loadActiveRuns() }, [loadActiveRuns])
  // supervisor list polling removed — useSupervisors() is WS-reactive.
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

    // Dedupe githubRepos by full_name — the same repo can be visible through
    // multiple installations (personal + org with overlapping access), which
    // is how the page was ballooning to 800+ rows. Keep the first occurrence;
    // the installation filter still works because ghDeduped preserves
    // installation_id from whichever entry won.
    const ghByName = new Map<string, GitHubRepo>()
    for (const g of githubRepos) {
      if (!ghByName.has(g.full_name)) ghByName.set(g.full_name, g)
    }
    const ghDeduped = Array.from(ghByName.values())

    // Dedupe localRepos by canonical path (lower-case on Windows). The scanner
    // already dedupes per-scan, but cached localStorage state from older
    // sessions plus a fresh scan can collide if roots overlap.
    const localByPath = new Map<string, LocalRepo>()
    for (const l of localRepos) {
      const k = l.path.replace(/\\/g, '/').toLowerCase()
      if (!localByPath.has(k)) localByPath.set(k, l)
    }
    const localDeduped = Array.from(localByPath.values())

    const ghFiltered = selectedInstallationId === 'all'
      ? ghDeduped
      : ghDeduped.filter((g) => g.installation_id === selectedInstallationId)

    // 1) Locals (always shown if scanned)
    for (const l of localDeduped) {
      // Feature 1 — hide git worktrees / branch-checkout siblings; only the
      // canonical repo appears in the list. Fields are optional on the legacy
      // scan shape, so absent → treat as a canonical repo (show it).
      if (isWorktreeOrNonCanonicalRepo(l)) continue
      const matchedGh = ghDeduped.find((g) => l.remote?.includes(g.full_name))
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
      seen.add(key)
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

    // Type filter: repos = GitHub-keyed, folders = local-only
    if (typeFilter === 'repos') filtered = filtered.filter((r) => r.hasGithub)
    else if (typeFilter === 'folders') filtered = filtered.filter((r) => !r.hasGithub)

    // Sort: connected (local) repos always on top, then by chosen key
    const dir = sortDir === 'asc' ? 1 : -1
    filtered = [...filtered].sort((a, b) => {
      if (a.hasLocal !== b.hasLocal) return a.hasLocal ? -1 : 1
      if (sortKey === 'status') {
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
  }, [localRepos, githubRepos, activeRuns, selectedInstallationId, search, filter, typeFilter, sortKey, sortDir, lastActivityByPath])

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
    if (row.local) setStartTarget({ kind: 'local', repo: row.local, githubFallback: row.github })
    else if (row.github) setStartTarget({ kind: 'github', repo: row.github })
  }

  // Batch launch is only offered for rows that already have a local path —
  // those launch directly via /start with no clone-target decision. GitHub-only
  // rows (need a clone first) are not batch-selectable.
  const launchableRows = useMemo(
    () => rows.filter((r) => r.local && r.status !== 'running'),
    [rows],
  )
  const launchableKeys = useMemo(() => new Set(launchableRows.map((r) => r.key)), [launchableRows])

  // Drop stale selections (e.g. a repo that started running or got filtered out).
  useEffect(() => {
    setSelected((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const k of prev) { if (launchableKeys.has(k)) next.add(k); else changed = true }
      return changed ? next : prev
    })
  }, [launchableKeys])

  const toggleSelect = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      return next
    })
  }

  const allSelected = launchableRows.length > 0 && launchableRows.every((r) => selected.has(r.key))
  const toggleSelectAll = () => {
    setSelected(allSelected ? new Set() : new Set(launchableRows.map((r) => r.key)))
  }

  // Launch a session for each selected repo. Sequential-with-await on purpose:
  // the supervisor enforces a local concurrency cap and rejects bursts with
  // `concurrency_cap`, so we let each /start settle before the next.
  const launchSelected = async () => {
    if (!activeSupervisorId || launchingAll) return
    const targets = launchableRows.filter((r) => selected.has(r.key))
    if (targets.length === 0) return
    setLaunchingAll(true)
    let ok = 0
    let failed = 0
    try {
      for (const row of targets) {
        const repoPath = row.local?.path
        if (!repoPath) { failed++; continue }
        try {
          const r = await apiFetch(token, `/api/supervisors/${activeSupervisorId}/start`, {
            method: 'POST',
            body: JSON.stringify({
              repo_path: repoPath,
              branch: row.local?.branch || undefined,
              // Don't pull a dirty tree — supervisor refuses it anyway.
              pull: !row.local?.dirty,
            }),
          })
          if (r.ok) ok++; else failed++
        } catch { failed++ }
      }
      setSelected(new Set())
      await loadActiveRuns()
      setInfo(`Launched ${ok} session${ok === 1 ? '' : 's'}${failed ? ` · ${failed} failed` : ''}`)
      setTimeout(() => setInfo(null), 5000)
    } finally {
      setLaunchingAll(false)
    }
  }

  const body = (
    <div className="space-y-3 w-full">
      {error && <div className="px-3 py-2 bg-red-900/30 rounded-lg text-sm text-red-200">{error}</div>}
      {info && <div className="px-3 py-2 bg-emerald-900/30 rounded-lg text-sm text-emerald-200">{info}</div>}

      {/* Supervisor selector row */}
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-2.5">
        {supervisors.length === 0 ? (
          <div className="text-sm text-[var(--text-muted)] p-2">
            No supervisor registered. Install the Remo Code tray app on the Windows machine you want to control:
            <a
              href="https://github.com/finedesignz/remo-code/releases/latest"
              target="_blank"
              rel="noreferrer"
              className="block mt-2 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-xs text-[var(--text-on-accent)] font-medium text-center transition-colors"
            >
              Download .msi from GitHub Releases &rarr;
            </a>
            <p className="text-[10px] text-[var(--text-muted)] mt-2">
              Paste your API key into the first-run wizard. The tray app starts on boot and connects automatically.
            </p>
          </div>
        ) : (
          <>
            {activeSupervisor && !activeSupervisor.online && (
              <div className="mb-3 p-3 rounded-lg bg-amber-500/15 ring-1 ring-amber-500/40 text-[var(--text-primary)] text-sm">
                <div className="font-semibold flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-amber-500" />
                  Supervisor offline
                </div>
                <div className="text-xs text-[var(--text-secondary)] mt-1">
                  {activeSupervisor.hostname} hasn't checked in since {activeSupervisor.last_seen_at ? new Date(activeSupervisor.last_seen_at).toLocaleString() : 'never'}.
                  The supervisor reconnects automatically with exponential backoff (capped at 60s). Active sessions auto-resume on the next successful reconnect.
                </div>
              </div>
            )}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-[var(--text-muted)] px-1">Machine:</span>
            <select
              value={activeSupervisorId || ''}
              onChange={(e) => setActiveSupervisorId(e.target.value)}
              className="px-2 py-1 text-sm bg-[var(--bg-tertiary)]/60 rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
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
                  className="px-2 py-1 text-sm bg-[var(--bg-tertiary)]/60 rounded-lg text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-blue-500/50"
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
              <button onClick={connectGitHub} className="px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 rounded-lg text-[var(--text-on-accent)]">Connect GitHub</button>
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
          </>
        )}
      </div>

      {/* Repos table */}
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--border-color)]/40">
          <div className="flex items-center gap-1">
            {(['all', 'running', 'idle'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${filter === f ? 'bg-blue-600/20 ring-1 ring-blue-500/30 text-blue-300' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'}`}
              >
                {f === 'all' ? 'All' : f === 'running' ? 'Running' : 'Idle'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {(['all', 'repos', 'folders'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${typeFilter === t ? 'bg-blue-600/20 ring-1 ring-blue-500/30 text-blue-300' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40'}`}
              >
                {t === 'all' ? 'All' : t === 'repos' ? 'Repos' : 'Folders'}
              </button>
            ))}
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search repos…"
            className="flex-1 min-w-[160px] px-3 py-1.5 text-sm bg-[var(--bg-tertiary)]/40 rounded-lg text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:bg-[var(--bg-tertiary)]/60 focus:ring-1 focus:ring-blue-500/50"
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
          <button
            onClick={launchSelected}
            disabled={selected.size === 0 || launchingAll || !activeSupervisor?.online}
            className="px-2.5 py-1 text-xs font-medium rounded-lg bg-blue-600 hover:bg-blue-500 text-[var(--text-on-accent)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {launchingAll ? 'Launching…' : `Launch selected${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>

        {/* Header (single responsive renderer; sort controls only matter on wider widths) */}
        <div className="hidden sm:flex items-center gap-3 px-3 py-2 text-[11px] uppercase tracking-wider text-[var(--text-muted)] border-b border-[var(--border-color)]/40">
          <input
            type="checkbox"
            checked={allSelected}
            ref={(el) => { if (el) el.indeterminate = !allSelected && selected.size > 0 }}
            onChange={toggleSelectAll}
            disabled={launchableRows.length === 0}
            aria-label="Select all repos"
            title="Select all"
            className="w-3.5 h-3.5 shrink-0 accent-blue-600 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
          />
          <span className="w-3 shrink-0" aria-hidden>•</span>
          <button onClick={() => toggleSort('repo')} className="flex items-center gap-1 hover:text-[var(--text-secondary)] text-left flex-1 min-w-0">
            Repo <Icon.ChevronUpDown />
          </button>
          <button onClick={() => toggleSort('seen')} className="hidden md:flex items-center gap-1 hover:text-[var(--text-secondary)] text-left w-24 shrink-0">
            Last seen <Icon.ChevronUpDown />
          </button>
          <span className="w-20 shrink-0 text-right pr-1">Actions</span>
        </div>

        {/* Rows — single renderer for every width. Pinned orchestrator row first. */}
        <div className="divide-y divide-[var(--border-color)]/40">
          <OrchestratorRow
            orch={orch}
            online={!!activeSupervisor?.online}
            rootPath={orchRoot}
            hasSupervisor={supervisors.length > 0}
          />
          {rows.length === 0 ? (
            <EmptyState onClear={() => { setSearch(''); setFilter('all') }} />
          ) : (
            rows.map((row) => (
              <RepoRow
                key={row.key}
                row={row}
                online={!!activeSupervisor?.online}
                selectable={launchableKeys.has(row.key)}
                selected={selected.has(row.key)}
                onToggleSelect={() => toggleSelect(row.key)}
                onRowClick={() => handleRowClick(row)}
                onStart={() => startRow(row)}
                onStop={() => row.run && stopRun(row.run.id)}
              />
            ))
          )}
        </div>
      </div>

      {startTarget && activeSupervisor && (
        <StartDialog
          token={token}
          supervisorId={activeSupervisor.id}
          target={startTarget}
          onClose={() => setStartTarget(null)}
          onStarted={(runId) => { setStartTarget(null); setInfo(`Started run ${runId.slice(0, 8)}`); setTimeout(() => setInfo(null), 4000); loadActiveRuns() }}
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
      No repos match. <button onClick={onClear} className="text-blue-400 hover:text-blue-300 underline-offset-2 hover:underline">Clear filter</button>
    </div>
  )
}

function IconBtn({ onClick, disabled, title, tone = 'muted', children }: { onClick?: () => void; disabled?: boolean; title: string; tone?: 'muted' | 'accent' | 'danger'; children: React.ReactNode }) {
  const toneCls =
    tone === 'danger' ? 'text-red-400 hover:text-red-300 hover:bg-red-500/10' :
    tone === 'accent' ? 'text-blue-300 hover:text-blue-200 hover:bg-blue-500/10' :
    'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60'
  return (
    <button onClick={onClick} disabled={disabled} title={title} aria-label={title} className={`p-2 md:p-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${toneCls}`}>{children}</button>
  )
}

function RowActions({ row, online, onStart, onStop }: { row: Row; online: boolean; onStart: () => void; onStop: () => void }) {
  return (
    <>
      {row.run ? (
        <>
          <IconBtn title="Open chat" tone="accent" onClick={() => { /* row click handles */ }}><Icon.Open /></IconBtn>
          <SessionActionButton kind="stop" onClick={onStop} />
        </>
      ) : (
        <SessionActionButton kind="play" label={row.hasLocal ? 'Start session' : 'Clone & start'} disabled={!online} onClick={onStart} />
      )}
    </>
  )
}

/* ─────────────────────────── Repo row (single responsive renderer) ─────────────────────────── */

function RepoRow({ row, online, selectable, selected, onToggleSelect, onRowClick, onStart, onStop }: {
  row: Row
  online: boolean
  selectable: boolean
  selected: boolean
  onToggleSelect: () => void
  onRowClick: () => void
  onStart: () => void
  onStop: () => void
}) {
  return (
    <div
      onClick={onRowClick}
      className={`flex items-center gap-3 px-3 py-2 hover:bg-[var(--bg-tertiary)]/40 ${row.run ? 'cursor-pointer' : ''}`}
    >
      <span className="w-3.5 shrink-0 flex justify-center" onClick={(e) => e.stopPropagation()}>
        {selectable ? (
          <input
            type="checkbox"
            checked={selected}
            onChange={onToggleSelect}
            aria-label={`Select ${row.name}`}
            className="w-3.5 h-3.5 accent-blue-600 cursor-pointer"
          />
        ) : (
          <span className="w-3.5 h-3.5" aria-hidden />
        )}
      </span>
      <span className="w-3 shrink-0 flex justify-center"><StatusDot status={row.status} online={online} /></span>
      {/* Metadata cell: name + icon, with branch · status · last-seen and the path as a truncated subline. */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {row.hasGithub
            ? <Icon.Github className="text-[var(--text-muted)] shrink-0" />
            : <Icon.Folder className="text-[var(--text-muted)] shrink-0" />}
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">{row.name}</span>
        </div>
        <div className="text-xs text-[var(--text-muted)] truncate">
          {row.branch || 'default branch'}
          {row.dirty && <span className="text-amber-400"> · dirty</span>}
          {row.hasGithub && !row.hasLocal && <span> · not cloned</span>}
          {/* Last-seen folds inline below sm where the dedicated column is hidden. */}
          {row.lastSeen > 0 && <span className="md:hidden"> · {timeAgo(row.lastSeen)}</span>}
          {row.path && <span className="font-mono"> · <span title={row.path}>{truncateMiddle(row.path, 48)}</span></span>}
        </div>
      </div>
      <span className="hidden md:block w-24 shrink-0 text-xs text-[var(--text-muted)] truncate">
        {row.lastSeen > 0 ? timeAgo(row.lastSeen) : <span className="opacity-60">—</span>}
      </span>
      <span className="w-20 shrink-0 flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
        <RowActions row={row} online={online} onStart={onStart} onStop={onStop} />
      </span>
    </div>
  )
}

/* ─────────────────────────── Orchestrator (pinned top row) ─────────────────────────── */

function useOrchestrator(token: string) {
  const [snap, setSnap] = useState<OrchestratorSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const call = useCallback(async (path: string, init?: RequestInit): Promise<OrchestratorSnapshot | null> => {
    const r = await apiFetch(token, path, init)
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status}`)
    return r.json().catch(() => null)
  }, [token])

  const refresh = useCallback(async () => {
    try {
      const r = await call('/api/orchestrator')
      if (aliveRef.current && r) setSnap(r)
    } catch (e: any) {
      if (aliveRef.current) setError(e?.message ?? 'load failed')
    }
  }, [call])

  useEffect(() => {
    aliveRef.current = true
    void refresh()
    const t = setInterval(() => { void refresh() }, 10_000)
    return () => { aliveRef.current = false; clearInterval(t) }
  }, [refresh])

  const action = useCallback(async (fn: () => Promise<any>) => {
    setBusy(true); setError(null)
    try { await fn(); await refresh() }
    catch (e: any) { if (aliveRef.current) setError(e?.message ?? 'action failed') }
    finally { if (aliveRef.current) setBusy(false) }
  }, [refresh])

  return {
    snap,
    busy,
    error,
    setEnabled: (enabled: boolean) => action(() => call('/api/orchestrator', { method: 'PUT', body: JSON.stringify({ enabled }) })),
    start: () => action(() => call('/api/orchestrator/start', { method: 'POST', body: JSON.stringify({}) })),
    stop: () => action(() => call('/api/orchestrator/stop', { method: 'POST', body: JSON.stringify({}) })),
  }
}

function OrchestratorRow({ orch, online, rootPath, hasSupervisor }: {
  orch: ReturnType<typeof useOrchestrator>
  online: boolean
  rootPath: string | null
  hasSupervisor: boolean
}) {
  const { snap, busy, error, setEnabled, start, stop } = orch
  const [showEnable, setShowEnable] = useState(false)
  const status = snap?.status ?? 'disabled'
  const dot =
    status === 'running' ? 'bg-emerald-400' : status === 'enabled_idle' ? 'bg-blue-400' : 'bg-gray-500'
  const statusLabel =
    status === 'running' ? 'running' : status === 'enabled_idle' ? 'idle' : 'disabled'

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-blue-600/5 hover:bg-blue-600/10">
      <span className="w-3.5 shrink-0" aria-hidden />
      <span className="w-3 shrink-0 flex justify-center">
        <span title={statusLabel} className={`inline-block w-2.5 h-2.5 rounded-full ${dot}`} />
      </span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon.Orchestrator className="text-blue-400 shrink-0" />
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">Orchestrator</span>
          <span className="shrink-0 rounded-full bg-blue-600/20 ring-1 ring-blue-500/30 text-blue-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{statusLabel}</span>
        </div>
        <div className="text-xs text-[var(--text-muted)] truncate">
          {rootPath
            ? <>Coordinates every session under <span className="font-mono" title={rootPath}>{truncateMiddle(rootPath, 48)}</span></>
            : 'Root folder — set in the supervisor first-run wizard'}
          {error && <span className="text-red-400"> · {error}</span>}
        </div>
      </div>
      <span className="hidden md:block w-24 shrink-0" />
      <span className="w-20 shrink-0 flex items-center justify-end gap-0.5">
        {!snap ? null : snap.enabled ? (
          <>
            {status === 'running'
              ? <SessionActionButton kind="stop" label="Stop orchestrator session" loading={busy} onClick={() => void stop()} />
              : <SessionActionButton kind="play" label="Start orchestrator session" disabled={busy || !online} onClick={() => void start()} />}
            <IconBtn title="Disable orchestrator" tone="muted" disabled={busy} onClick={() => void setEnabled(false)}><Icon.Power /></IconBtn>
          </>
        ) : (
          <IconBtn title="Enable orchestrator" tone="accent" disabled={busy || !hasSupervisor} onClick={() => setShowEnable(true)}><Icon.Power /></IconBtn>
        )}
      </span>

      <Modal
        open={showEnable}
        onClose={() => setShowEnable(false)}
        title="Enable orchestrator mode?"
        className="ring-red-500/40"
        footer={
          <>
            <Button variant="ghost" size="md" onClick={() => setShowEnable(false)}>Cancel</Button>
            <Button variant="danger" size="md" disabled={busy} onClick={() => { setShowEnable(false); void setEnabled(true) }}>Enable orchestrator</Button>
          </>
        }
      >
        <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
          Orchestrator mode gives one Claude session full access to <strong>every repo</strong> under your supervisor's root folder,
          plus a full-power hub API key that can read messages, start sessions, and dispatch tasks for your account.
          Only enable if you trust the system prompt and your machine is secure.
        </p>
      </Modal>
    </div>
  )
}

interface StartDialogProps {
  token: string
  supervisorId: string
  target:
    | { kind: 'local'; repo: LocalRepo; githubFallback?: GitHubRepo }
    | { kind: 'github'; repo: GitHubRepo }
  onClose: () => void
  onStarted: (runId: string) => void
  onError: (msg: string) => void
}

function StartDialog(props: StartDialogProps) {
  const { token, supervisorId, target, onClose, onStarted, onError } = props
  const localRepo = target.kind === 'local' ? target.repo : null
  const githubRepo = target.kind === 'github' ? target.repo : null
  const githubFallback = target.kind === 'local' ? target.githubFallback : null

  const [branch, setBranch] = useState<string>(localRepo?.branch || githubRepo?.default_branch || '')
  // Default ON so we always run from the latest committed state. User can opt out.
  const [pull, setPull] = useState(true)
  const [allowDirty, setAllowDirty] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [customBranch, setCustomBranch] = useState(false)

  useEffect(() => {
    let cancelled = false
    const setIfMounted = (list: string[], preferred?: string | null) => {
      if (cancelled) return
      setBranches(list)
      if (list.length) {
        setBranch((prev) => list.includes(prev) ? prev : (preferred && list.includes(preferred) ? preferred : list[0]))
      }
    }
    const fetchGithub = (repo: { owner: string; name: string; default_branch?: string }) =>
      apiFetch(token, `/api/github/repos/${repo.owner}/${repo.name}/branches`)
        .then((r) => r.ok ? r.json() : { branches: [] })
        .then((d) => {
          const list: string[] = d.branches?.map((b: any) => b.name) || []
          setIfMounted(list, repo.default_branch)
        })
        .catch(() => {})

    if (githubRepo) {
      fetchGithub(githubRepo)
    } else if (localRepo) {
      apiFetch(token, `/api/supervisors/${supervisorId}/branches?repo_path=${encodeURIComponent(localRepo.path)}`)
        .then((r) => r.ok ? r.json() : { branches: [] })
        .then((d) => {
          const list: string[] = d.branches || []
          if (list.length) {
            setIfMounted(list, d.current || localRepo.branch)
            return
          }
          // Supervisor returned no branches (older supervisor version pre-list_branches, or git error).
          // Fall back to GitHub branches when we have a matching installation — this restores the dropdown
          // for users on supervisor < 0.3.2.
          if (githubFallback) return fetchGithub(githubFallback)
        })
        .catch(() => {
          if (githubFallback) return fetchGithub(githubFallback)
        })
    }
    return () => { cancelled = true }
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
      // Supervisor refuses pull on a dirty repo, so don't even ask when user opted to start anyway.
      const effectivePull = pull && !localRepo?.dirty
      const r = await apiFetch(token, `/api/supervisors/${supervisorId}/start`, {
        method: 'POST',
        body: JSON.stringify({
          repo_path: repoPath,
          branch: branch || undefined,
          pull: effectivePull,
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
          {localRepo?.dirty && (
            <div className="rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30 p-3 text-xs text-amber-200 space-y-2">
              <div className="font-medium text-amber-100">Uncommitted changes detected</div>
              <p className="text-amber-200/80">
                This repo has local edits that haven't been committed. To run from the latest
                code state, commit or stash them first. Otherwise Claude will start on top of
                whatever's currently in the working tree.
              </p>
              <label className="flex items-center gap-2 text-amber-100 pt-1">
                <input
                  type="checkbox"
                  checked={allowDirty}
                  onChange={(e) => setAllowDirty(e.target.checked)}
                />
                Start anyway with uncommitted changes
              </label>
            </div>
          )}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Branch</label>
            {branches.length > 0 && !customBranch ? (
              <select
                value={branches.includes(branch) ? branch : branches[0]}
                onChange={(e) => {
                  if (e.target.value === '__custom__') { setCustomBranch(true); return }
                  setBranch(e.target.value)
                }}
                className="w-full px-3 py-2 bg-[var(--bg-tertiary)]/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 text-sm text-[var(--text-primary)]"
              >
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
                <option value="__custom__">Custom branch name…</option>
              </select>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder="main"
                  className="flex-1 px-3 py-2 bg-[var(--bg-tertiary)]/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 text-sm text-[var(--text-primary)]"
                />
                {branches.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCustomBranch(false)}
                    className="px-2 py-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40"
                  >
                    Pick from list
                  </button>
                )}
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={pull && !localRepo?.dirty}
              disabled={!!localRepo?.dirty}
              onChange={(e) => setPull(e.target.checked)}
            />
            git pull before starting {localRepo?.dirty && <span className="text-amber-400 text-xs">(disabled: dirty)</span>}
          </label>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Initial prompt (optional)</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={4} placeholder="What should Claude work on?" className="w-full px-3 py-2 bg-[var(--bg-tertiary)]/40 rounded-lg focus:outline-none focus:ring-1 focus:ring-blue-500/50 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)]" />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} disabled={busy} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 rounded-lg">Cancel</button>
          <button onClick={handleStart} disabled={busy || (!!localRepo?.dirty && !allowDirty)} className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-[var(--text-on-accent)]">
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </div>
      </div>
    </div>
  )
}

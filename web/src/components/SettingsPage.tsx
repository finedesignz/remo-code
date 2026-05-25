import { useState, useEffect, type ReactNode } from 'react'
import type { Profile } from '../hooks/useProfile'
import { useWebPushPermission } from '../hooks/useWebPushPermission'
import { useApiKey } from '../hooks/useApiKey'
import { useSessions, type AgentInfo, type CodeSession } from '../hooks/useSessions'
import { SupervisorPage } from './SupervisorPage'
import { CommandsList } from './CommandsList'
import { hubFetch } from '../lib/api'

interface Props {
  token: string
  profile: Profile
  onUpdateProfile: (data: {
    display_name?: string
    system_prompt?: string | null
    daily_cost_cap_usd?: number
    web_push_enabled?: boolean
    timezone?: string
  }) => Promise<any>
  onBack: () => void
}

type Tab = 'account' | 'supervisor' | 'apikey' | 'commands' | 'instructions'

function readTabFromHash(): Tab {
  const m = window.location.hash.match(/[?&]tab=([a-z]+)/)
  const v = m?.[1] as Tab | undefined
  if (v === 'account' || v === 'supervisor' || v === 'apikey' || v === 'commands' || v === 'instructions') return v
  return 'supervisor'
}

export function SettingsPage({ token, profile, onUpdateProfile, onBack }: Props) {
  const [tab, setTab] = useState<Tab>(readTabFromHash)
  const [displayName, setDisplayName] = useState(profile.display_name || '')
  const [systemPrompt, setSystemPrompt] = useState(profile.system_prompt || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [savingPrompt, setSavingPrompt] = useState(false)
  const [savedPrompt, setSavedPrompt] = useState(false)
  const [autoNudge, setAutoNudge] = useState<boolean>(() => {
    try { return localStorage.getItem('remo:auto-nudge') !== 'off' } catch { return true }
  })

  const toggleAutoNudge = () => {
    setAutoNudge(prev => {
      const next = !prev
      try { localStorage.setItem('remo:auto-nudge', next ? 'on' : 'off') } catch {}
      return next
    })
  }

  // Keep URL hash in sync with active tab (so refresh preserves it)
  useEffect(() => {
    const next = `#/settings?tab=${tab}`
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [tab])

  // Also react to external hash changes (e.g. clicking Connect in sidebar)
  useEffect(() => {
    const onHash = () => setTab(readTabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const tabs: { id: Tab; label: string; desc: string }[] = [
    { id: 'supervisor', label: 'Supervisor', desc: 'Connect repos & manage agents' },
    { id: 'commands', label: 'Commands', desc: 'Browse Claude slash commands & skills' },
    { id: 'account', label: 'Account', desc: 'Profile & system prompt' },
    { id: 'instructions', label: 'Instructions', desc: 'Per-CLI global instruction files synced to agents' },
    { id: 'apikey', label: 'API Key', desc: 'Agent authentication' },
  ]

  const handleSaveName = async () => {
    setSaving(true)
    await onUpdateProfile({ display_name: displayName })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleSavePrompt = async () => {
    setSavingPrompt(true)
    await onUpdateProfile({ system_prompt: systemPrompt })
    setSavingPrompt(false)
    setSavedPrompt(true)
    setTimeout(() => setSavedPrompt(false), 2000)
  }

  /* ----- Section renderers (used by both desktop and mobile) ----- */

  const renderAccount = () => (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
      <ConnectedAgentsCard token={token} />
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Profile</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">Email</label>
            <div className="px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-muted)]">
              {profile.email}
            </div>
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">Display Name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Enter display name..."
              className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={handleSaveName}
              disabled={saving}
              className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {saved && <span className="text-sm text-emerald-400">Saved</span>}
          </div>

          <div className="pt-3 border-t border-[var(--border-color)]/40">
            <button
              type="button"
              onClick={toggleAutoNudge}
              aria-pressed={autoNudge}
              className="w-full flex items-center justify-between gap-3 group"
              title="When you switch to an idle session, automatically ask it for a status update."
            >
              <span className="text-left">
                <span className="block text-sm text-[var(--text-primary)]">Auto-nudge idle sessions on switch</span>
                <span className="block text-xs text-[var(--text-muted)] mt-0.5">
                  Sends a brief status-update prompt when you select an idle session.
                </span>
              </span>
              <span
                className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                  autoNudge ? 'bg-indigo-600' : 'bg-[var(--bg-tertiary)]'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                    autoNudge ? 'translate-x-[1.125rem]' : 'translate-x-0.5'
                  }`}
                />
              </span>
            </button>
          </div>
        </div>
      </div>

      <CostCapCard token={token} profile={profile} onUpdateProfile={onUpdateProfile} />
      <NotificationsCard profile={profile} onUpdateProfile={onUpdateProfile} />
      <TimezoneCard profile={profile} onUpdateProfile={onUpdateProfile} />

      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 xl:col-span-2">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">System Prompt</h3>
        <p className="text-xs text-[var(--text-muted)] mb-4">
          Injected into every new Claude session via <code className="text-emerald-300">--append-system-prompt</code>.
          Use this to set persistent instructions — e.g. "after finishing a task, always commit, push, and redeploy."
          Applies on the next agent restart for each project.
        </p>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="e.g. When you finish a task, commit and push the changes, then trigger the Coolify redeploy."
          rows={10}
          className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono resize-y min-h-[200px]"
        />
        <div className="flex items-center gap-3 mt-3">
          <button
            onClick={handleSavePrompt}
            disabled={savingPrompt}
            className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
          >
            {savingPrompt ? 'Saving...' : 'Save'}
          </button>
          {savedPrompt && <span className="text-sm text-emerald-400">Saved — applies on next agent restart</span>}
          <span className="text-xs text-[var(--text-muted)] ml-auto">{systemPrompt.length} chars</span>
        </div>
      </div>
    </div>
  )

  const renderSupervisor = () => <SupervisorPage token={token} embedded />
  const renderApiKey = () => <ApiKeyTab token={token} />

  const sectionFor = (id: Tab) => {
    if (id === 'account') return renderAccount()
    if (id === 'supervisor') return renderSupervisor()
    if (id === 'commands') return <CommandsList token={token} />
    if (id === 'instructions') return <InstructionsTab token={token} />
    return renderApiKey()
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
        <button
          onClick={onBack}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          aria-label="Back to chat"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <h2 className="text-sm font-semibold text-[var(--text-secondary)]">Settings</h2>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* MOBILE: accordion of all sections, no tab bar */}
        <div className="md:hidden p-4 space-y-3">
          {tabs.map((t) => (
            <details
              key={t.id}
              open={t.id === tab}
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) setTab(t.id)
              }}
              className="bg-[var(--bg-secondary)]/60 rounded-xl overflow-hidden group"
            >
              <summary className="cursor-pointer list-none px-4 py-3 flex items-center justify-between hover:bg-[var(--bg-tertiary)]/40 transition-colors">
                <div>
                  <div className="text-sm font-semibold text-[var(--text-primary)]">{t.label}</div>
                  <div className="text-xs text-[var(--text-muted)] mt-0.5">{t.desc}</div>
                </div>
                <svg
                  width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  className="text-[var(--text-muted)] transition-transform group-open:rotate-180 shrink-0"
                  aria-hidden="true"
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </summary>
              <div className="px-4 pb-4 pt-1">
                {sectionFor(t.id)}
              </div>
            </details>
          ))}
        </div>

        {/* DESKTOP: sticky vertical tabs + content area */}
        <div className="hidden md:flex px-6 lg:px-10 xl:px-14 py-6 gap-8 w-full">
          {/* Vertical tab nav */}
          <nav className="w-64 shrink-0 sticky top-6 self-start space-y-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`w-full text-left px-3 py-2 rounded-lg transition-colors ${
                  tab === t.id
                    ? 'bg-indigo-600/20 ring-1 ring-indigo-500/30 text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)]'
                }`}
              >
                <div className="text-sm font-medium">{t.label}</div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5">{t.desc}</div>
              </button>
            ))}
          </nav>

          {/* Content area */}
          <div className="flex-1 min-w-0">
            {sectionFor(tab)}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Connected Agents card                                               */
/* ------------------------------------------------------------------ */

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—'
  const gb = bytes / (1024 ** 3)
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  const mb = bytes / (1024 ** 2)
  return `${mb.toFixed(0)} MB`
}

function platformLabel(p?: string): string {
  if (!p) return '—'
  if (p === 'darwin') return 'macOS'
  if (p === 'win32') return 'Windows'
  if (p === 'linux') return 'Linux'
  return p
}

function ConnectedAgentsCard({ token }: { token: string }) {
  const { sessions, loading, refetch } = useSessions(token)
  const online = sessions.filter((s: CodeSession) =>
    (s.status === 'online' || s.status === 'thinking') && s.agent_info
  )

  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 xl:col-span-2">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Connected Agents</h3>
        <button
          onClick={refetch}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
        >
          Refresh
        </button>
      </div>
      {loading ? (
        <p className="text-sm text-[var(--text-muted)]">Loading...</p>
      ) : online.length === 0 ? (
        <p className="text-sm text-[var(--text-muted)]">
          No connected agents. Run <code className="text-emerald-300">claude-remote</code> on a machine to connect one.
        </p>
      ) : (
        <div className="space-y-3">
          {online.map((s: CodeSession) => {
            const info = (s.agent_info || {}) as AgentInfo
            return (
              <div key={s.id} className="bg-[var(--bg-primary)]/60 rounded-lg p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className={`w-2 h-2 rounded-full ${s.status === 'thinking' ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
                  <span className="text-sm font-semibold text-[var(--text-primary)]">
                    {info.hostname || s.name}
                  </span>
                  {info.agent_version && (
                    <span className="text-[10px] font-mono text-[var(--text-muted)] ml-auto">v{info.agent_version}</span>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 text-xs">
                  <Spec label="OS" value={`${platformLabel(info.platform)}${info.os_release ? ` ${info.os_release}` : ''}`} />
                  <Spec label="Arch" value={info.arch} />
                  <Spec label="CPU" value={info.cpu_model} />
                  <Spec label="Cores" value={info.cpu_cores?.toString()} />
                  <Spec label="Memory" value={formatBytes(info.total_mem_bytes)} />
                  <Spec label="Runtime" value={info.bun_version ? `Bun ${info.bun_version}` : info.node_version ? `Node ${info.node_version}` : '—'} />
                  {s.project_dir && (
                    <div className="col-span-2 sm:col-span-3">
                      <div className="text-[var(--text-muted)] text-[10px] uppercase tracking-wider mb-0.5">Project</div>
                      <div className="text-[var(--text-secondary)] font-mono break-all">{s.project_dir}</div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Spec({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <div className="text-[var(--text-muted)] text-[10px] uppercase tracking-wider">{label}</div>
      <div className="text-[var(--text-secondary)] truncate" title={value}>{value || '—'}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* API Key sub-tab                                                     */
/* ------------------------------------------------------------------ */

function ApiKeyTab({ token }: { token: string }) {
  const { activeKey, loading, generateKey, revokeKey } = useApiKey(token)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleGenerate = async () => {
    const result = await generateKey()
    if (result?.key) {
      setNewKey(result.key)
      setConfirming(false)
    }
  }

  const handleRevoke = async () => {
    if (!activeKey) return
    await revokeKey(activeKey.id)
    setNewKey(null)
  }

  const agentCmd = newKey ? `npx remo-code-agent --api-key ${newKey} --local-output` : ''

  if (loading) {
    return <p className="text-sm text-[var(--text-muted)]">Loading...</p>
  }

  return (
    <div className="space-y-6">
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">API Key</h3>
        <p className="text-[var(--text-muted)] text-sm mb-5">
          Your API key is used with the agent command to connect Claude Code sessions. One key connects all your projects.
        </p>

        {newKey ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-900/20 rounded-xl ring-1 ring-emerald-800/40">
              <p className="text-xs text-emerald-300 font-semibold mb-2">Your new API key (shown once):</p>
              <div className="relative group">
                <code className="block bg-[var(--code-bg)] rounded-lg p-3 text-xs text-emerald-200 font-mono break-all select-all">
                  {newKey}
                </code>
                <button
                  onClick={() => copyText(newKey, 'key')}
                  className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                >
                  {copied === 'key' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div>
              <p className="text-xs text-[var(--text-muted)] mb-2">Run this in your project directory:</p>
              <div className="relative group">
                <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-xs text-indigo-300 font-mono overflow-x-auto">
{agentCmd}
                </pre>
                <button
                  onClick={() => copyText(agentCmd, 'cmd')}
                  className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                >
                  {copied === 'cmd' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-[10px] text-[var(--text-muted)] mt-2">
                The agent will auto-register a session for your project directory.
              </p>
            </div>
          </div>
        ) : activeKey ? (
          <div className="space-y-4">
            <div className="p-4 bg-[var(--bg-tertiary)]/50 rounded-xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-[var(--text-primary)] font-medium">Active key</p>
                  <p className="text-xs text-[var(--text-muted)] mt-1">
                    Created {new Date(activeKey.created_at).toLocaleDateString()}
                    {activeKey.last_used_at && (
                      <> &middot; Last used {new Date(activeKey.last_used_at).toLocaleDateString()}</>
                    )}
                  </p>
                </div>
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleGenerate}
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm text-[var(--text-on-accent)] font-medium transition-colors"
              >
                Rotate Key
              </button>
              {confirming ? (
                <button
                  onClick={handleRevoke}
                  className="px-4 py-2.5 bg-red-600 hover:bg-red-500 rounded-xl text-sm text-[var(--text-on-accent)] font-medium transition-colors"
                >
                  Confirm Revoke
                </button>
              ) : (
                <button
                  onClick={() => setConfirming(true)}
                  className="px-4 py-2.5 text-red-400 hover:text-red-300 ring-1 ring-red-800/60 hover:ring-red-700 rounded-xl text-sm transition-colors"
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-[var(--bg-tertiary)]/30 rounded-xl text-center">
              <p className="text-[var(--text-muted)] text-sm">No active API key</p>
              <p className="text-[var(--text-muted)] text-xs mt-1">Generate one to enable auto-registration</p>
            </div>
            <button
              onClick={handleGenerate}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-[var(--text-on-accent)] font-medium transition-colors"
            >
              Generate API Key
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Cost cap card                                                       */
/* ------------------------------------------------------------------ */

function CostCapCard({
  token, profile, onUpdateProfile,
}: {
  token: string
  profile: Profile
  onUpdateProfile: (data: { daily_cost_cap_usd?: number }) => Promise<any>
}) {
  const [cap, setCap] = useState<string>(
    typeof profile.daily_cost_cap_usd === 'number' ? String(profile.daily_cost_cap_usd) : '10'
  )
  const [today, setToday] = useState<{ cost_usd: number; cap_usd: number } | null>(null)
  const [loadingToday, setLoadingToday] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void hubFetch<{ cost_usd: number; cap_usd: number }>(token, '/api/profile/cost-today')
      .then(d => { if (!cancelled) setToday(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingToday(false) })
    return () => { cancelled = true }
  }, [token])

  const handleSave = async () => {
    const n = parseFloat(cap)
    if (!Number.isFinite(n) || n < 0) return
    setSaving(true)
    try {
      await onUpdateProfile({ daily_cost_cap_usd: n })
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally {
      setSaving(false)
    }
  }

  const spend = today?.cost_usd ?? 0
  const limit = today?.cap_usd ?? parseFloat(cap) ?? 10
  const pct = limit > 0 ? Math.round((spend / limit) * 100) : 0
  const color = pct < 50 ? 'text-emerald-300' : pct < 80 ? 'text-amber-300' : 'text-red-300'

  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Daily cost cap</h3>
      <p className="text-xs text-[var(--text-muted)] mb-4">
        Scheduled tasks won't fire if today's spend would exceed this limit. Manual chat is not affected.
      </p>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1.5">Limit (USD / day)</label>
          <div className="flex items-center gap-2">
            <span className="text-[var(--text-muted)] text-sm">$</span>
            <input
              type="number"
              min={0}
              step={0.5}
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              className="w-32 px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-3 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
            {saved && <span className="text-sm text-emerald-400">Saved</span>}
          </div>
        </div>
        <div className="text-xs">
          {loadingToday ? (
            <span className="text-[var(--text-muted)]">Loading today's spend...</span>
          ) : (
            <span className={color}>
              Today: ${spend.toFixed(4)} / ${limit.toFixed(2)} ({pct}%)
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Notifications card                                                  */
/* ------------------------------------------------------------------ */

function NotificationsCard({
  profile, onUpdateProfile,
}: {
  profile: Profile
  onUpdateProfile: (data: { web_push_enabled?: boolean }) => Promise<any>
}) {
  const [webPush, setWebPush] = useState<boolean>(profile.web_push_enabled ?? true)
  const [saving, setSaving] = useState(false)
  const { permission, request, isSupported } = useWebPushPermission()

  const toggleWebPush = async () => {
    if (permission !== 'granted') return
    const next = !webPush
    setWebPush(next)
    setSaving(true)
    try { await onUpdateProfile({ web_push_enabled: next }) }
    catch { setWebPush(!next) }
    finally { setSaving(false) }
  }

  const toggleDisabled = saving || permission !== 'granted'

  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Notifications</h3>
      <p className="text-xs text-[var(--text-muted)] mb-4">
        Used by scheduled-task post-run actions when you opt in to email or web push.
      </p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1.5">Default email recipient</label>
          <div className="px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-muted)]">
            {profile.email}
          </div>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">
            Tasks with an email action default to this address when left blank.
          </p>
        </div>

        {!isSupported && (
          <p className="text-xs text-[var(--text-muted)]">
            Your browser doesn't support notifications.
          </p>
        )}

        {isSupported && permission === 'granted' && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 text-[11px] font-medium ring-1 ring-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            Notifications enabled
          </span>
        )}

        {isSupported && permission === 'denied' && (
          <div>
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 text-[11px] font-medium ring-1 ring-red-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
              Notifications blocked
            </span>
            <p className="text-[10px] text-[var(--text-muted)] mt-1">
              Enable in your browser settings, then reload this page.
            </p>
          </div>
        )}

        {isSupported && permission === 'default' && (
          <button
            type="button"
            onClick={() => { void request() }}
            className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            Enable browser notifications
          </button>
        )}

        <button
          type="button"
          onClick={toggleWebPush}
          aria-pressed={webPush}
          disabled={toggleDisabled}
          className="w-full flex items-center justify-between gap-3 group disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="text-left">
            <span className="block text-sm text-[var(--text-primary)]">Web push (this tab)</span>
            <span className="block text-xs text-[var(--text-muted)] mt-0.5">
              {permission === 'granted'
                ? 'Show browser notifications for scheduled-task events when this tab is backgrounded.'
                : 'Grant notification permission above to enable this toggle.'}
            </span>
          </span>
          <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${webPush && permission === 'granted' ? 'bg-indigo-600' : 'bg-[var(--bg-tertiary)]'}`}>
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${webPush && permission === 'granted' ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`} />
          </span>
        </button>
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          Telegram notifications require connecting Telegram in the Integrations tab.
        </p>
      </div>
    </div>
  )
}

function TimezoneCard({
  profile,
  onUpdateProfile,
}: {
  profile: { timezone?: string }
  onUpdateProfile: (data: { timezone?: string }) => Promise<any>
}) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [value, setValue] = useState(profile.timezone || browserTz)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')

  useEffect(() => {
    if (profile.timezone) setValue(profile.timezone)
  }, [profile.timezone])

  const zones = (Intl as any).supportedValuesOf
    ? ((Intl as any).supportedValuesOf('timeZone') as string[])
    : [browserTz, 'UTC']

  const onSave = async () => {
    setSaving(true)
    setStatus('idle')
    try {
      const updated = await onUpdateProfile({ timezone: value })
      setStatus(updated ? 'saved' : 'error')
    } catch {
      setStatus('error')
    } finally {
      setSaving(false)
      if (status === 'saved') setTimeout(() => setStatus('idle'), 2000)
    }
  }

  const dirty = (profile.timezone || browserTz) !== value

  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
      <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Timezone</h3>
      <p className="text-xs text-[var(--text-muted)] mb-4">
        Used for the daily cost-cap window and scheduled-task next-run previews.
      </p>
      <div className="flex gap-2 items-center">
        <select
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm"
        >
          {zones.map((z) => (
            <option key={z} value={z}>{z}</option>
          ))}
        </select>
        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {status === 'saved' && (
        <p className="text-xs text-emerald-400 mt-2">Saved.</p>
      )}
      {status === 'error' && (
        <p className="text-xs text-red-400 mt-2">Couldn't save. Try again.</p>
      )}
    </div>
  )
}

// ── Phase 05: per-CLI global instruction blobs synced to agents on auth_ok.
// `create_if_absent` semantics — the agent never overwrites existing local files.
function InstructionsTab({ token }: { token: string }) {
  const [claudeMd, setClaudeMd] = useState<string>('')
  const [codexAgents, setCodexAgents] = useState<string>('')
  const [codexConfig, setCodexConfig] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)
  const [strippedCount, setStrippedCount] = useState<number>(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const data = await hubFetch<{
          claude_global_md: string | null
          codex_agents_md: string | null
          codex_config_toml: string | null
        }>(token, '/api/instructions')
        if (cancelled) return
        setClaudeMd(data.claude_global_md ?? '')
        setCodexAgents(data.codex_agents_md ?? '')
        setCodexConfig(data.codex_config_toml ?? '')
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Failed to load instructions')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [token])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setStrippedCount(0)
    try {
      const data = await hubFetch<{
        claude_global_md: string | null
        codex_agents_md: string | null
        codex_config_toml: string | null
        stripped_secret_lines?: number
      }>(token, '/api/instructions', {
        method: 'PUT',
        json: {
          claude_global_md: claudeMd || null,
          codex_agents_md: codexAgents || null,
          codex_config_toml: codexConfig || null,
        },
      })
      setClaudeMd(data.claude_global_md ?? '')
      setCodexAgents(data.codex_agents_md ?? '')
      setCodexConfig(data.codex_config_toml ?? '')
      setStrippedCount(data.stripped_secret_lines ?? 0)
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(null), 3000)
    } catch (e: any) {
      setError(e?.message ?? 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <p className="text-sm text-[var(--text-muted)]">Loading instructions…</p>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-1">Global instruction files</h3>
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          These blobs sync to each agent on connect. Agents write them to disk only when the
          local file does not already exist — they <strong>never</strong> overwrite. On
          sha-256 drift the agent logs a warning and keeps the local copy.
        </p>
      </div>

      <InstructionField
        label={<>Claude global instructions <code className="text-[10px] text-[var(--text-muted)]">~/.claude/CLAUDE.md</code></>}
        value={claudeMd}
        onChange={setClaudeMd}
        placeholder="# Global Claude Code Instructions&#10;&#10;e.g. commit + push when tasks complete, follow project port map, etc."
      />
      <InstructionField
        label={<>Codex agent instructions <code className="text-[10px] text-[var(--text-muted)]">~/.codex/AGENTS.md</code></>}
        value={codexAgents}
        onChange={setCodexAgents}
        placeholder="# Codex AGENTS.md&#10;&#10;Persistent instructions injected on every Codex session."
      />
      <InstructionField
        label={<>Codex config <code className="text-[10px] text-[var(--text-muted)]">~/.codex/config.toml</code></>}
        value={codexConfig}
        onChange={setCodexConfig}
        placeholder='# TOML config — secrets (api_key, token, etc.) are stripped on save.'
        hint="Lines matching api_key/token/secret/password are stripped server-side on save. Put credentials in OPENAI_API_KEY or run `codex login`."
      />

      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {savedAt && (
          <span className="text-sm text-emerald-400">
            Saved — next agent reconnect will sync.
            {strippedCount > 0 && ` Stripped ${strippedCount} secret line(s).`}
          </span>
        )}
        {error && <span className="text-sm text-red-400">{error}</span>}
      </div>
    </div>
  )
}

function InstructionField({
  label, value, onChange, placeholder, hint,
}: {
  label: ReactNode
  value: string
  onChange: (v: string) => void
  placeholder?: string
  hint?: string
}) {
  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
      <label className="block text-sm font-semibold text-[var(--text-primary)] mb-2">{label}</label>
      {hint && <p className="text-xs text-[var(--text-muted)] mb-3">{hint}</p>}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={8}
        maxLength={100_000}
        className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono resize-y min-h-[140px]"
      />
      <div className="mt-1.5 text-[10px] text-[var(--text-muted)] text-right">
        {value.length.toLocaleString()} / 100,000 chars
      </div>
    </div>
  )
}

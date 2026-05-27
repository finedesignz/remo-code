import { useState, useEffect, useRef, useCallback } from 'react'
import type { Profile } from '../hooks/useProfile'
import { useWebPushPermission } from '../hooks/useWebPushPermission'
import { useApiKey } from '../hooks/useApiKey'
import { useWebSocket } from '../hooks/useWebSocket'
import { SupervisorPage } from './SupervisorPage'
import { CommandsList } from './CommandsList'
import { SchedulesPage } from './SchedulesPage'
import { ClaudeUsageCard } from './ClaudeUsageCard'
import { hubFetch } from '../lib/api'

interface Props {
  token: string
  profile: Profile
  onUpdateProfile: (data: {
    display_name?: string
    avatar_url?: string | null
    system_prompt?: string | null
    daily_cost_cap_usd?: number
    web_push_enabled?: boolean
    timezone?: string
  }) => Promise<any>
  onBack: () => void
}

type Tab = 'profile' | 'supervisor' | 'apikey' | 'commands' | 'instructions' | 'schedules'

function readTabFromHash(): Tab {
  const m = window.location.hash.match(/[?&]tab=([a-z]+)/)
  const raw = m?.[1]
  if (raw === 'account') return 'profile'
  if (raw === 'profile' || raw === 'supervisor' || raw === 'apikey' || raw === 'commands' || raw === 'instructions' || raw === 'schedules') return raw
  return 'supervisor'
}

/* Inline icons (no new deps) */
function HelpIcon({ title }: { title: string }) {
  return (
    <span
      className="inline-flex items-center justify-center w-3.5 h-3.5 ml-1 align-text-bottom text-[var(--text-muted)] cursor-help"
      title={title}
      aria-label={title}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7" cy="7" r="5.5" />
        <path d="M5.5 5.2a1.5 1.5 0 0 1 3 .3c0 1-1.5 1.3-1.5 2.3" />
        <circle cx="7" cy="10.2" r="0.5" fill="currentColor" />
      </svg>
    </span>
  )
}

function RotateIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 7a5 5 0 1 1-1.5-3.5" />
      <path d="M12 1.5V4h-2.5" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 3.5h10M5 3.5v-1a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1M3.5 3.5l.5 8.5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1l.5-8.5" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="8" height="8" rx="1.25" />
      <path d="M9.5 4V2.75a.75.75 0 0 0-.75-.75H2.75a.75.75 0 0 0-.75.75v6a.75.75 0 0 0 .75.75H4" />
    </svg>
  )
}

/* Auto-save hook for low-stakes fields. Debounces on value change. */
function useAutoSave<T>(value: T, initial: T, save: (v: T) => Promise<any>, delay = 600) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSaved = useRef(initial)
  useEffect(() => {
    if (value === lastSaved.current) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(async () => {
      setStatus('saving')
      try {
        await save(value)
        lastSaved.current = value
        setStatus('saved')
        setTimeout(() => setStatus('idle'), 1500)
      } catch {
        setStatus('error')
      }
    }, delay)
    return () => { if (timer.current) clearTimeout(timer.current) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])
  return status
}

function SaveIndicator({ status }: { status: 'idle' | 'saving' | 'saved' | 'error' }) {
  if (status === 'idle') return null
  if (status === 'saving') return <span className="text-[11px] text-[var(--text-muted)]">Saving…</span>
  if (status === 'saved') return <span className="text-[11px] text-emerald-400">Saved</span>
  return <span className="text-[11px] text-red-400">Error</span>
}

export function SettingsPage({ token, profile, onUpdateProfile, onBack }: Props) {
  const [tab, setTab] = useState<Tab>(readTabFromHash)

  useEffect(() => {
    const next = `#/settings?tab=${tab}`
    if (window.location.hash !== next) window.history.replaceState(null, '', next)
  }, [tab])

  useEffect(() => {
    const onHash = () => setTab(readTabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const tabs: { id: Tab; label: string }[] = [
    { id: 'supervisor', label: 'Supervisor' },
    { id: 'schedules', label: 'Schedules' },
    { id: 'commands', label: 'Commands' },
    { id: 'profile', label: 'Profile' },
    { id: 'instructions', label: 'Instructions' },
    { id: 'apikey', label: 'API Key' },
  ]

  const sectionFor = (id: Tab) => {
    if (id === 'profile') return <ProfileTab token={token} profile={profile} onUpdateProfile={onUpdateProfile} />
    if (id === 'supervisor') return <SupervisorPage token={token} embedded />
    if (id === 'commands') return <CommandsList token={token} />
    if (id === 'instructions') return <InstructionsTab token={token} />
    if (id === 'schedules') return <SchedulesTabEmbedded token={token} />
    return <ApiKeyTab token={token} />
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-primary)]">
      <header className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)]/60 backdrop-blur-sm shrink-0">
        <button
          onClick={onBack}
          className="text-[var(--text-muted)] hover:text-[var(--text-primary)] p-1.5 rounded-lg hover:bg-[var(--bg-tertiary)]/50 transition-colors"
          aria-label="Back to chat"
          title="Back to chat"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <h2 className="text-sm font-semibold text-[var(--text-secondary)]">Settings</h2>
      </header>

      <div className="flex-1 overflow-y-auto">
        {/* MOBILE: dropdown picker */}
        <div className="md:hidden">
          <div className="sticky top-0 z-10 bg-[var(--bg-primary)] px-4 pt-4 pb-3 border-b border-[var(--border-color)]">
            <select
              value={tab}
              onChange={(e) => setTab(e.target.value as Tab)}
              className="w-full bg-[var(--bg-secondary)] text-[var(--text-primary)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50"
              aria-label="Settings section"
            >
              {tabs.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          <div className="px-4 py-4 max-w-7xl mx-auto">{sectionFor(tab)}</div>
        </div>

        {/* DESKTOP: horizontal tabs */}
        <div className="hidden md:block px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto">
          <nav className="flex items-center gap-1 border-b border-[var(--border-color)] mb-5 overflow-x-auto">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-sm rounded-t-lg transition-colors whitespace-nowrap -mb-px border-b-2 ${
                  tab === t.id
                    ? 'text-orange-300 border-orange-500'
                    : 'text-[var(--text-secondary)] border-transparent hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40'
                }`}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div>{sectionFor(tab)}</div>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── Profile tab ─────────────────────────── */

function ProfileTab({
  token, profile, onUpdateProfile,
}: {
  token: string
  profile: Profile
  onUpdateProfile: Props['onUpdateProfile']
}) {
  const [displayName, setDisplayName] = useState(profile.display_name || '')
  const [systemPrompt, setSystemPrompt] = useState(profile.system_prompt || '')

  const nameStatus = useAutoSave(displayName, profile.display_name || '', (v) =>
    onUpdateProfile({ display_name: v })
  )
  const promptStatus = useAutoSave(systemPrompt, profile.system_prompt || '', (v) =>
    onUpdateProfile({ system_prompt: v })
  )

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

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 xl:col-span-2 space-y-4">
        <AvatarUploader profile={profile} onUpdateProfile={onUpdateProfile} />

        <div>
          <label className="flex items-center text-xs text-[var(--text-muted)] mb-1.5">
            Email
            <HelpIcon title="Your account email. Change in Titanium." />
          </label>
          <div className="px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-muted)]">
            {profile.email}
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="flex items-center text-xs text-[var(--text-muted)]">
              Display name
              <HelpIcon title="Shown next to your messages and in the profile menu. Auto-saves on change." />
            </label>
            <SaveIndicator status={nameStatus} />
          </div>
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Display name"
            className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-orange-500/50"
          />
        </div>

        <div className="pt-3 border-t border-[var(--border-color)]/40">
          <button
            type="button"
            onClick={toggleAutoNudge}
            aria-pressed={autoNudge}
            className="w-full flex items-center justify-between gap-3"
            title="When you switch to an idle session, automatically send a brief status-update prompt."
          >
            <span className="flex items-center text-sm text-[var(--text-primary)]">
              Auto-nudge idle sessions
              <HelpIcon title="When you switch to an idle session, automatically send a brief status-update prompt." />
            </span>
            <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${autoNudge ? 'bg-orange-600' : 'bg-[var(--bg-tertiary)]'}`}>
              <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${autoNudge ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`} />
            </span>
          </button>
        </div>
      </section>

      <ClaudeUsageCard token={token} />
      <CostCapCard token={token} profile={profile} onUpdateProfile={onUpdateProfile} />
      <NotificationsCard profile={profile} onUpdateProfile={onUpdateProfile} />
      <TimezoneCard profile={profile} onUpdateProfile={onUpdateProfile} />

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 xl:col-span-2">
        <div className="flex items-center justify-between mb-2">
          <label className="flex items-center text-sm font-semibold text-[var(--text-primary)]">
            System prompt
            <HelpIcon title="Injected into every new Claude session via --append-system-prompt. Applies on next agent restart." />
          </label>
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-[var(--text-muted)]">{systemPrompt.length} chars</span>
            <SaveIndicator status={promptStatus} />
          </div>
        </div>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="e.g. When you finish a task, commit and push, then trigger Coolify redeploy."
          rows={8}
          className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-orange-500/50 font-mono resize-y min-h-[160px]"
        />
      </section>

      <CoolifyWebhookCard token={token} />
    </div>
  )
}

/* ─────────────────────────── Avatar uploader ─────────────────────────── */

function AvatarUploader({
  profile, onUpdateProfile,
}: {
  profile: Profile
  onUpdateProfile: (data: { avatar_url?: string | null }) => Promise<any>
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const initial = (profile.display_name?.trim()?.[0] || profile.email?.[0] || '?').toUpperCase()
  const MAX_BYTES = 1_000_000

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    if (!/^image\//.test(f.type)) { setError('Pick an image file'); return }
    if (f.size > MAX_BYTES) { setError(`Image must be under ${(MAX_BYTES / 1024 / 1024).toFixed(1)} MB`); return }
    setError(null); setBusy(true)
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result))
        r.onerror = () => reject(r.error)
        r.readAsDataURL(f)
      })
      await onUpdateProfile({ avatar_url: dataUrl })
    } catch (err: any) {
      setError(err?.message || 'Upload failed')
    } finally { setBusy(false) }
  }

  return (
    <div>
      <label className="flex items-center text-xs text-[var(--text-muted)] mb-1.5">
        Avatar
        <HelpIcon title="PNG/JPEG/WebP, max 1 MB. Stored inline in your account." />
      </label>
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-full bg-orange-600 flex items-center justify-center text-[var(--text-on-accent)] text-lg font-semibold overflow-hidden shrink-0">
          {profile.avatar_url
            ? <img src={profile.avatar_url} alt="" className="w-full h-full object-cover" />
            : initial}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="px-3 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors disabled:opacity-50"
          >
            {busy ? 'Uploading…' : profile.avatar_url ? 'Replace' : 'Upload'}
          </button>
          {profile.avatar_url && (
            <button
              type="button"
              onClick={() => onUpdateProfile({ avatar_url: null })}
              disabled={busy}
              className="px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors disabled:opacity-50"
              title="Remove avatar"
            >
              Remove
            </button>
          )}
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={onFile} className="hidden" />
        </div>
      </div>
      {error && <p className="text-xs text-red-400 mt-1.5">{error}</p>}
    </div>
  )
}

/* ─────────────────────────── Schedules embed ─────────────────────────── */

function SchedulesTabEmbedded({ token }: { token: string }) {
  const { subscribe } = useWebSocket(token)
  return <SchedulesPage token={token} subscribe={subscribe} />
}

/* ─────────────────────────── API Key tab ─────────────────────────── */

function ApiKeyTab({ token }: { token: string }) {
  const { activeKey, loading, generateKey, revokeKey } = useApiKey(token)
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [opError, setOpError] = useState<string | null>(null)

  const copy = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const handleGenerate = async () => {
    setOpError(null)
    const result = await generateKey()
    if (result.ok && result.data?.key) {
      setNewKey(result.data.key)
      setConfirming(false)
    } else if (!result.ok) {
      setOpError(result.message)
    }
  }

  const handleRevoke = async () => {
    if (!activeKey) return
    setOpError(null)
    const result = await revokeKey(activeKey.id)
    if (result.ok) {
      setNewKey(null)
      setConfirming(false)
    } else {
      setOpError(result.message)
    }
  }

  if (loading) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>

  return (
    <div className="space-y-4">
      {newKey && (
        <div className="bg-emerald-900/20 rounded-xl ring-1 ring-emerald-800/40 p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs text-emerald-300 font-semibold flex items-center">
              New API key (shown once)
              <HelpIcon title="Copy this now. The key cannot be retrieved later — only its prefix is stored." />
            </span>
            <button
              onClick={() => copy(newKey)}
              className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] px-2 py-1 rounded hover:bg-[var(--bg-tertiary)]/50 inline-flex items-center gap-1"
              title="Copy key"
            >
              <CopyIcon />
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <code className="block bg-[var(--code-bg)] rounded-lg p-3 text-xs text-emerald-200 font-mono break-all select-all">
            {newKey}
          </code>
        </div>
      )}
      {opError && (
        <p className="text-red-300/80 text-xs">{opError}</p>
      )}

      <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <div className="flex items-center justify-between mb-3">
          <h3 className="flex items-center text-sm font-semibold text-[var(--text-primary)]">
            API keys
            <HelpIcon title="Authenticates the Remo Code Supervisor / agent. One key connects all your projects." />
          </h3>
          {!activeKey && (
            <button
              onClick={handleGenerate}
              className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
            >
              Generate key
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-muted)] border-b border-[var(--border-color)]/40">
                <th className="py-2 pr-3 font-medium">Prefix</th>
                <th className="py-2 pr-3 font-medium">Created</th>
                <th className="py-2 pr-3 font-medium">Last used</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 pr-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-color)]/30">
              {activeKey ? (
                <tr>
                  <td className="py-3 pr-3 font-mono text-xs text-[var(--text-secondary)]">
                    {(activeKey as any).prefix || 'remo_…'}
                  </td>
                  <td className="py-3 pr-3 text-xs text-[var(--text-muted)]">
                    {new Date(activeKey.created_at).toLocaleDateString()}
                  </td>
                  <td className="py-3 pr-3 text-xs text-[var(--text-muted)]">
                    {activeKey.last_used_at ? new Date(activeKey.last_used_at).toLocaleDateString() : '—'}
                  </td>
                  <td className="py-3 pr-3">
                    <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-emerald-500/15 ring-1 ring-emerald-500/30 text-emerald-300 text-[11px]">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                      Active
                    </span>
                  </td>
                  <td className="py-3 pr-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      <button
                        onClick={handleGenerate}
                        className="p-1.5 text-[var(--text-muted)] hover:text-orange-300 hover:bg-[var(--bg-tertiary)]/50 rounded transition-colors"
                        title="Rotate key (revokes current, generates new)"
                        aria-label="Rotate key"
                      >
                        <RotateIcon />
                      </button>
                      {confirming ? (
                        <button
                          onClick={handleRevoke}
                          className="px-2 py-1 text-[11px] bg-red-600 hover:bg-red-500 text-white rounded transition-colors"
                          title="Confirm revoke"
                        >
                          Confirm
                        </button>
                      ) : (
                        <button
                          onClick={() => setConfirming(true)}
                          className="p-1.5 text-[var(--text-muted)] hover:text-red-300 hover:bg-[var(--bg-tertiary)]/50 rounded transition-colors"
                          title="Revoke key"
                          aria-label="Revoke key"
                        >
                          <TrashIcon />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm text-[var(--text-muted)]">
                    No active key. Generate one to connect an agent.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}

/* ─────────────────────────── Cost cap card ─────────────────────────── */

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
  const status = useAutoSave(
    cap,
    String(profile.daily_cost_cap_usd ?? '10'),
    async (v) => {
      const n = parseFloat(v)
      if (!Number.isFinite(n) || n < 0) throw new Error('invalid')
      await onUpdateProfile({ daily_cost_cap_usd: n })
    }
  )

  useEffect(() => {
    let cancelled = false
    void hubFetch<{ cost_usd: number; cap_usd: number }>(token, '/api/profile/cost-today')
      .then(d => { if (!cancelled) setToday(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingToday(false) })
    return () => { cancelled = true }
  }, [token])

  const spend = today?.cost_usd ?? 0
  const limit = today?.cap_usd ?? parseFloat(cap) ?? 10
  const pct = limit > 0 ? Math.round((spend / limit) * 100) : 0
  const color = pct < 50 ? 'text-emerald-300' : pct < 80 ? 'text-amber-300' : 'text-red-300'

  return (
    <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center text-sm font-semibold text-[var(--text-primary)]">
          Daily cost cap
          <HelpIcon title="Scheduled tasks won't fire if today's spend would exceed this. Manual chat is not affected. USD/day." />
        </label>
        <SaveIndicator status={status} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-[var(--text-muted)] text-sm">$</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={cap}
          onChange={(e) => setCap(e.target.value)}
          className="w-28 px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-sm text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/50"
        />
        <span className="text-xs text-[var(--text-muted)]">USD / day</span>
      </div>
      <div className="text-xs">
        {loadingToday ? (
          <span className="text-[var(--text-muted)]">Loading today…</span>
        ) : (
          <span className={color} title="Spent today / cap">
            ${spend.toFixed(4)} / ${limit.toFixed(2)} · {pct}%
          </span>
        )}
      </div>
    </section>
  )
}

/* ─────────────────────────── Notifications card ─────────────────────────── */

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
    setWebPush(next); setSaving(true)
    try { await onUpdateProfile({ web_push_enabled: next }) }
    catch { setWebPush(!next) }
    finally { setSaving(false) }
  }
  const toggleDisabled = saving || permission !== 'granted'

  return (
    <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
      <h3 className="flex items-center text-sm font-semibold text-[var(--text-primary)]">
        Notifications
        <HelpIcon title="Used by scheduled-task post-run actions when you opt in to email or web push." />
      </h3>

      <div>
        <label className="flex items-center text-xs text-[var(--text-muted)] mb-1.5">
          Default email recipient
          <HelpIcon title="Tasks with an email action default to this address when left blank." />
        </label>
        <div className="px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-muted)]">
          {profile.email}
        </div>
      </div>

      {!isSupported && (
        <p className="text-xs text-[var(--text-muted)]">Browser doesn't support notifications.</p>
      )}

      {isSupported && permission === 'denied' && (
        <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-red-500/15 ring-1 ring-red-500/30 text-red-300 text-[11px]" title="Enable in browser settings, then reload.">
          <span className="w-1.5 h-1.5 rounded-full bg-red-400" />
          Notifications blocked
        </span>
      )}

      {isSupported && permission === 'default' && (
        <button
          type="button"
          onClick={() => { void request() }}
          className="px-3 py-2 rounded-lg bg-orange-600 hover:bg-orange-500 text-white text-sm font-medium transition-colors"
          title="Grant browser permission to show notifications"
        >
          Enable browser notifications
        </button>
      )}

      <button
        type="button"
        onClick={toggleWebPush}
        aria-pressed={webPush}
        disabled={toggleDisabled}
        className="w-full flex items-center justify-between gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
        title="Show browser notifications for scheduled-task events when this tab is backgrounded."
      >
        <span className="flex items-center text-sm text-[var(--text-primary)]">
          Web push (this tab)
          <HelpIcon title="Browser notifications for scheduled-task events while this tab is backgrounded." />
        </span>
        <span className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${webPush && permission === 'granted' ? 'bg-orange-600' : 'bg-[var(--bg-tertiary)]'}`}>
          <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${webPush && permission === 'granted' ? 'translate-x-[1.125rem]' : 'translate-x-0.5'}`} />
        </span>
      </button>
    </section>
  )
}

/* ─────────────────────────── Timezone card ─────────────────────────── */

function TimezoneCard({
  profile, onUpdateProfile,
}: {
  profile: { timezone?: string }
  onUpdateProfile: (data: { timezone?: string }) => Promise<any>
}) {
  const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [value, setValue] = useState(profile.timezone || browserTz)
  const status = useAutoSave(value, profile.timezone || browserTz, (v) => onUpdateProfile({ timezone: v }))

  useEffect(() => {
    if (profile.timezone) setValue(profile.timezone)
  }, [profile.timezone])

  const zones = (Intl as any).supportedValuesOf
    ? ((Intl as any).supportedValuesOf('timeZone') as string[])
    : [browserTz, 'UTC']

  return (
    <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <label className="flex items-center text-sm font-semibold text-[var(--text-primary)]">
          Timezone
          <HelpIcon title="Used for the daily cost-cap window and scheduled-task next-run previews." />
        </label>
        <SaveIndicator status={status} />
      </div>
      <select
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-full px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-sm focus:outline-none focus:ring-2 focus:ring-orange-500/50"
      >
        {zones.map((z) => <option key={z} value={z}>{z}</option>)}
      </select>
    </section>
  )
}

/* ─────────────────────────── Instructions tab ─────────────────────────── */

function InstructionsTab({ token }: { token: string }) {
  const [claudeMd, setClaudeMd] = useState<string>('')
  const [codexAgents, setCodexAgents] = useState<string>('')
  const [codexConfig, setCodexConfig] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [strippedFlash, setStrippedFlash] = useState<number>(0)
  const initialRef = useRef({ claudeMd: '', codexAgents: '', codexConfig: '' })

  useEffect(() => {
    let cancelled = false
    hubFetch<{
      claude_global_md: string | null
      codex_agents_md: string | null
      codex_config_toml: string | null
    }>(token, '/api/instructions')
      .then(d => {
        if (cancelled) return
        const c = d.claude_global_md ?? ''
        const a = d.codex_agents_md ?? ''
        const t = d.codex_config_toml ?? ''
        setClaudeMd(c); setCodexAgents(a); setCodexConfig(t)
        initialRef.current = { claudeMd: c, codexAgents: a, codexConfig: t }
      })
      .catch(e => { if (!cancelled) setError(e?.message ?? 'Failed to load') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token])

  const save = useCallback(async () => {
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
    initialRef.current = {
      claudeMd: data.claude_global_md ?? '',
      codexAgents: data.codex_agents_md ?? '',
      codexConfig: data.codex_config_toml ?? '',
    }
    if (data.stripped_secret_lines && data.stripped_secret_lines > 0) {
      setStrippedFlash(data.stripped_secret_lines)
      setTimeout(() => setStrippedFlash(0), 3000)
    }
  }, [token, claudeMd, codexAgents, codexConfig])

  const claudeStatus = useAutoSave(claudeMd, initialRef.current.claudeMd, save)
  const agentsStatus = useAutoSave(codexAgents, initialRef.current.codexAgents, save)
  const configStatus = useAutoSave(codexConfig, initialRef.current.codexConfig, save)

  if (loading) return <p className="text-sm text-[var(--text-muted)]">Loading…</p>
  if (error) return <p className="text-sm text-red-400">{error}</p>

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <InstructionField
          title="Claude global"
          tooltip="~/.claude/CLAUDE.md — synced to agent on connect. Agent writes only if file is absent locally."
          value={claudeMd}
          onChange={setClaudeMd}
          status={claudeStatus}
        />
        <InstructionField
          title="Codex AGENTS"
          tooltip="~/.codex/AGENTS.md — synced to agent on connect. Agent writes only if file is absent locally."
          value={codexAgents}
          onChange={setCodexAgents}
          status={agentsStatus}
        />
        <InstructionField
          title="Codex config"
          tooltip="~/.codex/config.toml — synced to agent on connect. Lines matching api_key/token/secret/password are stripped server-side on save."
          value={codexConfig}
          onChange={setCodexConfig}
          status={configStatus}
        />
      </div>
      {strippedFlash > 0 && (
        <p className="text-xs text-amber-300">Stripped {strippedFlash} secret line(s) on save.</p>
      )}
    </div>
  )
}

function InstructionField({
  title, tooltip, value, onChange, status,
}: {
  title: string
  tooltip: string
  value: string
  onChange: (v: string) => void
  status: 'idle' | 'saving' | 'saved' | 'error'
}) {
  return (
    <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
      <div className="flex items-center justify-between mb-2">
        <label className="flex items-center text-sm font-semibold text-[var(--text-primary)]">
          {title}
          <HelpIcon title={tooltip} />
        </label>
        <SaveIndicator status={status} />
      </div>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={12}
        maxLength={100_000}
        className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-xs text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-orange-500/50 font-mono resize-y min-h-[280px]"
      />
      <div className="mt-1.5 text-[10px] text-[var(--text-muted)] text-right">
        {value.length.toLocaleString()} / 100,000
      </div>
    </div>
  )
}

/* ─────────────────────────── Coolify webhook ─────────────────────────── */

type AttemptRow = {
  id: string
  received_at: string
  source_ip: string | null
  event_type: string | null
  status: string
  reason: string | null
}

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function attemptStatusClasses(status: string): string {
  if (status === 'success') return 'bg-emerald-500/20 ring-1 ring-emerald-500/30 text-emerald-300'
  if (status === 'legacy_hmac') return 'bg-amber-500/20 ring-1 ring-amber-500/30 text-amber-300'
  if (status === 'auth_failed' || status === 'ip_rejected') return 'bg-red-500/20 ring-1 ring-red-500/30 text-red-300'
  return 'bg-gray-500/20 ring-1 ring-gray-500/30 text-[var(--text-muted)]'
}

function CoolifyWebhookCard({ token }: { token: string }) {
  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [webhookUrl, setWebhookUrl] = useState('')
  const [legacyInUse, setLegacyInUse] = useState(false)
  const [rotating, setRotating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [attempts, setAttempts] = useState<AttemptRow[]>([])
  const [allowedIps, setAllowedIps] = useState('')
  const [allowedIpsSaved, setAllowedIpsSaved] = useState('')
  const ipsStatus = useAutoSave(allowedIps, allowedIpsSaved, async (v) => {
    const data = await hubFetch<{ allowed_ips: string }>(
      token,
      '/api/account/coolify-webhook-allowed-ips',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ allowed_ips: v }) },
    )
    setAllowedIpsSaved(data.allowed_ips)
  })

  const loadAttempts = async () => {
    try {
      const data = await hubFetch<{ attempts: AttemptRow[] }>(token, '/api/account/coolify-webhook-attempts?limit=10')
      setAttempts(data.attempts ?? [])
    } catch {}
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    hubFetch<{ configured: boolean; webhook_url: string; legacy_in_use?: boolean }>(
      token, '/api/account/coolify-webhook-secret',
    )
      .then(d => {
        if (cancelled) return
        setConfigured(d.configured); setWebhookUrl(d.webhook_url); setLegacyInUse(!!d.legacy_in_use)
      })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })

    hubFetch<{ allowed_ips: string }>(token, '/api/account/coolify-webhook-allowed-ips')
      .then(d => { if (cancelled) return; setAllowedIps(d.allowed_ips ?? ''); setAllowedIpsSaved(d.allowed_ips ?? '') })
      .catch(() => {})

    void loadAttempts()
    return () => { cancelled = true }
  }, [token])

  const handleRotate = async () => {
    setRotating(true); setError(null)
    try {
      const data = await hubFetch<{ secret: string; webhook_url: string }>(
        token, '/api/account/coolify-webhook-secret/rotate', { method: 'POST' },
      )
      setWebhookUrl(data.webhook_url); setConfigured(true); setLegacyInUse(false)
    } catch (e: any) { setError(String(e?.message || e)) }
    finally { setRotating(false) }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(webhookUrl)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch {}
  }

  return (
    <section className="bg-[var(--bg-secondary)]/60 rounded-xl p-5 xl:col-span-2 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center text-sm font-semibold text-[var(--text-primary)]">
          Coolify webhook
          <HelpIcon title="Lets Coolify push deploy events to remo-code so self-heal can react. Paste the URL into Coolify Notifications → Webhook. The URL is the credential — treat it as a secret." />
        </h3>
        <span className={`text-[10px] uppercase tracking-wide px-2 py-0.5 rounded ${
          configured
            ? 'bg-emerald-500/20 ring-1 ring-emerald-500/30 text-emerald-300'
            : 'bg-gray-500/20 ring-1 ring-gray-500/30 text-[var(--text-muted)]'
        }`}>
          {configured ? 'Configured' : 'Not configured'}
        </span>
      </div>

      <div className="flex gap-2 items-center">
        <div className="flex-1 px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-xs text-[var(--text-primary)] font-mono truncate">
          {loading ? '…' : webhookUrl}
        </div>
        <button
          type="button"
          onClick={copy}
          disabled={loading || !webhookUrl}
          className="p-2 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors disabled:opacity-50"
          title="Copy webhook URL"
          aria-label="Copy webhook URL"
        >
          {copied ? <span className="text-[11px] text-emerald-400">Copied</span> : <CopyIcon />}
        </button>
        <button
          type="button"
          onClick={handleRotate}
          disabled={rotating || loading}
          className="p-2 text-[var(--text-muted)] hover:text-orange-300 hover:bg-[var(--bg-tertiary)]/50 rounded-lg transition-colors disabled:opacity-50"
          title={configured ? 'Rotate URL (invalidates old — must update Coolify)' : 'Generate webhook URL'}
          aria-label="Rotate webhook URL"
        >
          <RotateIcon />
        </button>
      </div>

      {legacyInUse && (
        <div className="rounded-lg bg-amber-500/10 ring-1 ring-amber-500/30 px-3 py-2 text-xs text-amber-200" title="Rotate to mint a new URL-token webhook, then update Coolify.">
          Legacy HMAC format in use — rotate the URL to migrate.
        </div>
      )}

      {error && <div className="text-xs text-red-400">{error}</div>}

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="flex items-center text-xs text-[var(--text-muted)]">
            Allowed source IPs
            <HelpIcon title="Comma-separated IPs or CIDR ranges. Leave blank to allow any source. Coolify server is likely 46.224.61.233." />
          </label>
          <SaveIndicator status={ipsStatus} />
        </div>
        <textarea
          value={allowedIps}
          onChange={(e) => setAllowedIps(e.target.value)}
          rows={2}
          placeholder="46.224.61.233, 10.0.0.0/8"
          className="w-full px-3 py-2 bg-[var(--bg-tertiary)] rounded-lg text-xs text-[var(--text-primary)] font-mono focus:outline-none focus:ring-2 focus:ring-orange-500/50 resize-y"
        />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="flex items-center text-xs text-[var(--text-muted)]">
            Recent attempts
            <HelpIcon title="Most recent 10 webhook delivery attempts from Coolify." />
          </label>
          <button
            type="button"
            onClick={() => void loadAttempts()}
            className="text-[11px] text-orange-300 hover:text-orange-200"
            title="Refresh attempts"
          >
            Refresh
          </button>
        </div>
        {attempts.length === 0 ? (
          <div className="rounded-lg bg-[var(--bg-primary)]/60 p-3 text-xs text-[var(--text-muted)]">No attempts yet.</div>
        ) : (
          <div className="rounded-lg bg-[var(--bg-primary)]/60 divide-y divide-[var(--border-color)]/30">
            {attempts.map(a => (
              <div key={a.id} className="flex items-center gap-2 px-3 py-2 text-[11px]">
                <span className={`px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide ${attemptStatusClasses(a.status)}`}>
                  {a.status}
                </span>
                <span className="text-[var(--text-secondary)] font-mono truncate flex-1">{a.event_type ?? '—'}</span>
                <span className="text-[var(--text-muted)] font-mono">{a.source_ip ?? 'unknown'}</span>
                <span className="text-[var(--text-muted)] whitespace-nowrap">{formatAgo(a.received_at)}</span>
                {a.reason && (
                  <span className="text-[var(--text-muted)] truncate max-w-[200px]" title={a.reason}>{a.reason}</span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

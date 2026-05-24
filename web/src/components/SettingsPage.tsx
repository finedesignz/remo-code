import { useState, useEffect } from 'react'
import type { Profile } from '../hooks/useProfile'
import { useApiKey } from '../hooks/useApiKey'
import { SupervisorPage } from './SupervisorPage'

interface Props {
  token: string
  profile: Profile
  onUpdateProfile: (data: { display_name?: string; system_prompt?: string | null }) => Promise<any>
  onBack: () => void
}

type Tab = 'account' | 'supervisor' | 'apikey'

function readTabFromHash(): Tab {
  const m = window.location.hash.match(/[?&]tab=([a-z]+)/)
  const v = m?.[1] as Tab | undefined
  if (v === 'account' || v === 'supervisor' || v === 'apikey') return v
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
    { id: 'account', label: 'Account', desc: 'Profile & system prompt' },
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
        <div className="hidden md:flex max-w-7xl mx-auto px-6 lg:px-8 py-6 gap-8 w-full">
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

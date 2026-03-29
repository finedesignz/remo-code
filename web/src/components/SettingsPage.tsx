import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { Profile } from '../hooks/useProfile'
import { useApiKey } from '../hooks/useApiKey'

interface Props {
  session: Session
  profile: Profile
  onUpdateProfile: (data: { display_name: string }) => Promise<any>
  onBack: () => void
}

type Tab = 'account' | 'apikey'

export function SettingsPage({ session, profile, onUpdateProfile, onBack }: Props) {
  const [tab, setTab] = useState<Tab>('account')
  const [displayName, setDisplayName] = useState(profile.display_name || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'account', label: 'Account' },
    { id: 'apikey', label: 'API Key' },
  ]

  const handleSaveName = async () => {
    setSaving(true)
    await onUpdateProfile({ display_name: displayName })
    setSaving(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
          {/* Tabs */}
          <div className="flex gap-1 mb-6 bg-[var(--bg-secondary)]/60 rounded-lg p-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  tab === t.id
                    ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Account Tab */}
          {tab === 'account' && (
            <div className="space-y-6">
              <div className="bg-[var(--bg-secondary)]/60 border border-[var(--border-color)] rounded-xl p-5">
                <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-4">Profile</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-[var(--text-muted)] mb-1.5">Email</label>
                    <div className="px-3 py-2 bg-[var(--bg-primary)]/60 border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-muted)]">
                      {profile.email}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-[var(--text-muted)] mb-1.5">Display Name</label>
                    <input
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Enter display name..."
                      className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
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
                </div>
              </div>
            </div>
          )}

          {/* API Key Tab */}
          {tab === 'apikey' && (
            <ApiKeyTab session={session} />
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* API Key sub-tab                                                     */
/* ------------------------------------------------------------------ */

function ApiKeyTab({ session }: { session: Session }) {
  const { activeKey, loading, generateKey, revokeKey } = useApiKey(session)
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
      <div className="bg-[var(--bg-secondary)]/60 border border-[var(--border-color)] rounded-xl p-5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)] mb-2">API Key</h3>
        <p className="text-[var(--text-muted)] text-sm mb-5">
          Your API key is used with the agent command to connect Claude Code sessions. One key connects all your projects.
        </p>

        {newKey ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-900/20 border border-emerald-800/50 rounded-xl">
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
                  className="px-4 py-2.5 text-red-400 hover:text-red-300 border border-red-800 hover:border-red-700 rounded-xl text-sm transition-colors"
                >
                  Revoke
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="p-4 bg-[var(--bg-tertiary)]/30 border border-[var(--border-color)] rounded-xl text-center">
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

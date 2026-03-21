import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { Profile } from '../hooks/useProfile'
import { useBilling } from '../hooks/useBilling'
import { useApiKey } from '../hooks/useApiKey'

interface Props {
  session: Session
  profile: Profile
  onUpdateProfile: (data: { display_name: string }) => Promise<any>
  onBack: () => void
  onShowPricing: () => void
}

type Tab = 'account' | 'billing' | 'apikey'

function TierBadge({ tier }: { tier: string }) {
  const colors: Record<string, string> = {
    free: 'bg-slate-600 text-slate-200',
    pro: 'bg-indigo-600/30 text-indigo-300 ring-1 ring-indigo-500/40',
    max: 'bg-amber-600/30 text-amber-300 ring-1 ring-amber-500/40',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide ${colors[tier] || colors.free}`}>
      {tier}
    </span>
  )
}

function RoleBadge({ role }: { role: string }) {
  if (role === 'admin') {
    return (
      <span className="px-2 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wide bg-purple-600/30 text-purple-300 ring-1 ring-purple-500/40">
        Admin
      </span>
    )
  }
  return null
}

export function SettingsPage({ session, profile, onUpdateProfile, onBack, onShowPricing }: Props) {
  const [tab, setTab] = useState<Tab>('account')
  const [displayName, setDisplayName] = useState(profile.display_name || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  const tabs: { id: Tab; label: string }[] = [
    { id: 'account', label: 'Account' },
    { id: 'billing', label: 'Billing' },
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
    <div className="flex flex-col h-full bg-slate-900">
      {/* Header */}
      <header className="flex items-center gap-3 px-4 py-3 border-b border-slate-700/80 bg-slate-800/60 backdrop-blur-sm shrink-0">
        <button
          onClick={onBack}
          className="text-slate-400 hover:text-white p-1.5 rounded-lg hover:bg-slate-700/50 transition-colors"
          aria-label="Back to chat"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 4l-6 6 6 6" />
          </svg>
        </button>
        <h2 className="text-sm font-semibold text-slate-200">Settings</h2>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
          {/* Tabs */}
          <div className="flex gap-1 mb-6 bg-slate-800/60 rounded-lg p-1">
            {tabs.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex-1 py-2 text-sm font-medium rounded-md transition-colors ${
                  tab === t.id
                    ? 'bg-slate-700 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Account Tab */}
          {tab === 'account' && (
            <div className="space-y-6">
              <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-4">Profile</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">Email</label>
                    <div className="px-3 py-2 bg-slate-900/60 border border-slate-700 rounded-lg text-sm text-slate-400">
                      {profile.email}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-400 mb-1.5">Display Name</label>
                    <input
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="Enter display name..."
                      className="w-full px-3 py-2 bg-slate-900/60 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleSaveName}
                      disabled={saving}
                      className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-white font-medium transition-colors disabled:opacity-50"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    {saved && <span className="text-sm text-emerald-400">Saved</span>}
                  </div>
                </div>
              </div>

              <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-5">
                <h3 className="text-sm font-semibold text-white mb-3">Role & Tier</h3>
                <div className="flex items-center gap-3">
                  <TierBadge tier={profile.tier} />
                  <RoleBadge role={profile.role} />
                </div>
              </div>
            </div>
          )}

          {/* Billing Tab */}
          {tab === 'billing' && (
            <BillingTab session={session} profile={profile} onShowPricing={onShowPricing} />
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
/* Billing sub-tab                                                     */
/* ------------------------------------------------------------------ */

function BillingTab({ session, profile, onShowPricing }: { session: Session; profile: Profile; onShowPricing: () => void }) {
  const { subscription, loading, openPortal } = useBilling(session)

  const limitLabel = profile.session_limit === -1 ? 'Unlimited' : String(profile.session_limit)

  return (
    <div className="space-y-6">
      <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Current Plan</h3>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <TierBadge tier={profile.tier} />
            <span className="text-sm text-slate-300">{profile.session_count} / {limitLabel} channels</span>
          </div>
        </div>

        {/* Usage bar */}
        {profile.session_limit > 0 && (
          <div className="mb-4">
            <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  profile.session_count >= profile.session_limit ? 'bg-red-500' : 'bg-indigo-500'
                }`}
                style={{ width: `${Math.min(100, (profile.session_count / profile.session_limit) * 100)}%` }}
              />
            </div>
          </div>
        )}

        <button
          onClick={onShowPricing}
          className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-white font-medium transition-colors"
        >
          {profile.tier === 'free' ? 'Upgrade Plan' : 'Change Plan'}
        </button>
      </div>

      <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-4">Subscription</h3>
        {loading ? (
          <p className="text-sm text-slate-500">Loading...</p>
        ) : subscription ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Status</span>
              <span className={`font-medium ${subscription.status === 'active' ? 'text-emerald-400' : 'text-amber-400'}`}>
                {subscription.status}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-400">Current period ends</span>
              <span className="text-slate-200">
                {new Date(subscription.current_period_end).toLocaleDateString()}
              </span>
            </div>
            {subscription.cancel_at_period_end && (
              <p className="text-xs text-amber-400 bg-amber-900/20 border border-amber-800/40 rounded-lg px-3 py-2">
                Your subscription will cancel at the end of the current period.
              </p>
            )}
            <button
              onClick={openPortal}
              className="w-full py-2.5 border border-slate-600 hover:border-slate-500 rounded-lg text-sm text-slate-300 hover:text-white font-medium transition-colors"
            >
              Manage in Stripe
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">No active subscription. You are on the free plan.</p>
        )}
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

  const configureCmd = newKey ? `/remo-code:configure ${newKey}` : ''

  if (loading) {
    return <p className="text-sm text-slate-500">Loading...</p>
  }

  return (
    <div className="space-y-6">
      <div className="bg-slate-800/60 border border-slate-700/80 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-white mb-2">API Key</h3>
        <p className="text-slate-400 text-sm mb-5">
          Your API key lets the Claude Code plugin auto-register sessions. One key connects all your projects.
        </p>

        {newKey ? (
          <div className="space-y-4">
            <div className="p-4 bg-emerald-900/20 border border-emerald-800/50 rounded-xl">
              <p className="text-xs text-emerald-300 font-semibold mb-2">Your new API key (shown once):</p>
              <div className="relative group">
                <code className="block bg-slate-900 rounded-lg p-3 text-xs text-emerald-200 font-mono break-all select-all">
                  {newKey}
                </code>
                <button
                  onClick={() => copyText(newKey, 'key')}
                  className="absolute top-2 right-2 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors opacity-0 group-hover:opacity-100"
                >
                  {copied === 'key' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
            <div>
              <p className="text-xs text-slate-400 mb-2">In any Claude Code session, run:</p>
              <div className="relative group">
                <pre className="bg-slate-900 rounded-lg p-3 text-xs text-indigo-300 font-mono overflow-x-auto">
{configureCmd}
                </pre>
                <button
                  onClick={() => copyText(configureCmd, 'cmd')}
                  className="absolute top-2 right-2 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors opacity-0 group-hover:opacity-100"
                >
                  {copied === 'cmd' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <p className="text-[10px] text-slate-500 mt-2">
                Then restart with: <code className="text-slate-400">claude --dangerously-load-development-channels plugin:remo-code@claude-plugins-official</code>
              </p>
            </div>
          </div>
        ) : activeKey ? (
          <div className="space-y-4">
            <div className="p-4 bg-slate-700/50 rounded-xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-white font-medium">Active key</p>
                  <p className="text-xs text-slate-400 mt-1">
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
                className="flex-1 py-2.5 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-sm text-white font-medium transition-colors"
              >
                Rotate Key
              </button>
              {confirming ? (
                <button
                  onClick={handleRevoke}
                  className="px-4 py-2.5 bg-red-600 hover:bg-red-500 rounded-xl text-sm text-white font-medium transition-colors"
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
            <div className="p-4 bg-slate-700/30 border border-slate-600 rounded-xl text-center">
              <p className="text-slate-400 text-sm">No active API key</p>
              <p className="text-slate-500 text-xs mt-1">Generate one to enable auto-registration</p>
            </div>
            <button
              onClick={handleGenerate}
              className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-white font-medium transition-colors"
            >
              Generate API Key
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

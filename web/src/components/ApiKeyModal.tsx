import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { useApiKey } from '../hooks/useApiKey'

interface Props {
  session: Session
  onClose: () => void
}

export function ApiKeyModal({ session, onClose }: Props) {
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">API Key</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
          </div>

          <p className="text-slate-400 text-sm mb-6">
            Your API key lets the Claude Code plugin auto-register sessions. One key connects all your projects.
          </p>

          {loading ? (
            <p className="text-slate-500 text-sm">Loading...</p>
          ) : newKey ? (
            /* Just generated — show the key and setup instructions */
            <div className="space-y-4">
              <div className="p-4 bg-emerald-900/20 border border-emerald-800/50 rounded-xl">
                <p className="text-xs text-emerald-300 font-semibold mb-2">Your new API key (shown once):</p>
                <div className="relative group">
                  <code className="block bg-slate-900 rounded-lg p-3 text-xs text-emerald-200 font-mono break-all select-all">
                    {newKey}
                  </code>
                  <button
                    onClick={() => copyText(newKey, 'key')}
                    className="absolute top-2 right-2 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
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
                    className="absolute top-2 right-2 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    {copied === 'cmd' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-[10px] text-slate-500 mt-2">
                  Then restart with: <code className="text-slate-400">claude --dangerously-load-development-channels plugin:remo-code@claude-plugins-official</code>
                </p>
              </div>

              <button
                onClick={() => { setNewKey(null); onClose() }}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-white font-medium transition-colors"
              >
                Done
              </button>
            </div>
          ) : activeKey ? (
            /* Has an active key */
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
            /* No active key */
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
    </div>
  )
}

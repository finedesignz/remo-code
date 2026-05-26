import { useState } from 'react'
import { useApiKey } from '../hooks/useApiKey'

interface Props {
  token: string
  onClose: () => void
}

export function ApiKeyModal({ token, onClose }: Props) {
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

  const supervisorCmd = newKey ? `npx remo-code-supervisor install --api-key ${newKey} --roots "C:\\Users\\you\\GitHub"` : ''
  const tauriCmd = `cd C:\\Users\\artic\\GitHub\\remo-code\\supervisor\\tauri && cargo tauri build`
  const agentCmd = newKey ? `npx remo-code-agent --api-key ${newKey} --local-output` : ''

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-[var(--text-primary)]">API Key</h2>
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none">&times;</button>
          </div>

          <p className="text-[var(--text-muted)] text-sm mb-6">
            Your API key authenticates the Supervisor app (or legacy agent) when connecting Claude Code sessions. One key connects all your projects.
          </p>

          {loading ? (
            <p className="text-[var(--text-muted)] text-sm">Loading...</p>
          ) : newKey ? (
            /* Just generated — show the key and setup instructions */
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

              {/* PRIMARY: Supervisor */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide font-semibold text-indigo-300 bg-indigo-600/20 ring-1 ring-indigo-500/30 rounded">Recommended</span>
                  <p className="text-xs font-semibold text-[var(--text-primary)]">Install the Supervisor app</p>
                </div>
                <p className="text-xs text-[var(--text-muted)] mb-2">
                  Installs as a Windows service that auto-starts at boot, watches your repo roots, and lets you launch Claude Code sessions remotely from this web UI.
                </p>
                <div className="relative group">
                  <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-xs text-indigo-300 font-mono overflow-x-auto whitespace-pre">{supervisorCmd}</pre>
                  <button
                    onClick={() => copyText(supervisorCmd, 'sup')}
                    className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    {copied === 'sup' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-xs text-[var(--text-muted)] mt-3 mb-2">Or build the desktop tray app:</p>
                <div className="relative group">
                  <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-xs text-indigo-300 font-mono overflow-x-auto whitespace-pre">{tauriCmd}</pre>
                  <button
                    onClick={() => copyText(tauriCmd, 'tauri')}
                    className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    {copied === 'tauri' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mt-2">
                  Produces an <code className="text-[var(--text-secondary)]">.msi</code> installer under <code className="text-[var(--text-secondary)]">src-tauri/target/release/bundle/msi/</code>.
                </p>
              </div>

              {/* SECONDARY: legacy agent */}
              <details className="bg-[var(--bg-tertiary)]/30 rounded-lg">
                <summary className="cursor-pointer px-3 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors select-none">
                  Alternative: run the agent manually per project
                </summary>
                <div className="px-3 pb-3 pt-1 space-y-2">
                  <p className="text-[10px] text-[var(--text-muted)]">
                    Runs a single agent in the foreground tied to the current directory. Useful for quick tests; not recommended for daily use.
                  </p>
                  <div className="relative group">
                    <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-xs text-indigo-300 font-mono overflow-x-auto">{agentCmd}</pre>
                    <button
                      onClick={() => copyText(agentCmd, 'cmd')}
                      className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                    >
                      {copied === 'cmd' ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              </details>

              <button
                onClick={() => { setNewKey(null); onClose() }}
                className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-[var(--text-on-accent)] font-medium transition-colors"
              >
                Done
              </button>
            </div>
          ) : activeKey ? (
            /* Has an active key */
            <div className="space-y-4">
              <div className="p-4 bg-[var(--bg-tertiary)] rounded-xl">
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
            /* No active key */
            <div className="space-y-4">
              <div className="p-4 bg-[var(--bg-tertiary)] border border-[var(--border-color)] rounded-xl text-center">
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
    </div>
  )
}

import { useState } from 'react'

interface Props {
  token: string
  sessionName: string
  onClose: () => void
}

export function ConnectModal({ token, sessionName, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const [showManual, setShowManual] = useState(false)
  const hubUrl = import.meta.env.VITE_HUB_URL || window.location.origin

  const envContent = `HUB_URL=${hubUrl}\nHUB_TOKEN=${token}\nSESSION_ID=${sessionName}`

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-[var(--text-primary)]">Connect Claude Code</h2>
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none">&times;</button>
          </div>

          <p className="text-[var(--text-muted)] text-sm mb-6">
            Session <span className="text-[var(--text-primary)] font-medium">{sessionName}</span> created.
          </p>

          {/* Recommended: API Key flow */}
          <div className="mb-5 p-4 bg-indigo-900/20 border border-indigo-800/50 rounded-xl">
            <p className="text-sm text-indigo-300 font-semibold mb-2">Recommended: Use an API Key</p>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Generate an API key from the <strong className="text-[var(--text-primary)]">API Key</strong> button in the sidebar.
              Then your Claude Code sessions auto-connect — no manual token setup needed.
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              Already have a key? Sessions register automatically when you start Claude Code with the channel enabled.
            </p>
          </div>

          {/* Manual token fallback */}
          <button
            onClick={() => setShowManual(!showManual)}
            className="w-full text-left text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] mb-4 flex items-center gap-1 transition-colors"
          >
            <span className={`transition-transform ${showManual ? 'rotate-90' : ''}`}>&#9654;</span>
            Manual setup with session token
          </button>

          {showManual && (
            <div className="space-y-4">
              {/* Step 1 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[10px] font-bold flex items-center justify-center flex-shrink-0">1</span>
                  <h3 className="text-xs font-semibold text-[var(--text-secondary)]">Create config file</h3>
                </div>
                <p className="text-[11px] text-[var(--text-muted)] ml-7 mb-1.5">
                  Save to <code className="text-[var(--text-muted)]">~/.claude/channels/remo-code/.env</code>
                </p>
                <div className="ml-7 relative group">
                  <pre className="bg-[var(--code-bg)] rounded-lg p-2.5 text-[11px] text-emerald-300 font-mono overflow-x-auto whitespace-pre">{envContent}</pre>
                  <button
                    onClick={() => copyText(envContent, 'config')}
                    className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    {copied === 'config' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Step 2 */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="w-5 h-5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[10px] font-bold flex items-center justify-center flex-shrink-0">2</span>
                  <h3 className="text-xs font-semibold text-[var(--text-secondary)]">Start Claude Code</h3>
                </div>
                <div className="ml-7 relative group">
                  <pre className="bg-[var(--code-bg)] rounded-lg p-2.5 text-[11px] text-emerald-300 font-mono overflow-x-auto">{`claude --dangerously-load-development-channels plugin:remo-code@claude-plugins-official`}</pre>
                  <button
                    onClick={() => copyText('claude --dangerously-load-development-channels plugin:remo-code@claude-plugins-official', 'cmd')}
                    className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    {copied === 'cmd' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>

              {/* Token */}
              <div className="p-3 bg-amber-900/20 border border-amber-800/50 rounded-lg">
                <p className="text-[11px] text-amber-300 font-semibold mb-1.5">Session token (shown once):</p>
                <div className="relative group">
                  <code className="block bg-[var(--code-bg)] rounded-lg p-2.5 text-[11px] text-amber-200 font-mono break-all select-all">{token}</code>
                  <button
                    onClick={() => copyText(token, 'token')}
                    className="absolute top-1.5 right-1.5 px-2 py-0.5 text-[10px] bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  >
                    {copied === 'token' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <button
            onClick={onClose}
            className="w-full mt-4 py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-[var(--text-on-accent)] font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

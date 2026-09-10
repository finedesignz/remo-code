import { useState } from 'react'

interface Props {
  apiKey?: string
  onGenerateKey?: () => Promise<{ key: string } | null>
  onClose: () => void
}

const TRAY_APP_RELEASE_URL = 'https://github.com/finedesignz/remo-code/releases/latest'

export function ConnectModal({ apiKey, onGenerateKey, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const hubUrl = import.meta.env.VITE_HUB_URL || window.location.origin

  const displayKey = apiKey || generatedKey

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  const handleGenerate = async () => {
    if (!onGenerateKey) return
    setGenerating(true)
    const result = await onGenerateKey()
    if (result?.key) setGeneratedKey(result.key)
    setGenerating(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl ring-1 ring-white/5 max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-[var(--text-primary)]">Connect Claude Code</h2>
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none">&times;</button>
          </div>

          {/* Step 1: API key */}
          {!displayKey ? (
            <div className="mb-5 p-4 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              <p className="text-sm text-[var(--text-secondary)] mb-3">
                You need an API key first. Generate one now:
              </p>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
              >
                {generating ? 'Generating...' : 'Generate New API Key'}
              </button>
            </div>
          ) : (
            <div className="mb-5">
              <p className="text-xs text-[var(--text-muted)] mb-2">Your API key (shown once — copy it now):</p>
              {/* data-autofix-exclude: this is a live secret rendered as plain
                  DOM text — the AgentAutofix click-to-comment widget must
                  never ship it. See hub/src/agentautofix/. */}
              <div className="relative group" data-autofix-exclude="">
                <code className="block bg-[var(--code-bg)] rounded-lg p-3 text-xs text-emerald-200 font-mono break-all select-all">
                  {displayKey}
                </code>
                <button
                  onClick={() => copyText(displayKey, 'key')}
                  className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
                >
                  {copied === 'key' ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Tray app */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide font-semibold text-blue-300 bg-blue-600/20 ring-1 ring-blue-500/30 rounded">Step 2</span>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Install the Remo Code Supervisor desktop app</h3>
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Windows tray app. Download the latest <code className="text-[var(--text-secondary)]">.msi</code>, run the installer, and paste the API key from Step 1 into the first-run wizard. The supervisor auto-starts at login, watches your repo roots, and lets you launch Claude Code sessions remotely from this web UI.
            </p>

            <a
              href={TRAY_APP_RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
            >
              Download .msi from GitHub Releases &rarr;
            </a>
          </div>

          {/* Hub URL info */}
          <div className="mb-4 p-3 bg-[var(--bg-tertiary)]/30 rounded-lg">
            <p className="text-xs text-[var(--text-muted)]">
              Hub: <code className="text-[var(--text-secondary)]">{hubUrl}</code>
            </p>
          </div>

          <p className="text-xs text-[var(--text-muted)] mb-5">
            Sessions auto-register on first connect and resume automatically when you reconnect.
          </p>

          <button
            onClick={onClose}
            className="w-full py-3 bg-blue-600 hover:bg-blue-500 rounded-xl text-[var(--text-on-accent)] font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

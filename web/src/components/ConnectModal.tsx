import { useState } from 'react'

interface Props {
  apiKey?: string
  onGenerateKey?: () => Promise<{ key: string } | null>
  onClose: () => void
}

export function ConnectModal({ apiKey, onGenerateKey, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const hubUrl = import.meta.env.VITE_HUB_URL || window.location.origin

  const displayKey = apiKey || generatedKey
  const keyToken = displayKey || 'YOUR_API_KEY'

  const trayAppReleaseUrl = 'https://github.com/finedesignz/remo-code/releases/latest'
  const agentCmd = `npx remo-code-agent --api-key ${keyToken} --local-output`
  const aliasCmd = `alias claude-remote='npx remo-code-agent --api-key ${keyToken} --local-output'`

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
      <div className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-[var(--text-primary)]">Connect Claude Code</h2>
            <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-2xl leading-none">&times;</button>
          </div>

          {/* No key yet — prompt to generate first */}
          {!displayKey && (
            <div className="mb-5 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              <p className="text-sm text-[var(--text-secondary)] mb-2">
                You'll need an API key first. Replace <code className="text-amber-400">YOUR_API_KEY</code> below, or generate one now:
              </p>
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
              >
                {generating ? 'Generating...' : 'Generate New API Key'}
              </button>
            </div>
          )}

          {/* PRIMARY: Tray app download */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide font-semibold text-indigo-300 bg-indigo-600/20 ring-1 ring-indigo-500/30 rounded">Recommended</span>
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Download the Remo Code tray app</h3>
            </div>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Windows tray app that runs in the background, watches your repo roots, and lets you launch Claude Code sessions remotely from this web UI. First-run wizard takes the API key below and configures everything for you — no PowerShell, no NSSM, no Bun install required.
            </p>
            <a
              href={trayAppReleaseUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-sm text-[var(--text-on-accent)] font-medium transition-colors"
            >
              Download .msi from GitHub Releases &rarr;
            </a>
            <p className="text-[10px] text-[var(--text-muted)] mt-2">
              The first signed .msi is being prepared — if the latest release doesn't yet include a <code className="text-[var(--text-secondary)]">.msi</code> asset, watch <a href={trayAppReleaseUrl} target="_blank" rel="noreferrer" className="text-indigo-300 hover:text-indigo-200 underline">the releases page</a> or use the agent fallback below in the meantime.
            </p>
          </div>

          {/* SECONDARY: legacy agent (collapsed) */}
          <details className="mb-4 bg-[var(--bg-tertiary)]/30 rounded-lg group">
            <summary className="cursor-pointer px-3 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors select-none">
              Alternative: run the agent manually per project
            </summary>
            <div className="px-3 pb-3 pt-1 space-y-3">
              <p className="text-xs text-[var(--text-muted)]">
                Runs a single agent in the foreground tied to the current directory. Useful for quick tests; not recommended for daily use.
              </p>

              <div className="relative group/cmd">
                <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-xs text-emerald-300 font-mono overflow-x-auto whitespace-pre">{agentCmd}</pre>
                <button
                  onClick={() => copyText(agentCmd, 'agent')}
                  className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover/cmd:opacity-100"
                >
                  {copied === 'agent' ? 'Copied!' : 'Copy'}
                </button>
              </div>

              <div>
                <p className="text-xs text-[var(--text-muted)] mb-2">
                  Or add a shell alias so you can just run <code className="text-[var(--text-secondary)]">claude-remote</code>:
                </p>
                <div className="relative group/alias">
                  <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-xs text-emerald-300 font-mono overflow-x-auto whitespace-pre">{aliasCmd}</pre>
                  <button
                    onClick={() => copyText(aliasCmd, 'alias')}
                    className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover/alias:opacity-100"
                  >
                    {copied === 'alias' ? 'Copied!' : 'Copy'}
                  </button>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] mt-2">
                  Add to <code className="text-[var(--text-secondary)]">~/.bashrc</code> or <code className="text-[var(--text-secondary)]">~/.zshrc</code>, reload your shell, then run <code className="text-[var(--text-secondary)]">claude-remote</code>.
                </p>
              </div>
            </div>
          </details>

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
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-[var(--text-on-accent)] font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

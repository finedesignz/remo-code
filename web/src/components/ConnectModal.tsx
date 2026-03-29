import { useState } from 'react'

interface Props {
  apiKey?: string
  onGenerateKey?: () => Promise<{ key: string } | null>
  onClose: () => void
}

export function ConnectModal({ apiKey, onGenerateKey, onClose }: Props) {
  const [copied, setCopied] = useState(false)
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const hubUrl = import.meta.env.VITE_HUB_URL || window.location.origin

  const displayKey = apiKey || generatedKey
  const agentCmd = displayKey
    ? `npx remo-code-agent --api-key ${displayKey} --local-output`
    : 'npx remo-code-agent --api-key YOUR_API_KEY --local-output'

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
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

          <p className="text-[var(--text-muted)] text-sm mb-4">
            Run this command in your project directory:
          </p>

          {/* Agent command */}
          <div className="relative group mb-4">
            <pre className="bg-[var(--code-bg)] rounded-lg p-3 text-sm text-emerald-300 font-mono overflow-x-auto whitespace-pre">{agentCmd}</pre>
            {displayKey && (
              <button
                onClick={() => copyText(agentCmd)}
                className="absolute top-2 right-2 px-2 py-1 text-xs bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] rounded transition-colors opacity-100 md:opacity-0 md:group-hover:opacity-100"
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            )}
          </div>

          {/* No key available — show generate button */}
          {!displayKey && (
            <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              <p className="text-sm text-[var(--text-secondary)] mb-2">
                Replace <code className="text-amber-400">YOUR_API_KEY</code> with your API key from Settings.
              </p>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                Don't have your key saved? Generate a new one:
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

          {/* Hub URL info */}
          <div className="mb-4 p-3 bg-[var(--bg-tertiary)]/30 border border-[var(--border-color)] rounded-lg">
            <p className="text-xs text-[var(--text-muted)]">
              Hub: <code className="text-[var(--text-secondary)]">{hubUrl}</code>
            </p>
          </div>

          <p className="text-xs text-[var(--text-muted)] mb-5">
            The agent auto-registers a session for your project directory. Sessions resume automatically when you reconnect.
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

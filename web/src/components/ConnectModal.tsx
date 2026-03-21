import { useState } from 'react'

interface Props {
  token: string
  sessionName: string
  onClose: () => void
}

export function ConnectModal({ token, sessionName, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null)
  const hubUrl = import.meta.env.VITE_HUB_URL || window.location.origin

  const envContent = `HUB_URL=${hubUrl}\nHUB_TOKEN=${token}\nSESSION_ID=${sessionName}`

  const copyText = (text: string, label: string) => {
    navigator.clipboard.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied(null), 2000)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-slate-800 border border-slate-700 rounded-2xl shadow-2xl max-w-lg w-full max-h-[90vh] overflow-y-auto">
        <div className="p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-white">Connect Claude Code</h2>
            <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl leading-none">&times;</button>
          </div>

          <p className="text-slate-400 text-sm mb-6">
            Session <span className="text-white font-medium">{sessionName}</span> created. Follow these steps to connect your local Claude Code session.
          </p>

          {/* Step 1 */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">1</span>
              <h3 className="text-sm font-semibold text-white">Install the channel plugin</h3>
            </div>
            <p className="text-xs text-slate-400 ml-8 mb-2">In your Claude Code session, run:</p>
            <div className="ml-8 relative">
              <pre className="bg-slate-900 rounded-lg p-3 text-xs text-emerald-300 font-mono overflow-x-auto">
                /plugin install hub@claude-plugins-official
              </pre>
            </div>
          </div>

          {/* Step 2 */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">2</span>
              <h3 className="text-sm font-semibold text-white">Create the config file</h3>
            </div>
            <p className="text-xs text-slate-400 ml-8 mb-2">
              Save this to <code className="text-slate-300 bg-slate-900 px-1 rounded">~/.claude/channels/hub/.env</code>
            </p>
            <div className="ml-8 relative group">
              <pre className="bg-slate-900 rounded-lg p-3 text-xs text-emerald-300 font-mono overflow-x-auto whitespace-pre">
{envContent}
              </pre>
              <button
                onClick={() => copyText(envContent, 'config')}
                className="absolute top-2 right-2 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
              >
                {copied === 'config' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Step 3 */}
          <div className="mb-5">
            <div className="flex items-center gap-2 mb-2">
              <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center flex-shrink-0">3</span>
              <h3 className="text-sm font-semibold text-white">Start Claude Code with the channel</h3>
            </div>
            <p className="text-xs text-slate-400 ml-8 mb-2">Exit Claude Code and restart with:</p>
            <div className="ml-8 relative group">
              <pre className="bg-slate-900 rounded-lg p-3 text-xs text-emerald-300 font-mono overflow-x-auto">
claude --dangerously-load-development-channels server:hub
              </pre>
              <button
                onClick={() => copyText('claude --dangerously-load-development-channels server:hub', 'cmd')}
                className="absolute top-2 right-2 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
              >
                {copied === 'cmd' ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>

          {/* Token */}
          <div className="mb-5 p-4 bg-amber-900/20 border border-amber-800/50 rounded-xl">
            <p className="text-xs text-amber-300 font-semibold mb-2">Your session token (shown once):</p>
            <div className="relative">
              <code className="block bg-slate-900 rounded-lg p-3 text-xs text-amber-200 font-mono break-all select-all">
                {token}
              </code>
              <button
                onClick={() => copyText(token, 'token')}
                className="absolute top-2 right-2 px-2 py-1 text-xs bg-slate-700 hover:bg-slate-600 text-slate-300 rounded transition-colors"
              >
                {copied === 'token' ? 'Copied!' : 'Copy'}
              </button>
            </div>
            <p className="text-[10px] text-amber-400/60 mt-2">
              This token will not be shown again. If lost, you can rotate it from the session settings.
            </p>
          </div>

          {/* Done */}
          <button
            onClick={onClose}
            className="w-full py-3 bg-indigo-600 hover:bg-indigo-500 rounded-xl text-white font-medium transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

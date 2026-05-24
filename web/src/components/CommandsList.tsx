import { useMemo, useState } from 'react'
import { useCommands, groupCommands, filterCommands, type CommandRow } from '../hooks/useCommands'

interface Props { token: string }

export function CommandsList({ token }: Props) {
  const { rows, loading, error, refetch } = useCommands(token)
  const [q, setQ] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const filtered = useMemo(() => filterCommands(rows, q), [rows, q])
  const groups = useMemo(() => groupCommands(filtered), [filtered])

  const copy = (name: string, kind: 'command' | 'skill') => {
    const text = kind === 'skill' ? `/${name}` : `/${name} `
    navigator.clipboard.writeText(text).catch(() => {})
    setCopied(name)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="space-y-4">
      <div className="bg-[var(--bg-secondary)]/60 rounded-xl p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">Commands & Skills</h3>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Built-in Claude Code commands plus user, plugin, and skill commands synced from your supervisor.
            </p>
          </div>
          <button
            onClick={refetch}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
          >
            Refresh
          </button>
        </div>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Filter by name, description, or source..."
          className="w-full px-3 py-2 bg-[var(--bg-primary)]/60 rounded-lg text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
        {loading && <p className="text-xs text-[var(--text-muted)] mt-2">Loading...</p>}
        {!loading && rows.length === 0 && (
          <p className="text-xs text-[var(--text-muted)] mt-2">
            No commands synced yet. Run <code className="text-emerald-300">remo-code-supervisor</code> on your machine
            to sync built-ins, user commands, and plugins.
          </p>
        )}
      </div>

      {groups.map((g) => (
        <div key={g.key} className="bg-[var(--bg-secondary)]/60 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">{g.label}</span>
            <span className="text-[10px] text-[var(--text-muted)]">{g.items.length}</span>
          </div>
          <div className="divide-y divide-[var(--border-color)]/30">
            {g.items.map((c) => (
              <CommandRowItem
                key={`${c.kind}:${c.name}:${c.source}`}
                cmd={c}
                copied={copied === c.name}
                onCopy={() => copy(c.name, c.kind)}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function CommandRowItem({ cmd, copied, onCopy }: { cmd: CommandRow; copied: boolean; onCopy: () => void }) {
  return (
    <div className="px-4 py-2 flex items-center gap-3 hover:bg-[var(--bg-tertiary)]/40 transition-colors group">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 flex-wrap">
          <code className="text-sm font-mono text-indigo-300">/{cmd.name}</code>
          {cmd.kind === 'skill' && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20">skill</span>
          )}
          <span className="text-[10px] text-[var(--text-muted)]">{cmd.source}</span>
        </div>
        {cmd.description && (
          <div className="text-xs text-[var(--text-muted)] mt-0.5 truncate" title={cmd.description}>
            {cmd.description}
          </div>
        )}
      </div>
      <button
        onClick={onCopy}
        className="shrink-0 p-1.5 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/60 transition-colors"
        title={`Copy /${cmd.name}`}
        aria-label={`Copy /${cmd.name}`}
      >
        {copied ? (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8l3.5 3.5L13 5" />
          </svg>
        ) : (
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="5" width="8" height="9" rx="1.5" />
            <path d="M3 11V3a1 1 0 0 1 1-1h6" />
          </svg>
        )}
      </button>
    </div>
  )
}

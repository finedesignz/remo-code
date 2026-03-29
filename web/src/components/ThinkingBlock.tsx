import { useState } from 'react'

interface Props {
  content: string
  isStreaming: boolean
}

export function ThinkingBlock({ content, isStreaming }: Props) {
  const [expanded, setExpanded] = useState(false)

  if (!content) return null

  const preview = content.length > 100 ? content.slice(0, 100) + '...' : content

  return (
    <div className="rounded-lg bg-[var(--bg-tertiary)]/50 border border-[var(--border-color)] text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
      >
        <span className="shrink-0">
          {isStreaming ? (
            <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          ) : (
            <span className="inline-block w-2 h-2 rounded-full bg-slate-500" />
          )}
        </span>
        <span className="font-medium">Thinking</span>
        <span className="text-[var(--text-muted)] truncate flex-1">{!expanded && preview}</span>
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-2 text-[var(--text-secondary)] whitespace-pre-wrap break-words">
          {content}
          {isStreaming && <span className="inline-block w-1 h-3 bg-amber-400 ml-0.5 animate-pulse" />}
        </div>
      )}
    </div>
  )
}

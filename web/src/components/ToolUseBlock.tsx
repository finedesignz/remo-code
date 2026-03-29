import { useState } from 'react'

interface ToolCall {
  tool: string
  tool_id: string
  input: unknown
  result?: string
  is_error?: boolean
  done: boolean
}

interface Props {
  toolCall: ToolCall
}

export function ToolUseBlock({ toolCall }: Props) {
  const [expanded, setExpanded] = useState(false)

  const statusColor = toolCall.done
    ? toolCall.is_error
      ? 'text-red-400'
      : 'text-emerald-400'
    : 'text-amber-400'

  return (
    <div className="rounded-lg bg-[var(--bg-tertiary)]/50 border border-[var(--border-color)] text-xs">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
      >
        <span className={`shrink-0 ${statusColor}`}>
          {toolCall.done ? (
            toolCall.is_error ? (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="3" y1="3" x2="9" y2="9" />
                <line x1="9" y1="3" x2="3" y2="9" />
              </svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M2.5 6L5 8.5L9.5 3.5" />
              </svg>
            )
          ) : (
            <span className="inline-block w-2.5 h-2.5 rounded-full border-2 border-amber-400 border-t-transparent animate-spin" />
          )}
        </span>
        <span className="font-medium font-mono">{toolCall.tool}</span>
        {toolCall.done && !toolCall.is_error && (
          <span className="text-[var(--text-muted)]">Done</span>
        )}
        {toolCall.is_error && (
          <span className="text-red-400">Error</span>
        )}
        <svg
          width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={`ml-auto shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M2 3.5L5 6.5L8 3.5" />
        </svg>
      </button>
      {expanded && (
        <div className="px-3 pb-2 space-y-1">
          <pre className="text-[var(--text-muted)] overflow-x-auto text-[10px]">
            {JSON.stringify(toolCall.input, null, 2)?.slice(0, 500)}
          </pre>
          {toolCall.result && (
            <pre className={`overflow-x-auto text-[10px] ${toolCall.is_error ? 'text-red-400' : 'text-[var(--text-secondary)]'}`}>
              {toolCall.result.slice(0, 1000)}
              {toolCall.result.length > 1000 && '...'}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

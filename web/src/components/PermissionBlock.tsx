import { useState } from 'react'
import type { PermissionRequest } from '../hooks/useActivity'

interface Props {
  permission: PermissionRequest
  onRespond: (requestId: string, approved: boolean) => void
}

export function PermissionBlock({ permission, onRespond }: Props) {
  const [responded, setResponded] = useState(false)

  const handleRespond = (approved: boolean) => {
    setResponded(true)
    onRespond(permission.request_id, approved)
  }

  const inputStr = typeof permission.tool_input === 'object'
    ? JSON.stringify(permission.tool_input, null, 2)
    : String(permission.tool_input)

  return (
    <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 text-sm overflow-hidden">
      <div className="px-3 py-2.5 flex items-start gap-2.5">
        <span className="text-amber-400 mt-0.5 shrink-0">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 1.5L14.5 13H1.5L8 1.5Z" />
            <path d="M8 6V9" />
            <circle cx="8" cy="11" r="0.5" fill="currentColor" />
          </svg>
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-amber-300 font-medium">Permission Required</span>
          </div>
          <div className="text-[var(--text-secondary)] font-mono text-xs mb-2">
            <span className="text-[var(--text-primary)] font-semibold">{permission.tool_name}</span>
          </div>
          <pre className="text-[var(--text-muted)] text-[10px] overflow-x-auto max-h-32 overflow-y-auto mb-2.5 whitespace-pre-wrap break-all">
            {inputStr.slice(0, 1000)}
            {inputStr.length > 1000 && '...'}
          </pre>

          {!responded ? (
            <div className="flex gap-2">
              <button
                onClick={() => handleRespond(true)}
                className="px-3 py-1.5 rounded-md bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/30 transition-colors text-xs font-medium"
              >
                Allow
              </button>
              <button
                onClick={() => handleRespond(false)}
                className="px-3 py-1.5 rounded-md bg-red-500/20 text-red-400 border border-red-500/30 hover:bg-red-500/30 transition-colors text-xs font-medium"
              >
                Deny
              </button>
            </div>
          ) : (
            <div className="text-xs text-[var(--text-muted)]">Response sent</div>
          )}
        </div>
      </div>
    </div>
  )
}

import type { CodeSession } from '../hooks/useSessions'
import { sessionLabel, shortId } from './SessionDropdown'

export function timeAgo(dateStr: string | null): string {
  if (!dateStr) return 'never'
  const diff = Date.now() - new Date(dateStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

interface Props {
  session: CodeSession
  messageCount?: number
  lastMessage?: string
}

export function SessionTooltip({ session, messageCount, lastMessage }: Props) {
  return (
    <div className="p-2.5 max-w-[260px]">
      <div className="font-medium text-[var(--text-primary)] text-sm leading-tight">
        {sessionLabel(session)}
      </div>
      <div className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
        {shortId(session)}
      </div>
      {session.project_dir && (
        <div className="text-[11px] text-[var(--text-secondary)] mt-1.5 truncate">
          {session.project_dir}
        </div>
      )}
      {lastMessage && (
        <div className="text-[11px] text-[var(--text-secondary)] mt-1.5 line-clamp-2 italic">
          {lastMessage.length > 60 ? lastMessage.slice(0, 60) + '...' : lastMessage}
        </div>
      )}
      <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--text-muted)]">
        <span>Active: {timeAgo(session.last_activity)}</span>
        {messageCount !== undefined && (
          <span>{messageCount} msg{messageCount !== 1 ? 's' : ''}</span>
        )}
      </div>
      <div className="text-[11px] text-[var(--text-muted)] mt-0.5 capitalize">
        Status: {session.status}
      </div>
    </div>
  )
}

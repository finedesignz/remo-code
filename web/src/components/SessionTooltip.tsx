import type { CodeSession } from '../hooks/useSessions'
import { githubOwnerRepo } from '../hooks/useSessions'
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
  const ownerRepo = githubOwnerRepo(session)
  return (
    <div className="p-2.5 max-w-[260px]">
      <div className="font-medium text-[var(--text-primary)] text-sm leading-tight flex items-center gap-1.5">
        {ownerRepo ? (
          <>
            {/* GitHub mark — keyed session */}
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" className="text-[var(--text-muted)] shrink-0">
              <path d="M8 .25a8 8 0 0 0-2.53 15.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8.25 8 8 0 0 0 8 .25z" />
            </svg>
            <span className="truncate">github.com/{ownerRepo}</span>
          </>
        ) : (
          sessionLabel(session)
        )}
      </div>
      <div className="text-[10px] text-[var(--text-muted)] font-mono mt-0.5">
        {shortId(session)}
      </div>
      {session.project_dir && (
        <div className="text-[11px] text-[var(--text-secondary)] mt-1.5 truncate">
          {ownerRepo ? <span className="text-[var(--text-muted)]">Connected from: </span> : null}
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

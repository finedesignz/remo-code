import type { ChatMessage } from '../hooks/useChat'
import type { ActivityState } from '../hooks/useActivity'
import { ChatSurface } from './ChatSurface'

interface Props {
  messages: ChatMessage[]
  loading: boolean
  onSend: (content: string, images?: Array<{ media_type: string; data: string }>) => void
  activeSessionId: string | null
  sessionStatus?: string
  activity: ActivityState
  onPermissionRespond: (requestId: string, approved: boolean) => void
  onQuestionRespond: (requestId: string, answer: string) => void
  token?: string
  wsConnected?: boolean
}

/**
 * <ChatPanel> — thin wrapper that mounts <ChatSurface density="full"> for the
 * single-chat page (`#/chat`). All chat rendering, input, and streaming logic
 * lives in <ChatSurface>. Layout.tsx keeps importing this component unchanged.
 */
export function ChatPanel({
  messages,
  loading,
  onSend,
  activeSessionId,
  activity,
  onPermissionRespond,
  onQuestionRespond,
  token,
  wsConnected = true,
}: Props) {
  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-[var(--text-muted)]">
        Select a session from the sidebar to start chatting
      </div>
    )
  }

  return (
    <ChatSurface
      density="full"
      sessionId={activeSessionId}
      messages={messages}
      loading={loading}
      activity={activity}
      onSend={onSend}
      onPermissionRespond={onPermissionRespond}
      onQuestionRespond={onQuestionRespond}
      token={token}
      wsConnected={wsConnected}
    />
  )
}

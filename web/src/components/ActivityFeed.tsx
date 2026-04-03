import type { ActivityState } from '../hooks/useActivity'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolUseBlock } from './ToolUseBlock'
import { PermissionBlock } from './PermissionBlock'
import { QuestionBlock } from './QuestionBlock'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

interface Props {
  activity: ActivityState
  onPermissionRespond: (requestId: string, approved: boolean) => void
  onQuestionRespond: (requestId: string, answer: string) => void
}

export function ActivityFeed({ activity, onPermissionRespond, onQuestionRespond }: Props) {
  if (activity.status === 'idle' && !activity.pendingPermission && !activity.pendingQuestion) return null

  return (
    <div className="flex justify-start animate-msg-in">
      <div className="max-w-[80%] space-y-2 w-full">
        {/* Thinking */}
        {activity.thinkingText && (
          <ThinkingBlock
            content={activity.thinkingText}
            isStreaming={activity.status === 'thinking'}
          />
        )}

        {/* Tool calls */}
        {activity.toolCalls.map(tc => (
          <ToolUseBlock key={tc.tool_id} toolCall={tc} />
        ))}

        {/* Permission request */}
        {activity.pendingPermission && (
          <PermissionBlock
            permission={activity.pendingPermission}
            onRespond={onPermissionRespond}
          />
        )}

        {/* User question */}
        {activity.pendingQuestion && (
          <QuestionBlock
            question={activity.pendingQuestion}
            onRespond={onQuestionRespond}
          />
        )}

        {/* Streaming text */}
        {activity.streamingText && (
          <div className="rounded-xl px-4 py-2.5 text-sm bg-[var(--bg-tertiary)]/70 text-[var(--text-primary)]">
            <div className="prose prose-sm max-w-none [&_pre]:bg-[var(--code-bg)] [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:text-emerald-300 [&_a]:text-indigo-400 break-words prose-headings:text-[var(--text-primary)] prose-p:text-[var(--text-primary)] prose-strong:text-[var(--text-primary)] prose-li:text-[var(--text-primary)] prose-blockquote:text-[var(--text-secondary)] prose-code:text-emerald-300 prose-th:text-[var(--text-primary)] prose-td:text-[var(--text-primary)]">
              <Markdown rehypePlugins={[rehypeSanitize]}>
                {activity.streamingText}
              </Markdown>
              {activity.status === 'writing' && (
                <span className="inline-block w-1.5 h-4 bg-indigo-400 ml-0.5 animate-pulse" />
              )}
            </div>
          </div>
        )}

        {/* Status indicator when no text yet */}
        {!activity.streamingText && !activity.thinkingText && activity.toolCalls.length === 0 && !activity.pendingPermission && (
          <div className="bg-[var(--bg-tertiary)]/70 rounded-xl px-4 py-3 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[var(--text-muted)] animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-2 h-2 rounded-full bg-[var(--text-muted)] animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-2 h-2 rounded-full bg-[var(--text-muted)] animate-bounce" style={{ animationDelay: '300ms' }} />
            <span className="text-xs text-[var(--text-muted)] ml-2">Claude is working...</span>
          </div>
        )}
      </div>
    </div>
  )
}

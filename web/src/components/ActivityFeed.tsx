import type { ActivityState } from '../hooks/useActivity'
import { ThinkingBlock } from './ThinkingBlock'
import { ToolUseBlock } from './ToolUseBlock'
import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'

interface Props {
  activity: ActivityState
}

export function ActivityFeed({ activity }: Props) {
  if (activity.status === 'idle') return null

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

        {/* Streaming text */}
        {activity.streamingText && (
          <div className="rounded-xl px-4 py-2.5 text-sm bg-[var(--bg-tertiary)]/70 text-[var(--text-primary)]">
            <div className="prose prose-sm prose-invert max-w-none [&_pre]:bg-slate-900 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:text-emerald-300 [&_a]:text-indigo-400 break-words">
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
        {!activity.streamingText && !activity.thinkingText && activity.toolCalls.length === 0 && (
          <div className="bg-[var(--bg-tertiary)]/70 rounded-xl px-4 py-3 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
            <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
            <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
            <span className="text-xs text-slate-400 ml-2">Claude is working...</span>
          </div>
        )}
      </div>
    </div>
  )
}

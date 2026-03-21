import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import type { ChatMessage } from '../hooks/useChat'

interface Props {
  message: ChatMessage
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm ${
          isUser
            ? 'bg-indigo-600 text-white'
            : 'bg-slate-700/70 text-slate-200'
        }`}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm prose-invert max-w-none [&_pre]:bg-slate-900 [&_pre]:rounded-lg [&_pre]:p-3 [&_code]:text-emerald-300 [&_a]:text-indigo-400">
            <Markdown
              rehypePlugins={[rehypeSanitize]}
              components={{ a: ({ children, href, ...props }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
              )}}
            >{message.content}</Markdown>
          </div>
        )}
        <div className={`text-[10px] mt-1 ${isUser ? 'text-indigo-200' : 'text-slate-500'}`}>
          {new Date(message.created_at).toLocaleTimeString()}
        </div>
      </div>
    </div>
  )
}

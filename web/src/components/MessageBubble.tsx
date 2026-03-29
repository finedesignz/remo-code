import Markdown from 'react-markdown'
import rehypeSanitize from 'rehype-sanitize'
import type { ChatMessage } from '../hooks/useChat'

interface Props {
  message: ChatMessage
}

// Extract data URI images from message content and return them separately
function extractImages(content: string): { images: string[]; text: string } {
  const images: string[] = []
  const text = content.replace(/!\[.*?\]\((data:image\/[^)]+)\)/g, (_, dataUri) => {
    images.push(dataUri)
    return ''
  }).trim()
  return { images, text }
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === 'user'
  const { images, text } = extractImages(message.content)

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[80%] rounded-xl px-4 py-2.5 text-sm overflow-hidden ${
          isUser
            ? 'bg-indigo-600 text-[var(--text-on-accent)]'
            : 'bg-[var(--bg-tertiary)]/70 text-[var(--text-primary)]'
        }`}
      >
        {/* Inline images */}
        {images.map((src, i) => (
          <img key={i} src={src} alt="" className="rounded-lg max-h-64 w-auto mb-2" />
        ))}

        {isUser ? (
          text ? <p className="whitespace-pre-wrap break-words">{text}</p> : null
        ) : (
          <div className="prose prose-sm max-w-none [&_pre]:bg-[var(--code-bg)] [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_code]:text-emerald-300 [&_a]:text-indigo-400 break-words prose-headings:text-[var(--text-primary)] prose-p:text-[var(--text-primary)] prose-strong:text-[var(--text-primary)] prose-li:text-[var(--text-primary)] prose-blockquote:text-[var(--text-secondary)] prose-code:text-emerald-300 prose-th:text-[var(--text-primary)] prose-td:text-[var(--text-primary)]">
            <Markdown
              rehypePlugins={[rehypeSanitize]}
              components={{ a: ({ children, href, ...props }) => (
                <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
              )}}
            >{text || message.content}</Markdown>
          </div>
        )}
        <div className={`text-[10px] mt-1 ${isUser ? 'text-indigo-200' : 'text-[var(--text-muted)]'}`}>
          {new Date(message.created_at).toLocaleTimeString()}
        </div>
      </div>
    </div>
  )
}

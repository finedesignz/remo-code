import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
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
          <div className="max-w-none break-words text-[var(--text-primary)]
            [&_pre]:bg-[var(--code-bg)] [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:my-2
            [&_code]:text-emerald-300
            [&_a]:text-indigo-400 [&_a]:underline
            [&_p]:my-1.5 [&_p]:leading-relaxed
            [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-2 [&_ul]:space-y-1
            [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-2 [&_ol]:space-y-1
            [&_li]:marker:text-[var(--text-muted)]
            [&_ul_ul]:list-[circle] [&_ul_ul_ul]:list-[square] [&_ul_ul]:my-1 [&_ol_ol]:my-1
            [&_h1]:text-base [&_h1]:font-semibold [&_h1]:mt-3 [&_h1]:mb-1.5
            [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:mt-3 [&_h2]:mb-1.5
            [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:mt-2 [&_h3]:mb-1
            [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--border-color)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--text-secondary)] [&_blockquote]:my-2
            [&_table]:text-xs [&_table]:border-collapse [&_th]:border [&_th]:border-[var(--border-color)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-[var(--border-color)] [&_td]:px-2 [&_td]:py-1
            [&_hr]:border-[var(--border-color)] [&_hr]:my-3">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={{
                a: ({ children, href, ...props }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>
                ),
                table: ({ children }) => (
                  <div className="overflow-x-auto -mx-2"><table>{children}</table></div>
                ),
              }}
            >{text || message.content}</Markdown>
          </div>
        )}
        <div className={`text-[10px] mt-1 flex items-center gap-2 ${isUser ? 'text-indigo-200' : 'text-[var(--text-muted)]'}`}>
          <span>{new Date(message.created_at).toLocaleTimeString()}</span>
          {message.status === 'interrupted' && (
            <span className="px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 text-[10px] font-medium">
              [interrupted]
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

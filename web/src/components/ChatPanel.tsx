import { useState, useEffect, useRef, useCallback } from 'react'
import type { ChatMessage } from '../hooks/useChat'
import { MessageBubble } from './MessageBubble'

interface Props {
  messages: ChatMessage[]
  loading: boolean
  onSend: (content: string) => void
  activeSessionId: string | null
  sessionStatus?: string
}

export function ChatPanel({ messages, loading, onSend, activeSessionId, sessionStatus }: Props) {
  const [input, setInput] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)
  const isNearBottom = useRef(true)

  // Track whether user is near bottom of chat
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isNearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100
  }, [])

  // Only auto-scroll if user is near bottom
  useEffect(() => {
    if (isNearBottom.current && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [messages, sessionStatus])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || !activeSessionId) return
    onSend(input.trim())
    setInput('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit(e)
    }
  }

  const isThinking = sessionStatus === 'thinking'

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-slate-500">
        Select a session from the sidebar to start chatting
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto p-4 space-y-3 chat-scroll"
      >
        {loading && (
          <div className="text-center text-slate-500 text-sm py-4">Loading messages...</div>
        )}
        {!loading && messages.length === 0 && (
          <div className="text-center text-slate-500 text-sm py-8">
            No messages yet. Send a message to Claude.
          </div>
        )}
        {messages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}

        {/* Typing indicator */}
        {isThinking && (
          <div className="flex justify-start animate-msg-in">
            <div className="bg-slate-700/70 rounded-xl px-4 py-3 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-slate-400 animate-bounce" style={{ animationDelay: '300ms' }} />
              <span className="text-xs text-slate-400 ml-2">Claude is working...</span>
            </div>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="p-4 pb-[max(1rem,env(safe-area-inset-bottom))] border-t border-[var(--border-color)]">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Send a message to Claude..."
            rows={1}
            className="flex-1 px-4 py-2.5 bg-[var(--bg-input)] border border-[var(--border-color)] rounded-lg text-sm text-[var(--text-primary)] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none max-h-32"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 rounded-lg text-sm text-white font-medium transition-colors shrink-0"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  )
}

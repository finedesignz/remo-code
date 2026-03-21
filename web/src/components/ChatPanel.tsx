import { useState, useEffect, useRef } from 'react'
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
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, sessionStatus])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || !activeSessionId) return
    onSend(input.trim())
    setInput('')
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
    <div className="flex-1 flex flex-col">
      <div className="flex-1 overflow-y-auto p-4 space-y-3 chat-scroll">
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

        <div ref={bottomRef} />
      </div>

      <form onSubmit={handleSubmit} className="p-4 border-t border-slate-700">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Send a message to Claude..."
            className="flex-1 px-4 py-2.5 bg-slate-800 border border-slate-600 rounded-lg text-sm text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:hover:bg-indigo-600 rounded-lg text-sm text-white font-medium transition-colors"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  )
}

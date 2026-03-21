import { useState, useEffect, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

export function useChat(
  session: Session | null,
  activeSessionId: string | null,
  subscribe: (handler: (msg: any) => void) => () => void,
  send: (msg: object) => void,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)

  // Fetch history when session changes
  useEffect(() => {
    if (!session?.access_token || !activeSessionId) {
      setMessages([])
      return
    }

    setLoading(true)
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/messages/${activeSessionId}?limit=50`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        setMessages(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [session?.access_token, activeSessionId])

  // Subscribe to live messages
  useEffect(() => {
    if (!activeSessionId) return

    // Subscribe to session updates
    send({ type: 'subscribe', session_ids: [activeSessionId] })

    return subscribe((msg) => {
      if (msg.type === 'message' && msg.session_id === activeSessionId) {
        setMessages(prev => {
          // Deduplicate by id
          if (prev.some(m => m.id === msg.message.id)) return prev
          return [...prev, msg.message]
        })
      }
    })
  }, [activeSessionId, subscribe, send])

  const sendMessage = useCallback((content: string) => {
    if (!activeSessionId) return
    send({
      type: 'send_message',
      session_id: activeSessionId,
      content,
      id: crypto.randomUUID(),
    })
  }, [activeSessionId, send])

  return { messages, loading, sendMessage }
}

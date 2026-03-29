import { useState, useEffect, useCallback, useRef } from 'react'
import type { Session } from '@supabase/supabase-js'

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  created_at: string
}

const UNREAD_STORAGE_KEY = 'remo-code:unread'

function loadUnread(): Record<string, number> {
  try {
    const raw = localStorage.getItem(UNREAD_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function saveUnread(counts: Record<string, number>) {
  try {
    localStorage.setItem(UNREAD_STORAGE_KEY, JSON.stringify(counts))
  } catch {}
}

export function useChat(
  session: Session | null,
  activeSessionId: string | null,
  subscribe: (handler: (msg: any) => void) => () => void,
  send: (msg: object) => void,
  connectionId: number,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>(loadUnread)
  const activeSessionRef = useRef(activeSessionId)

  // Keep ref in sync
  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

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
      if (msg.type === 'message') {
        const incomingSessionId = msg.session_id as string
        const incomingMessage = msg.message as ChatMessage

        if (incomingSessionId === activeSessionRef.current) {
          // Active session: show message, deduplicate
          setMessages(prev => {
            if (prev.some(m => m.id === incomingMessage.id)) return prev
            return [...prev, incomingMessage]
          })
        }

        // Track unread for non-active sessions (assistant messages only)
        if (incomingSessionId !== activeSessionRef.current && incomingMessage.role === 'assistant') {
          setUnreadCounts(prev => {
            const next = { ...prev, [incomingSessionId]: (prev[incomingSessionId] || 0) + 1 }
            saveUnread(next)
            return next
          })
        }
      }
    })
  }, [activeSessionId, subscribe, send, connectionId])

  // Mark active session as read when switching to it
  const markRead = useCallback((sessionId: string) => {
    setUnreadCounts(prev => {
      if (!prev[sessionId]) return prev
      const next = { ...prev }
      delete next[sessionId]
      saveUnread(next)
      return next
    })
  }, [])

  // Auto-mark read when active session changes
  useEffect(() => {
    if (activeSessionId) {
      markRead(activeSessionId)
    }
  }, [activeSessionId, markRead])

  const sendMessage = useCallback((content: string, images?: Array<{ media_type: string; data: string }>) => {
    if (!activeSessionId) return
    const id = crypto.randomUUID()
    const msg: any = { type: 'send_message', session_id: activeSessionId, content, id }
    if (images?.length) msg.images = images
    send(msg)
    // No optimistic add — the hub broadcasts the stored message back to us
    // which avoids duplicate messages (the DB generates a different UUID)
  }, [activeSessionId, send])

  return { messages, loading, sendMessage, unreadCounts, markRead }
}

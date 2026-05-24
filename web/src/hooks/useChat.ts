import { useState, useEffect, useCallback, useRef } from 'react'

export interface ChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'streaming' | 'complete' | 'interrupted'
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
  token: string | null,
  activeSessionId: string | null,
  subscribe: (handler: (msg: any) => void) => () => void,
  send: (msg: object) => void,
  connectionId: number,
) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loading, setLoading] = useState(false)
  const [unreadCounts, setUnreadCounts] = useState<Record<string, number>>(loadUnread)
  const activeSessionRef = useRef(activeSessionId)
  const lastFetchRef = useRef<Record<string, number>>({})

  // Keep ref in sync
  useEffect(() => {
    activeSessionRef.current = activeSessionId
  }, [activeSessionId])

  // Fetch message history. If `throttle` true, skip if last fetch for this
  // session was <2s ago (coalesces alt-tab spam). Session-change fetches
  // bypass the throttle so switching always feels instant.
  const fetchMessages = useCallback((opts?: { throttle?: boolean }) => {
    if (!token || !activeSessionId) return
    if (opts?.throttle) {
      const last = lastFetchRef.current[activeSessionId] || 0
      if (Date.now() - last < 2000) return
    }
    lastFetchRef.current[activeSessionId] = Date.now()
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/messages/${activeSessionId}?limit=50`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        setMessages(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [token, activeSessionId])

  // Fetch on session change
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([])
      return
    }
    setLoading(true)
    fetchMessages()
  }, [activeSessionId, fetchMessages])

  // Refetch when tab regains focus or visibility (catches messages missed
  // while in background). Throttled to once per 2s per session.
  useEffect(() => {
    if (!activeSessionId) return
    const handler = () => {
      if (document.visibilityState !== 'visible') return
      fetchMessages({ throttle: true })
    }
    const focusHandler = () => fetchMessages({ throttle: true })
    document.addEventListener('visibilitychange', handler)
    window.addEventListener('focus', focusHandler)
    return () => {
      document.removeEventListener('visibilitychange', handler)
      window.removeEventListener('focus', focusHandler)
    }
  }, [activeSessionId, fetchMessages])

  // Refetch on WS reconnect (covers text_delta events missed during the
  // disconnect window). connectionId changes on every reconnect.
  useEffect(() => {
    if (!activeSessionId || connectionId === 0) return
    fetchMessages({ throttle: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId])

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
          // Active session: insert new, OR overwrite existing by id (covers
          // streaming placeholder → final assistant_message overwrite).
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === incomingMessage.id)
            if (idx === -1) return [...prev, incomingMessage]
            const next = prev.slice()
            next[idx] = { ...next[idx], ...incomingMessage }
            return next
          })
        }

        // Track unread for non-active sessions (assistant messages only).
        // Skip 'streaming' placeholders — we'll count when the final 'complete'
        // message arrives to avoid double-incrementing per turn.
        if (
          incomingSessionId !== activeSessionRef.current &&
          incomingMessage.role === 'assistant' &&
          incomingMessage.status !== 'streaming'
        ) {
          setUnreadCounts(prev => {
            const next = { ...prev, [incomingSessionId]: (prev[incomingSessionId] || 0) + 1 }
            saveUnread(next)
            return next
          })
        }
      }

      // Live token streaming: append delta to the corresponding placeholder
      // message so the user sees the response build up in real time. The
      // bubble is already persisted to Postgres so a hub restart preserves
      // whatever was streamed so far.
      if (msg.type === 'text_delta' && msg.message_id) {
        const incomingSessionId = msg.session_id as string
        if (incomingSessionId !== activeSessionRef.current) return
        const messageId = msg.message_id as string
        const delta = msg.content as string
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === messageId)
          if (idx === -1) return prev
          const next = prev.slice()
          next[idx] = { ...next[idx], content: next[idx].content + delta }
          return next
        })
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

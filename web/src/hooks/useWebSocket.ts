import { useState, useEffect, useRef, useCallback } from 'react'
import { getStoredToken } from '../lib/auth.ts'

type WsMessage = {
  type: string
  [key: string]: any
}

type MessageHandler = (msg: WsMessage) => void

const PENDING_STORAGE_KEY = 'remo:ws-pending'
// Only persist user-originated payloads — never auth/heartbeat/control noise
const PERSISTABLE_TYPES = new Set([
  'send_message',
  'permission_response',
  'question_response',
  'cancel',
  'subscribe',
])

function loadPersistedQueue(): object[] {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function savePersistedQueue(queue: object[]) {
  try {
    const persistable = queue.filter((m: any) => m && typeof m.type === 'string' && PERSISTABLE_TYPES.has(m.type))
    if (persistable.length === 0) {
      localStorage.removeItem(PENDING_STORAGE_KEY)
    } else {
      localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(persistable))
    }
  } catch {
    // quota/private mode — best effort
  }
}

function clearPersistedQueue() {
  try { localStorage.removeItem(PENDING_STORAGE_KEY) } catch {}
}

export function useWebSocket(token: string | null) {
  const [connected, setConnected] = useState(false)
  // Increments on each successful auth — consumers use this to re-subscribe after reconnect
  const [connectionId, setConnectionId] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const authedRef = useRef(false)
  const handlersRef = useRef<Set<MessageHandler>>(new Set())
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const backoffRef = useRef(1000)
  // Queue messages sent before WebSocket is authenticated (capped to avoid unbounded growth)
  // Hydrated from localStorage so messages survive a full page reload during the reconnect window
  const pendingRef = useRef<object[]>(loadPersistedQueue())
  const MAX_PENDING = 50

  const connect = useCallback(() => {
    const authToken = token || getStoredToken()
    if (!authToken) return

    authedRef.current = false

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = import.meta.env.VITE_HUB_URL
      ? new URL(import.meta.env.VITE_HUB_URL).host
      : window.location.host
    const wsUrl = `${protocol}//${host}/ws/client`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: authToken }))
    }

    ws.onmessage = (event) => {
      let msg: WsMessage
      try { msg = JSON.parse(event.data) } catch { return }

      if (msg.type === 'auth_ok') {
        authedRef.current = true
        setConnected(true)
        backoffRef.current = 1000
        // Bump connectionId so consumers (useChat) re-subscribe
        setConnectionId(prev => prev + 1)
        // Flush any messages queued before auth completed (in-memory + previously persisted)
        for (const pending of pendingRef.current) {
          ws.send(JSON.stringify(pending))
        }
        pendingRef.current = []
        clearPersistedQueue()
        return
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }

      for (const handler of handlersRef.current) {
        handler(msg)
      }
    }

    ws.onclose = () => {
      authedRef.current = false
      setConnected(false)
      wsRef.current = null
      // Exponential backoff: 1s -> 2s -> 4s -> ... capped at 30s
      const delay = backoffRef.current
      backoffRef.current = Math.min(delay * 2, 30000)
      reconnectRef.current = setTimeout(connect, delay)
    }

    ws.onerror = () => {} // onclose will fire
  }, [token])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectRef.current) clearTimeout(reconnectRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN && authedRef.current) {
      wsRef.current.send(JSON.stringify(msg))
    } else {
      // Queue for when auth completes; drop oldest if cap exceeded
      pendingRef.current.push(msg)
      if (pendingRef.current.length > MAX_PENDING) {
        pendingRef.current.shift()
      }
      // Mirror to localStorage so a full page reload during reconnect doesn't lose user input
      savePersistedQueue(pendingRef.current)
    }
  }, [])

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  return { connected, connectionId, send, subscribe }
}

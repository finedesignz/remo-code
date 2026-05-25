import { useState, useEffect, useRef, useCallback } from 'react'
import { getStoredToken } from '../lib/auth.ts'

type WsMessage = {
  type: string
  [key: string]: any
}

type MessageHandler = (msg: WsMessage) => void

const PENDING_STORAGE_KEY = 'remo:ws-pending'
const INFLIGHT_STORAGE_KEY = 'remo:ws-inflight'
// Only persist user-originated payloads — never auth/heartbeat/control noise.
// `subscribe` is intentionally NOT persisted: useChat re-issues it on every
// reconnect via the connectionId-driven effect, so persisting it would just
// duplicate work and could race against the live re-subscribe.
const PERSISTABLE_TYPES = new Set([
  'send_message',
  'permission_response',
  'question_response',
  'cancel',
])

function loadFromStorage(key: string): any[] {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveQueue(key: string, queue: object[]) {
  try {
    const persistable = queue.filter((m: any) => m && typeof m.type === 'string' && PERSISTABLE_TYPES.has(m.type))
    if (persistable.length === 0) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify(persistable))
    }
  } catch {
    // quota/private mode — best effort
  }
}

function clearStorage(key: string) {
  try { localStorage.removeItem(key) } catch {}
}

export function useWebSocket(token: string | null) {
  const [connected, setConnected] = useState(false)
  // True when WS is closed but a reconnect attempt has been scheduled. Lets the
  // UI distinguish "actively reconnecting" from "first connect in progress".
  const [reconnecting, setReconnecting] = useState(false)
  // Mirrors navigator.onLine. When false, we know the network is gone — the
  // banner can say "Offline" instead of (the misleading) "Reconnecting…".
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  )
  // Increments on each successful auth — consumers use this to re-subscribe after reconnect
  const [connectionId, setConnectionId] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const authedRef = useRef(false)
  const handlersRef = useRef<Set<MessageHandler>>(new Set())
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const backoffRef = useRef(1000)
  // Messages queued before WS is authenticated (capped to avoid unbounded
  // growth). Hydrated from localStorage so messages survive a full page
  // reload during the reconnect window.
  const pendingRef = useRef<any[]>(loadFromStorage(PENDING_STORAGE_KEY))
  // Messages sent to a WS that reported readyState=OPEN but for which we have
  // not yet received a server ACK. On reconnect we replay these — this is
  // what protects against half-open / silently-dead sockets where ws.send()
  // succeeds locally but the bytes never reach the hub.
  const inFlightRef = useRef<Map<string, any>>(
    new Map(
      loadFromStorage(INFLIGHT_STORAGE_KEY)
        .filter((m: any) => m && typeof m.id === 'string')
        .map((m: any) => [m.id as string, m] as [string, any])
    )
  )
  const MAX_PENDING = 50

  const persistInFlight = () => {
    saveQueue(INFLIGHT_STORAGE_KEY, Array.from(inFlightRef.current.values()))
  }

  const connect = useCallback(() => {
    const authToken = token || getStoredToken()
    if (!authToken) return

    authedRef.current = false
    setReconnecting(false)

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
        setReconnecting(false)
        backoffRef.current = 1000

        // 1. Replay in-flight messages first — these are sends that may have
        //    been lost on a half-open socket. We rebroadcast them; the hub
        //    dedupes nothing today, but each carries a stable client `id`
        //    that we use to clear them off in-flight when the ACK arrives.
        //    Order: oldest first.
        for (const inflight of inFlightRef.current.values()) {
          try { ws.send(JSON.stringify(inflight)) } catch {}
        }
        // 2. Then drain the queue (messages enqueued while disconnected).
        for (const pending of pendingRef.current) {
          // Move send_message-shaped entries straight into in-flight so a
          // subsequent disconnect mid-drain doesn't lose them.
          if (pending && typeof pending === 'object' && (pending as any).type === 'send_message' && (pending as any).id) {
            inFlightRef.current.set((pending as any).id, pending)
          }
          try { ws.send(JSON.stringify(pending)) } catch {}
        }
        pendingRef.current = []
        clearStorage(PENDING_STORAGE_KEY)
        persistInFlight()

        // Bump connectionId so consumers (useChat) re-subscribe
        setConnectionId(prev => prev + 1)
        return
      }

      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }))
        return
      }

      if (msg.type === 'send_ack' && typeof msg.client_id === 'string') {
        if (inFlightRef.current.delete(msg.client_id)) {
          persistInFlight()
        }
        return
      }

      for (const handler of handlersRef.current) {
        handler(msg)
      }
    }

    ws.onclose = () => {
      authedRef.current = false
      setConnected(false)
      setReconnecting(true)
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

  // Track navigator online/offline. When offline we don't bother scheduling
  // retries that will fail; when we come back online we kick a reconnect
  // immediately rather than waiting on backoff.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const onOnline = () => {
      setOnline(true)
      if (!wsRef.current && !authedRef.current) {
        if (reconnectRef.current) clearTimeout(reconnectRef.current)
        backoffRef.current = 1000
        reconnectRef.current = setTimeout(connect, 100)
      }
    }
    const onOffline = () => {
      setOnline(false)
      setReconnecting(true)
    }
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [connect])

  const send = useCallback((msg: object) => {
    const m = msg as any
    if (wsRef.current?.readyState === WebSocket.OPEN && authedRef.current) {
      // Track send_message in-flight until ACK so a half-open socket doesn't
      // silently drop the message.
      if (m && m.type === 'send_message' && typeof m.id === 'string') {
        inFlightRef.current.set(m.id, m)
        persistInFlight()
      }
      try {
        wsRef.current.send(JSON.stringify(msg))
      } catch {
        // socket died between readyState check and send — fall through to queue
        pendingRef.current.push(msg)
        if (pendingRef.current.length > MAX_PENDING) pendingRef.current.shift()
        saveQueue(PENDING_STORAGE_KEY, pendingRef.current)
      }
    } else {
      // Queue for when auth completes; drop oldest if cap exceeded
      pendingRef.current.push(msg)
      if (pendingRef.current.length > MAX_PENDING) {
        pendingRef.current.shift()
      }
      // Mirror to localStorage so a full page reload during reconnect doesn't lose user input
      saveQueue(PENDING_STORAGE_KEY, pendingRef.current)
    }
  }, [])

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  return { connected, connectionId, send, subscribe, reconnecting, online }
}

import { useState, useEffect, useRef, useCallback, createContext, useContext, type ReactNode, createElement } from 'react'
import { getStoredToken, hasSessionCookie, clearAuth } from '../lib/auth.ts'
import { readCookie } from '../lib/api'

/** WS messages that mutate server state — must carry csrf_token (cookie echo). */
const CSRF_REQUIRED_TYPES = new Set([
  'send_message',
  'permission_response',
  'question_response',
  'cancel',
])

// Close codes the hub uses to terminate the connection for non-retryable reasons.
// We must NOT auto-reconnect on these — doing so produces a tight loop (e.g. a
// stale JWT in localStorage → 4001 → reconnect → 4001 → ...).
const TERMINAL_CLOSE_CODES = new Set([4000, 4001, 4002, 4003])
const MIN_RECONNECT_DELAY_MS = 1000

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
    // Cookie auth requires no token; legacy bearer auth needs one. If neither
    // signal is present, defer the connect — useAuth will retry once it has
    // either bootstrapped a user via cookie or hydrated from localStorage.
    const cookieAuth = hasSessionCookie()
    const authToken = token || getStoredToken()
    if (!cookieAuth && !authToken) {
      // No cookie session AND no bearer token — don't open the WS at all.
      // Surfaces a clean disconnected state and lets the app shell redirect
      // to login. Prevents the "open → 4001 → reconnect" loop from ever
      // starting on first paint after a token expiry.
      setReconnecting(false)
      setConnected(false)
      return
    }

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
      // Cookie path: empty auth — the hub reads __Host-remo_sid off the
      // upgrade request. Soak path: include bearer token.
      const authMsg: any = { type: 'auth' }
      if (!cookieAuth && authToken) authMsg.token = authToken
      ws.send(JSON.stringify(authMsg))
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

      // The hub refused a send (offline session, quota threshold, etc.).
      // Clear the in-flight entry so we don't replay on reconnect, then fall
      // through to handlers so chat-level UI can surface the reason.
      if (msg.type === 'send_refused' && typeof msg.client_id === 'string') {
        if (inFlightRef.current.delete(msg.client_id)) {
          persistInFlight()
        }
        // fall through — handlers below render the error in the chat surface
      }

      for (const handler of handlersRef.current) {
        handler(msg)
      }
    }

    ws.onclose = (event) => {
      authedRef.current = false
      setConnected(false)
      wsRef.current = null

      // Terminal close codes from the hub (auth timeout / bad JWT / session
      // taken over / replaced). DO NOT reconnect — that's how we end up in a
      // tight reconnect loop with a stale token in localStorage.
      if (TERMINAL_CLOSE_CODES.has(event.code)) {
        setReconnecting(false)
        // 4001 specifically means "your JWT is bad" → nuke it so the app shell
        // can fall through to the login screen instead of replaying the same
        // bad token on the next page load.
        if (event.code === 4001) {
          try { clearAuth() } catch {}
          if (typeof window !== 'undefined') {
            // Hard reload so React state resets and ProtectedRoute kicks the
            // user to /login. Hash-router-safe.
            try { window.location.reload() } catch {}
          }
        }
        return
      }

      setReconnecting(true)
      // Exponential backoff: 1s -> 2s -> 4s -> ... capped at 30s.
      // Floor at MIN_RECONNECT_DELAY_MS so even if backoffRef somehow ends up
      // at 0, we can never spin a tight loop.
      const delay = Math.max(backoffRef.current, MIN_RECONNECT_DELAY_MS)
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
    // Attach csrf_token (double-submit) to mutating WS messages whenever the
    // cookie is present. Soak path with bearer-only: no cookie, no csrf needed.
    if (m && typeof m.type === 'string' && CSRF_REQUIRED_TYPES.has(m.type) && !m.csrf_token) {
      const csrf = readCookie('csrf_token')
      if (csrf) m.csrf_token = csrf
    }
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

// REVIEW BL-01: A single WebSocket connection per browser tab is shared
// across all consumers (NotificationsBridge, HomePage, TasksPage,
// SettingsPage, ChatLayout, GridPage) via React context. Each useWebSocket()
// call opens its OWN socket (no internal singleton), so without this
// provider three concurrent /ws/client connections were opened on every
// Home render — risking the hub's per-IP 20-connection cap and wasting
// auth/license-fetch cycles.
type WsContextValue = ReturnType<typeof useWebSocket>

const WebSocketContext = createContext<WsContextValue | null>(null)

export function WebSocketProvider({ token, children }: { token: string | null; children: ReactNode }) {
  const value = useWebSocket(token)
  return createElement(WebSocketContext.Provider, { value }, children)
}

export function useWebSocketContext(): WsContextValue {
  const ctx = useContext(WebSocketContext)
  if (!ctx) {
    // Fallback: legacy callers without a provider get a no-op shape.
    // Prefer wrapping the tree in <WebSocketProvider> instead.
    throw new Error('useWebSocketContext must be used within <WebSocketProvider>')
  }
  return ctx
}

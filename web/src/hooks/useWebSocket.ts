import { useState, useEffect, useRef, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'

type WsMessage = {
  type: string
  [key: string]: any
}

type MessageHandler = (msg: WsMessage) => void

export function useWebSocket(session: Session | null) {
  const [connected, setConnected] = useState(false)
  // Increments on each successful auth — consumers use this to re-subscribe after reconnect
  const [connectionId, setConnectionId] = useState(0)
  const wsRef = useRef<WebSocket | null>(null)
  const authedRef = useRef(false)
  const handlersRef = useRef<Set<MessageHandler>>(new Set())
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Queue messages sent before WebSocket is authenticated
  const pendingRef = useRef<object[]>([])

  const connect = useCallback(() => {
    if (!session?.access_token) return

    authedRef.current = false

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = import.meta.env.VITE_HUB_URL
      ? new URL(import.meta.env.VITE_HUB_URL).host
      : window.location.host
    const wsUrl = `${protocol}//${host}/ws/client`

    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token: session.access_token }))
    }

    ws.onmessage = (event) => {
      let msg: WsMessage
      try { msg = JSON.parse(event.data) } catch { return }

      if (msg.type === 'auth_ok') {
        authedRef.current = true
        setConnected(true)
        // Bump connectionId so consumers (useChat) re-subscribe
        setConnectionId(prev => prev + 1)
        // Flush any messages queued before auth completed
        for (const pending of pendingRef.current) {
          ws.send(JSON.stringify(pending))
        }
        pendingRef.current = []
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
      reconnectRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => {} // onclose will fire
  }, [session?.access_token])

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
      // Queue for when auth completes
      pendingRef.current.push(msg)
    }
  }, [])

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  return { connected, connectionId, send, subscribe }
}

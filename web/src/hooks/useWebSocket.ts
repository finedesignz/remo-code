import { useState, useEffect, useRef, useCallback } from 'react'
import type { Session } from '@supabase/supabase-js'

type WsMessage = {
  type: string
  [key: string]: any
}

type MessageHandler = (msg: WsMessage) => void

export function useWebSocket(session: Session | null) {
  const [connected, setConnected] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const handlersRef = useRef<Set<MessageHandler>>(new Set())
  const reconnectRef = useRef<ReturnType<typeof setTimeout>>()

  const connect = useCallback(() => {
    if (!session?.access_token) return

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
        setConnected(true)
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
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const subscribe = useCallback((handler: MessageHandler) => {
    handlersRef.current.add(handler)
    return () => { handlersRef.current.delete(handler) }
  }, [])

  return { connected, send, subscribe }
}

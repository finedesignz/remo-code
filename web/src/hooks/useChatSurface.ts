import { useEffect, useRef, useState, useCallback } from 'react'
import type { ChatMessage } from './useChat'
import type { ActivityState } from './useActivity'
import { createRafBatcher } from '../lib/raf-batch'
import { recordUserMessage } from '../lib/lastUserMsg'

/**
 * useChatSurface — owns ONE session's data lifecycle for a <ChatSurface>.
 *
 * Used by `density="cell"` and `density="mobile-expanded"` instances that
 * each manage their own subscription. The single-chat `density="full"`
 * path keeps using the global `useChat` + `useActivity` pair via Layout,
 * which is wire-compatible (this hook returns the same shapes).
 *
 * History fetch: limited to 30 messages on first mount (per Phase 03
 * locked decision — cells must NOT pull the full history of every cell
 * on every tab activation).
 *
 * text_delta coalescing: deltas accumulate in a ref and flush once per
 * animation frame. Hub-side throttling is forbidden (would break the
 * scheduled-tasks event-ordering contract — see docs/scheduled-tasks.md).
 */

export interface UseChatSurfaceArgs {
  sessionId: string | null
  token: string
  subscribe: (handler: (msg: any) => void) => () => void
  send: (msg: object) => void
  connectionId: number
  /** Pre-fetched messages (e.g. provided by GridPage one-shot bulk fetch). */
  seedMessages?: ChatMessage[]
  /** Initial history cap when seedMessages is absent. Default 30. */
  historyLimit?: number
}

const INITIAL_ACTIVITY: ActivityState = {
  status: 'idle',
  thinkingText: '',
  streamingText: '',
  toolCalls: [],
  pendingPermission: null,
  pendingQuestion: null,
  agentLogs: [],
}

export function useChatSurface({
  sessionId,
  token,
  subscribe,
  send,
  connectionId,
  seedMessages,
  historyLimit = 30,
}: UseChatSurfaceArgs) {
  const [messages, setMessages] = useState<ChatMessage[]>(seedMessages ?? [])
  const [loading, setLoading] = useState(!seedMessages)
  const [activity, setActivity] = useState<ActivityState>(INITIAL_ACTIVITY)
  const activityRef = useRef<ActivityState>(INITIAL_ACTIVITY)
  const sessionIdRef = useRef(sessionId)

  useEffect(() => { sessionIdRef.current = sessionId }, [sessionId])

  // Fetch initial history (skipped when seedMessages is provided)
  useEffect(() => {
    if (!sessionId) {
      setMessages([])
      setLoading(false)
      return
    }
    if (seedMessages) {
      setMessages(seedMessages)
      setLoading(false)
      return
    }
    setLoading(true)
    const hubUrl = import.meta.env.VITE_HUB_URL || ''
    fetch(`${hubUrl}/api/messages/${sessionId}?limit=${historyLimit}`, {
      headers: { Authorization: `Bearer ${token}` },
      credentials: 'include',
    })
      .then(r => r.ok ? r.json() : [])
      .then((data: ChatMessage[]) => {
        // Guard against late response for a stale sessionId
        if (sessionIdRef.current !== sessionId) return
        setMessages(data)
        setLoading(false)
      })
      .catch(() => setLoading(false))
    // seedMessages is intentionally omitted — we honor it only at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, token, historyLimit])

  // Subscribe to live events for this session + RAF-coalesce text_delta
  useEffect(() => {
    if (!sessionId) return

    send({ type: 'subscribe', session_ids: [sessionId] })

    // RAF batcher for text_delta — one setMessages per frame, not per delta.
    // Batch shape: { messageId, delta }
    const batcher = createRafBatcher<{ messageId: string; delta: string }>((batch) => {
      if (batch.length === 0) return
      setMessages(prev => {
        // Group deltas by message_id, then apply in order
        const acc = new Map<string, string>()
        for (const { messageId, delta } of batch) {
          acc.set(messageId, (acc.get(messageId) ?? '') + delta)
        }
        let changed = false
        const next = prev.map(m => {
          const add = acc.get(m.id)
          if (add === undefined) return m
          changed = true
          return { ...m, content: m.content + add }
        })
        return changed ? next : prev
      })
    })

    const unsub = subscribe((msg: any) => {
      const sid = msg.session_id as string | undefined
      if (sid !== undefined && sid !== sessionIdRef.current) return

      if (msg.type === 'message') {
        const incoming = msg.message as ChatMessage
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === incoming.id)
          if (idx === -1) return [...prev, incoming]
          const next = prev.slice()
          next[idx] = { ...next[idx], ...incoming }
          return next
        })
        return
      }

      if (msg.type === 'text_delta' && msg.message_id) {
        batcher.push({ messageId: msg.message_id as string, delta: msg.content as string })
        return
      }

      // Hub refused this send — surface as a transient assistant bubble so
      // the cell visibly reflects WHY the runner never replied.
      if (msg.type === 'send_refused') {
        const reason = (msg.reason as string) || (msg.error as string) || 'Send refused.'
        const synthetic: ChatMessage = {
          id: `refused-${msg.client_id || Date.now()}`,
          session_id: sessionIdRef.current!,
          role: 'assistant',
          content: `⚠ ${reason}`,
          status: 'interrupted',
          created_at: new Date().toISOString(),
        }
        setMessages(prev => {
          if (prev.some(m => m.id === synthetic.id)) return prev
          return [...prev, synthetic]
        })
        return
      }

      // Activity events — minimal reducer mirroring useActivity
      if (msg.type === 'status') {
        const state = msg.state as ActivityState['status']
        if (state === 'idle') {
          activityRef.current = {
            ...INITIAL_ACTIVITY,
            pendingPermission: activityRef.current.pendingPermission,
            pendingQuestion: activityRef.current.pendingQuestion,
            agentLogs: activityRef.current.agentLogs,
          }
        } else {
          activityRef.current = { ...activityRef.current, status: state }
        }
        setActivity({ ...activityRef.current })
        return
      }

      if (msg.type === 'thinking') {
        activityRef.current = {
          ...activityRef.current,
          thinkingText: activityRef.current.thinkingText + msg.content,
        }
        setActivity({ ...activityRef.current })
        return
      }

      if (msg.type === 'tool_use') {
        const call = { tool: msg.tool, tool_id: msg.tool_id, input: msg.input, done: false }
        activityRef.current = {
          ...activityRef.current,
          toolCalls: [...activityRef.current.toolCalls, call],
        }
        setActivity({ ...activityRef.current })
        return
      }

      if (msg.type === 'tool_result') {
        const calls = activityRef.current.toolCalls.map(tc =>
          tc.tool_id === msg.tool_id
            ? { ...tc, result: msg.content, is_error: msg.is_error, done: true }
            : tc
        )
        activityRef.current = { ...activityRef.current, toolCalls: calls }
        setActivity({ ...activityRef.current })
        return
      }

      if (msg.type === 'permission_request') {
        activityRef.current = {
          ...activityRef.current,
          pendingPermission: {
            request_id: msg.request_id,
            tool_name: msg.tool_name,
            tool_input: msg.tool_input,
          },
        }
        setActivity({ ...activityRef.current })
        return
      }

      if (msg.type === 'user_question') {
        activityRef.current = {
          ...activityRef.current,
          pendingQuestion: {
            request_id: msg.request_id,
            question: msg.question,
            options: msg.options,
            is_multi_select: msg.is_multi_select,
          },
        }
        setActivity({ ...activityRef.current })
        return
      }

      if (msg.type === 'agent_log') {
        activityRef.current = {
          ...activityRef.current,
          agentLogs: [...activityRef.current.agentLogs, msg.message],
        }
        setActivity({ ...activityRef.current })
        return
      }
    })

    return () => {
      batcher.cancel()
      unsub()
    }
  }, [sessionId, subscribe, send, connectionId])

  // Reset activity when sessionId changes
  useEffect(() => {
    activityRef.current = INITIAL_ACTIVITY
    setActivity(INITIAL_ACTIVITY)
  }, [sessionId])

  const sendMessage = useCallback((content: string, images?: Array<{ media_type: string; data: string }>) => {
    if (!sessionId) return
    const id = crypto.randomUUID()
    const msg: any = { type: 'send_message', session_id: sessionId, content, id }
    if (images?.length) msg.images = images
    send(msg)
    recordUserMessage(sessionId, content)
  }, [sessionId, send])

  const respondPermission = useCallback((requestId: string, approved: boolean) => {
    if (!sessionId) return
    send({ type: 'permission_response', session_id: sessionId, request_id: requestId, approved })
  }, [sessionId, send])

  const respondQuestion = useCallback((requestId: string, answer: string) => {
    if (!sessionId) return
    send({ type: 'question_response', session_id: sessionId, request_id: requestId, answer })
  }, [sessionId, send])

  return {
    messages,
    loading,
    activity,
    sendMessage,
    respondPermission,
    respondQuestion,
  }
}

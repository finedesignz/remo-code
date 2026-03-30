import { useState, useEffect, useRef } from 'react'

export interface ThinkingEvent { type: 'thinking'; content: string }
export interface TextDeltaEvent { type: 'text_delta'; content: string }
export interface ToolUseEvent { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
export interface ToolResultEvent { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
export interface StatusEvent { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
export interface PermissionRequestEvent { type: 'permission_request'; request_id: string; tool_name: string; tool_input: unknown }

export type ActivityEvent = ThinkingEvent | TextDeltaEvent | ToolUseEvent | ToolResultEvent | StatusEvent | PermissionRequestEvent

export interface PermissionRequest {
  request_id: string
  tool_name: string
  tool_input: unknown
}

export interface ActivityState {
  status: 'idle' | 'thinking' | 'tool_calling' | 'writing'
  thinkingText: string
  streamingText: string
  toolCalls: Array<{
    tool: string
    tool_id: string
    input: unknown
    result?: string
    is_error?: boolean
    done: boolean
  }>
  pendingPermission: PermissionRequest | null
}

const INITIAL_STATE: ActivityState = {
  status: 'idle',
  thinkingText: '',
  streamingText: '',
  toolCalls: [],
  pendingPermission: null,
}

export function useActivity(
  activeSessionId: string | null,
  subscribe: (handler: (msg: any) => void) => () => void,
) {
  const [activity, setActivity] = useState<ActivityState>(INITIAL_STATE)
  const stateRef = useRef(INITIAL_STATE)

  useEffect(() => {
    if (!activeSessionId) return

    const unsub = subscribe((msg: any) => {
      if (msg.session_id !== activeSessionId) return

      if (msg.type === 'status') {
        const state = msg.state as ActivityState['status']
        if (state === 'idle') {
          // Reset on idle
          stateRef.current = INITIAL_STATE
          setActivity(INITIAL_STATE)
        } else {
          stateRef.current = { ...stateRef.current, status: state }
          setActivity({ ...stateRef.current })
        }
      }

      if (msg.type === 'thinking') {
        stateRef.current = { ...stateRef.current, thinkingText: stateRef.current.thinkingText + msg.content }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'text_delta') {
        stateRef.current = { ...stateRef.current, streamingText: stateRef.current.streamingText + msg.content }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'tool_use') {
        // Clear any pending permission once a tool starts executing
        const call = { tool: msg.tool, tool_id: msg.tool_id, input: msg.input, done: false }
        stateRef.current = { ...stateRef.current, toolCalls: [...stateRef.current.toolCalls, call], pendingPermission: null }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'tool_result') {
        const calls = stateRef.current.toolCalls.map(tc =>
          tc.tool_id === msg.tool_id
            ? { ...tc, result: msg.content, is_error: msg.is_error, done: true }
            : tc
        )
        stateRef.current = { ...stateRef.current, toolCalls: calls }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'permission_request') {
        stateRef.current = {
          ...stateRef.current,
          pendingPermission: {
            request_id: msg.request_id,
            tool_name: msg.tool_name,
            tool_input: msg.tool_input,
          },
        }
        setActivity({ ...stateRef.current })
      }
    })

    return unsub
  }, [activeSessionId, subscribe])

  // Reset when switching sessions
  useEffect(() => {
    stateRef.current = INITIAL_STATE
    setActivity(INITIAL_STATE)
  }, [activeSessionId])

  return activity
}

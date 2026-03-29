import { useState, useEffect, useRef } from 'react'

export interface ThinkingEvent { type: 'thinking'; content: string }
export interface TextDeltaEvent { type: 'text_delta'; content: string }
export interface ToolUseEvent { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
export interface ToolResultEvent { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
export interface StatusEvent { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }

export type ActivityEvent = ThinkingEvent | TextDeltaEvent | ToolUseEvent | ToolResultEvent | StatusEvent

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
}

const INITIAL_STATE: ActivityState = {
  status: 'idle',
  thinkingText: '',
  streamingText: '',
  toolCalls: [],
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
        const call = { tool: msg.tool, tool_id: msg.tool_id, input: msg.input, done: false }
        stateRef.current = { ...stateRef.current, toolCalls: [...stateRef.current.toolCalls, call] }
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

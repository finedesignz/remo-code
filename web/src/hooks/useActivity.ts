import { useState, useEffect, useRef } from 'react'

export interface ThinkingEvent { type: 'thinking'; content: string }
export interface TextDeltaEvent { type: 'text_delta'; content: string }
export interface ToolUseEvent { type: 'tool_use'; tool: string; tool_id: string; input: unknown }
export interface ToolResultEvent { type: 'tool_result'; tool_id: string; content: string; is_error?: boolean }
export interface StatusEvent { type: 'status'; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
export interface PermissionRequestEvent { type: 'permission_request'; request_id: string; tool_name: string; tool_input: unknown }
export interface UserQuestionEvent { type: 'user_question'; request_id: string; question: string;
  options?: Array<{ label: string; description?: string }>; is_multi_select?: boolean }

export type ActivityEvent = ThinkingEvent | TextDeltaEvent | ToolUseEvent | ToolResultEvent | StatusEvent | PermissionRequestEvent | UserQuestionEvent

export interface PermissionRequest {
  request_id: string
  tool_name: string
  tool_input: unknown
}

export interface PendingQuestion {
  request_id: string
  question: string
  options?: Array<{ label: string; description?: string }>
  is_multi_select?: boolean
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
  pendingQuestion: PendingQuestion | null
  agentLogs: string[]
}

const INITIAL_STATE: ActivityState = {
  status: 'idle',
  thinkingText: '',
  streamingText: '',
  toolCalls: [],
  pendingPermission: null,
  pendingQuestion: null,
  agentLogs: [],
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
          // Reset on idle but preserve permission/question if user hasn't responded, and preserve logs
          stateRef.current = {
            ...INITIAL_STATE,
            pendingPermission: stateRef.current.pendingPermission,
            pendingQuestion: stateRef.current.pendingQuestion,
            agentLogs: stateRef.current.agentLogs,
          }
          setActivity(stateRef.current)
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

      if (msg.type === 'user_question') {
        stateRef.current = {
          ...stateRef.current,
          pendingQuestion: {
            request_id: msg.request_id,
            question: msg.question,
            options: msg.options,
            is_multi_select: msg.is_multi_select,
          },
        }
        setActivity({ ...stateRef.current })
      }

      if (msg.type === 'agent_log') {
        stateRef.current = {
          ...stateRef.current,
          agentLogs: [...stateRef.current.agentLogs, msg.message],
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

// Events the agent sends TO the hub (parsed from Claude CLI stream-json)
export type AgentToHub =
  | { type: 'auth'; api_key: string; project_dir: string; hostname: string }
  | { type: 'thinking'; session_id: string; content: string }
  | { type: 'text_delta'; session_id: string; content: string }
  | { type: 'tool_use'; session_id: string; tool: string; tool_id: string; input: unknown }
  | { type: 'tool_result'; session_id: string; tool_id: string; content: string; is_error?: boolean }
  | { type: 'status'; session_id: string; state: 'idle' | 'thinking' | 'tool_calling' | 'writing' }
  | { type: 'assistant_message'; session_id: string; content: string }
  | { type: 'permission_request'; session_id: string; request_id: string; tool_name: string; tool_input: unknown }
  | { type: 'pong' }

// Events the hub sends TO the agent
export type HubToAgent =
  | { type: 'auth_ok'; session_id: string }
  | { type: 'auth_error'; error: string }
  | { type: 'user_message'; session_id: string; id: string; content: string;
      images?: Array<{ media_type: string; data: string }>;
      attachments?: Array<{ filename: string; content: string }> }
  | { type: 'permission_response'; session_id: string; request_id: string; approved: boolean }
  | { type: 'cancel'; session_id: string }
  | { type: 'ping' }

// Claude CLI stream-json event shapes (subset we care about)
export interface CliInitEvent {
  type: 'system'
  subtype: 'init'
  session_id: string
  cwd: string
  tools: string[]
}

export interface CliAssistantEvent {
  type: 'assistant'
  message: {
    content: Array<
      | { type: 'text'; text: string }
      | { type: 'thinking'; thinking: string }
      | { type: 'tool_use'; id: string; name: string; input: unknown }
    >
  }
  session_id: string
}

export interface CliToolResultEvent {
  type: 'tool_result'
  tool_use_id: string
  content: string
  is_error?: boolean
  session_id: string
}

export interface CliResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  result: string
  duration_ms: number
  total_cost_usd: number
  session_id: string
}

export interface CliControlRequestEvent {
  type: 'control_request'
  request_id: string
  subtype: 'can_use_tool'
  tool_name: string
  tool_input: unknown
  session_id: string
}

export type CliEvent = CliInitEvent | CliAssistantEvent | CliToolResultEvent | CliResultEvent | CliControlRequestEvent | { type: string; [key: string]: unknown }

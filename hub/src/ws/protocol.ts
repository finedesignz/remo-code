import { z } from 'zod'

// -- Channel <-> Hub --

export const ChannelAuth = z.object({
  type: z.literal('auth'),
  session_id: z.string().min(1).max(256),
  token: z.string().regex(/^remo_[A-Za-z0-9_\-]{43}$/),
})

export const AssistantMessage = z.object({
  type: z.literal('assistant_message'),
  id: z.string().min(1),
  content: z.string().min(1).max(65536),
  ts: z.string(),
})

export const ChannelStatus = z.object({
  type: z.literal('status'),
  status: z.enum(['thinking', 'idle']),
})

export const ChannelInbound = z.discriminatedUnion('type', [
  ChannelAuth,
  AssistantMessage,
  ChannelStatus,
  z.object({ type: z.literal('pong') }),
])

// -- Client <-> Hub --

export const ClientAuth = z.object({
  type: z.literal('auth'),
  token: z.string().min(1),
})

export const ClientSendMessage = z.object({
  type: z.literal('send_message'),
  session_id: z.string().min(1).max(256),
  content: z.string().min(1).max(1_000_000),
  id: z.string().uuid(),
  images: z.array(z.object({
    media_type: z.string(),
    data: z.string().max(10_000_000), // base64 image data up to ~7.5MB raw
  })).max(5).optional(),
  attachments: z.array(z.object({
    filename: z.string(),
    content: z.string(),
  })).optional(),
})

export const ClientSubscribe = z.object({
  type: z.literal('subscribe'),
  session_ids: z.array(z.string().min(1)).max(100),
})

export const ClientPermissionResponse = z.object({
  type: z.literal('permission_response'),
  session_id: z.string().min(1),
  request_id: z.string().min(1),
  approved: z.boolean(),
})

export const ClientQuestionResponse = z.object({
  type: z.literal('question_response'),
  session_id: z.string().min(1),
  request_id: z.string().min(1),
  answer: z.string().min(1),
})

export const ClientInbound = z.discriminatedUnion('type', [
  ClientAuth,
  ClientSendMessage,
  ClientSubscribe,
  ClientPermissionResponse,
  ClientQuestionResponse,
  z.object({ type: z.literal('pong') }),
])

// -- Hub outbound types (not validated, we construct them) --

export type HubToChannel =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; error: string }
  | { type: 'user_message'; id: string; content: string; ts: string;
      images?: Array<{ media_type: string; data: string }>;
      attachments?: Array<{ filename: string; content: string }> }
  | { type: 'ping' }

export type HubToAgent =
  | { type: 'auth_ok'; session_id: string }
  | { type: 'auth_error'; error: string }
  | { type: 'user_message'; session_id: string; id: string; content: string;
      images?: Array<{ media_type: string; data: string }>;
      attachments?: Array<{ filename: string; content: string }> }
  | { type: 'permission_response'; session_id: string; request_id: string; approved: boolean }
  | { type: 'question_response'; session_id: string; request_id: string; answer: string }
  | { type: 'cancel'; session_id: string }
  | { type: 'ping' }

export type HubToClient =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; error: string }
  | { type: 'message'; session_id: string; message: { id: string; role: string; content: string; created_at: string } }
  | { type: 'session_status'; session_id: string; status: string }
  | { type: 'session_list'; sessions: Array<{ id: string; name: string; project_dir: string | null; status: string; last_activity: string | null; created_at: string }> }
  | { type: 'permission_request'; session_id: string; request_id: string; tool_name: string; tool_input: unknown }
  | { type: 'user_question'; session_id: string; request_id: string; question: string;
      options?: Array<{ label: string; description?: string }>; is_multi_select?: boolean }
  | { type: 'agent_log'; session_id: string; message: string }
  | { type: 'ping' }

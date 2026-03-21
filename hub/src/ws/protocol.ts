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
  content: z.string().min(1).max(65536),
  id: z.string().uuid(),
})

export const ClientSubscribe = z.object({
  type: z.literal('subscribe'),
  session_ids: z.array(z.string().min(1)).max(100),
})

export const ClientInbound = z.discriminatedUnion('type', [
  ClientAuth,
  ClientSendMessage,
  ClientSubscribe,
  z.object({ type: z.literal('pong') }),
])

// -- Hub outbound types (not validated, we construct them) --

export type HubToChannel =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; error: string }
  | { type: 'user_message'; id: string; content: string; ts: string }
  | { type: 'ping' }

export type HubToClient =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; error: string }
  | { type: 'message'; session_id: string; message: { id: string; role: string; content: string; created_at: string } }
  | { type: 'session_status'; session_id: string; status: string }
  | { type: 'session_list'; sessions: Array<{ id: string; name: string; project_dir: string | null; status: string; last_activity: string | null; created_at: string }> }
  | { type: 'ping' }

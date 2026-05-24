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

// -- Scheduled-run outbound events (W3/T15) --
// Schemas mirror what the dispatcher emits via broadcastToUser. They exist
// so `broadcastScheduledRun` can validate before sending and so the web
// client can share the type via a generated d.ts in the future.

export const ScheduledRunStarted = z.object({
  type: z.literal('scheduled_run_started'),
  run_id: z.string().min(1),
  task_id: z.string().min(1),
  scheduled_for: z.string().optional(),
  target_kind: z.enum(['session', 'supervisor', 'all_agents', 'all_supervisors']).optional(),
  target_id: z.string().nullable().optional(),
})

export const ScheduledRunProgress = z.object({
  type: z.literal('scheduled_run_progress'),
  run_id: z.string().min(1),
  task_id: z.string().min(1).optional(),
  snippet: z.string().optional(),
})

export const ScheduledRunFinished = z.object({
  type: z.literal('scheduled_run_finished'),
  run_id: z.string().min(1),
  task_id: z.string().min(1).nullable().optional(),
  status: z.enum(['pending', 'in_flight', 'running', 'success', 'failed', 'skipped', 'cancelled']),
  cost_usd: z.number().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  output_snippet: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
})

export const NotificationEvent = z.object({
  type: z.literal('notification'),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  severity: z.enum(['info', 'success', 'warning', 'error']).optional(),
  url: z.string().url().optional(),
  run_id: z.string().optional(),
  task_id: z.string().optional(),
})

export const ScheduledRunEvent = z.discriminatedUnion('type', [
  ScheduledRunStarted,
  ScheduledRunProgress,
  ScheduledRunFinished,
  NotificationEvent,
])
export type ScheduledRunEvent = z.infer<typeof ScheduledRunEvent>

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
  | { type: 'message'; session_id: string; message: { id: string; role: string; content: string; status?: string; created_at: string } }
  | { type: 'text_delta'; session_id: string; content: string; message_id?: string; run_id?: string }
  | { type: 'tool_use'; session_id: string; tool_name: string; tool_input?: unknown; message_id?: string; run_id?: string }
  | { type: 'tool_result'; session_id: string; tool_use_id?: string; content?: unknown; run_id?: string }
  | { type: 'session_status'; session_id: string; status: string }
  | { type: 'session_list'; sessions: Array<{ id: string; name: string; project_dir: string | null; status: string; last_activity: string | null; created_at: string; agent_info?: unknown }> }
  | { type: 'permission_request'; session_id: string; request_id: string; tool_name: string; tool_input: unknown }
  | { type: 'user_question'; session_id: string; request_id: string; question: string;
      options?: Array<{ label: string; description?: string }>; is_multi_select?: boolean }
  | { type: 'agent_log'; session_id: string; message: string }
  | { type: 'scheduled_run_started'; run_id: string; task_id: string;
      scheduled_for?: string; target_kind?: string; target_id?: string | null }
  | { type: 'scheduled_run_progress'; run_id: string; task_id?: string; snippet?: string }
  | { type: 'scheduled_run_finished'; run_id: string; task_id?: string | null;
      status: string; cost_usd?: number | null; duration_ms?: number | null;
      output_snippet?: string | null; error?: string | null }
  | { type: 'notification'; title: string; body: string;
      severity?: 'info' | 'success' | 'warning' | 'error'; url?: string;
      run_id?: string; task_id?: string }
  | { type: 'ping' }

import { z } from 'zod'

// -- Client <-> Hub --

// Phase 07-C: token is now OPTIONAL. When the upgrade carried a valid
// `__Host-remo_sid` cookie, the client sends `{ type: 'auth' }` (empty) and
// the server resolves identity from the cookie. Legacy bearer remains supported
// (gated by ALLOW_LEGACY_LOGIN) for the dual-auth soak window.
export const ClientAuth = z.object({
  type: z.literal('auth'),
  token: z.string().min(1).optional(),
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
  // Phase 07-C: required when authed via cookie. Legacy bearer connections
  // (during soak) are exempt — they never received a csrf cookie.
  csrf_token: z.string().min(1).optional(),
})

// Multichat overload: accepts BOTH `session_id` (legacy single) AND
// `session_ids` (multi, cap 12). Exactly one must be present. The handler
// normalizes to a single id list. Do NOT add a `subscribe_many` op.
export const SUBSCRIBE_MAX = 12

export const ClientSubscribe = z.object({
  type: z.literal('subscribe'),
  session_id: z.string().min(1).max(256).optional(),
  session_ids: z.array(z.string().min(1)).max(SUBSCRIBE_MAX).optional(),
}).refine(
  (d) => !!d.session_id || (Array.isArray(d.session_ids) && d.session_ids.length >= 0),
  { message: 'subscribe requires session_id or session_ids' },
)

export const ClientPermissionResponse = z.object({
  type: z.literal('permission_response'),
  session_id: z.string().min(1),
  request_id: z.string().min(1),
  approved: z.boolean(),
  csrf_token: z.string().min(1).optional(),
})

export const ClientQuestionResponse = z.object({
  type: z.literal('question_response'),
  session_id: z.string().min(1),
  request_id: z.string().min(1),
  answer: z.string().min(1),
  csrf_token: z.string().min(1).optional(),
})

// NOTE: `z.union` (not `discriminatedUnion`) because `ClientSubscribe` is a
// `ZodEffects` (wrapped by `.refine`) and discriminatedUnion only accepts
// raw ZodObject members with a literal discriminator. Behavior is equivalent
// for our purposes; the handler still dispatches on `type`.
export const ClientInbound = z.union([
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

// -- Error-capture outbound events (W3/T5) --
// Lifecycle: error_received → (error_dispatched | error_skipped) → error_run_finished.

export const ErrorReceived = z.object({
  type: z.literal('error_received'),
  error_id: z.string().min(1),
  project_id: z.string().min(1),
  fingerprint: z.string().min(1),
  received_at: z.string(),
})

export const ErrorDispatched = z.object({
  type: z.literal('error_dispatched'),
  error_id: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  dispatched_at: z.string(),
})

export const ErrorRunFinished = z.object({
  type: z.literal('error_run_finished'),
  error_id: z.string().min(1),
  project_id: z.string().min(1),
  run_id: z.string().min(1),
  status: z.enum(['success', 'failed', 'skipped', 'cancelled']),
  output_snippet: z.string().nullable().optional(),
  cost_usd: z.number().nullable().optional(),
  duration_ms: z.number().nullable().optional(),
  error: z.string().nullable().optional(),
  finished_at: z.string(),
})

export const ErrorSkipped = z.object({
  type: z.literal('error_skipped'),
  error_id: z.string().min(1),
  project_id: z.string().min(1),
  dispatch_status: z.enum(['skipped', 'failed', 'deduped', 'rate_limited', 'cap_exceeded']),
  skip_reason: z.string().min(1),
})

export const ErrorCaptureEvent = z.discriminatedUnion('type', [
  ErrorReceived,
  ErrorDispatched,
  ErrorRunFinished,
  ErrorSkipped,
])
export type ErrorCaptureEvent = z.infer<typeof ErrorCaptureEvent>

// -- Revanote outbound events (Phase 08) --
// Lifecycle: revanote_received → (revanote_dispatched | revanote_skipped) →
// revanote_resolved → revanote_callback_sent.

export const RevanoteReceived = z.object({
  type: z.literal('revanote_received'),
  annotation_id: z.string().min(1),
  annotation_id_external: z.string().min(1),
  page_url: z.string().min(1),
  comment_preview: z.string(),
  received_at: z.string(),
})

export const RevanoteDispatched = z.object({
  type: z.literal('revanote_dispatched'),
  annotation_id: z.string().min(1),
  run_id: z.string().min(1),
  session_id: z.string().min(1),
  dispatched_at: z.string(),
})

export const RevanoteSkipped = z.object({
  type: z.literal('revanote_skipped'),
  annotation_id: z.string().min(1),
  skip_reason: z.string().min(1),
})

export const RevanoteResolved = z.object({
  type: z.literal('revanote_resolved'),
  annotation_id: z.string().min(1),
  run_id: z.string().min(1),
  resolved: z.boolean(),
  action_taken: z.string().nullable().optional(),
  files_changed: z.array(z.string()).optional(),
  deployed: z.boolean().optional(),
  finished_at: z.string(),
})

export const RevanoteCallbackSent = z.object({
  type: z.literal('revanote_callback_sent'),
  annotation_id: z.string().min(1),
  attempt_no: z.number().int().min(0),
  http_status: z.number().int().nullable().optional(),
  delivered: z.boolean(),
  dead: z.boolean().optional(),
  next_retry_at: z.string().nullable().optional(),
})

export const RevanoteEvent = z.discriminatedUnion('type', [
  RevanoteReceived,
  RevanoteDispatched,
  RevanoteSkipped,
  RevanoteResolved,
  RevanoteCallbackSent,
])
export type RevanoteEvent = z.infer<typeof RevanoteEvent>

// -- Hub outbound types (not validated, we construct them) --

export type HubToChannel =
  | { type: 'auth_ok' }
  | { type: 'auth_error'; error: string }
  | { type: 'user_message'; id: string; content: string; ts: string;
      images?: Array<{ media_type: string; data: string }>;
      attachments?: Array<{ filename: string; content: string }> }
  | { type: 'ping' }

export type HubToAgent =
  // Plan 05-002: auth_ok now carries cli_kind (so agent knows which CLI to
  // spawn) and rootless_session_ids (ambient session ids per CLI, when the
  // agent advertised rootless_sessions). system_prompt and seed_files are
  // hoisted from the inline ad-hoc shape used by the agent (system_prompt was
  // already being read at agent/src/index.ts; seed_files is a Plan 05 reserve).
  | { type: 'auth_ok'; session_id: string;
      cli_kind: 'claude' | 'codex';
      system_prompt?: string;
      seed_files?: unknown[];
      rootless_session_ids?: { claude?: string; codex?: string } }
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
  | { type: 'subscribe_error'; error: 'too_many_sessions' | 'invalid_subscribe'; max?: number }
  | { type: 'message'; session_id: string; message: { id: string; role: string; content: string; status?: string; created_at: string } }
  | { type: 'text_delta'; session_id: string; content: string; message_id?: string; run_id?: string }
  | { type: 'tool_use'; session_id: string; tool_name: string; tool_input?: unknown; message_id?: string; run_id?: string }
  | { type: 'tool_result'; session_id: string; tool_use_id?: string; content?: unknown; run_id?: string }
  | { type: 'session_status'; session_id: string; status: string }
  | { type: 'session_list'; sessions: Array<{ id: string; name: string; project_dir: string | null; status: string; last_activity: string | null; created_at: string; agent_info?: unknown;
      // Plan 05-002: surface CLI + rootless attribution so the sidebar can
      // render the right badge and group ambient sessions under their host.
      cli_kind: 'claude' | 'codex'; is_rootless: boolean; hostname: string | null }> }
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
  // Phase 04 plan 002: supervisor reported a fresh host_resources snapshot.
  // Web UI re-renders the budget chip without polling.
  | { type: 'supervisor_resources_updated'; supervisor_id: string;
      cpu_cores: number; total_mem_mb: number; free_mem_mb: number;
      concurrency_budget: number; concurrency_override: number | null;
      budget_source: 'cgroup_v2' | 'cgroup_v1' | 'host_fallback';
      budget_updated_at: string }
  // Phase 04 plan 003: hub-authoritative concurrency gate broadcasts the
  // current running/cap pair on every reserve and release so the UI re-renders
  // its capacity chip without polling.
  | { type: 'supervisor_capacity_changed'; supervisor_id: string;
      running: number; cap: number }
  | { type: 'error_received'; error_id: string; project_id: string;
      fingerprint: string; received_at: string }
  | { type: 'error_dispatched'; error_id: string; project_id: string;
      run_id: string; dispatched_at: string }
  | { type: 'error_run_finished'; error_id: string; project_id: string;
      run_id: string; status: 'success' | 'failed' | 'skipped' | 'cancelled';
      output_snippet?: string | null; cost_usd?: number | null;
      duration_ms?: number | null; error?: string | null; finished_at: string }
  | { type: 'error_skipped'; error_id: string; project_id: string;
      dispatch_status: 'skipped' | 'failed' | 'deduped' | 'rate_limited' | 'cap_exceeded';
      skip_reason: string }
  // Phase 08: Revanote annotation lifecycle.
  | { type: 'revanote_received'; annotation_id: string; annotation_id_external: string;
      page_url: string; comment_preview: string; received_at: string }
  | { type: 'revanote_dispatched'; annotation_id: string; run_id: string;
      session_id: string; dispatched_at: string }
  | { type: 'revanote_skipped'; annotation_id: string; skip_reason: string }
  | { type: 'revanote_resolved'; annotation_id: string; run_id: string;
      resolved: boolean; action_taken?: string | null; files_changed?: string[];
      deployed?: boolean; finished_at: string }
  | { type: 'revanote_callback_sent'; annotation_id: string; attempt_no: number;
      http_status?: number | null; delivered: boolean; dead?: boolean;
      next_retry_at?: string | null }
  // Phase 06: Anthropic Claude subscription usage snapshot from the local
  // agent's poll of /api/oauth/usage. Broadcast to all clients of the user.
  | { type: 'subscription_usage'; usage: {
        five_hour: { utilization: number; resets_at: string }
        seven_day: { utilization: number; resets_at: string }
        seven_day_opus?: { utilization: number; resets_at: string } | null
        seven_day_oauth_apps?: { utilization: number; resets_at: string } | null
      }; updated_at: string }
  | { type: 'ping' }

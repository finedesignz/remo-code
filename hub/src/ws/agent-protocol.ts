import { z } from 'zod'
import {
  SupervisorHello, SupervisorState, SupervisorLog,
  RepoScanResult, RepoCloneProgress, RepoOpResult,
  SupervisorCommandsSync, HostResourcesMessage,
  SupervisorRepoInventory, SetRootsAck, RescanAck, ForceUpdateAck,
  SupervisorSessionInventory,
  RepoCreateProgress, RepoCreateFailed,
} from './supervisor-protocol'

// -- Agent -> Hub (inbound messages from the local streaming agent) --

export const AgentInfo = z.object({
  hostname: z.string().optional(),
  platform: z.string().optional(),       // e.g. 'darwin' | 'linux' | 'win32'
  os_release: z.string().optional(),     // e.g. '10.0.26200' or '14.4.1'
  arch: z.string().optional(),           // e.g. 'x64', 'arm64'
  cpu_model: z.string().optional(),
  cpu_cores: z.number().int().nonnegative().optional(),
  total_mem_bytes: z.number().nonnegative().optional(),
  node_version: z.string().optional(),
  bun_version: z.string().optional(),
  agent_version: z.string().optional(),
}).passthrough()

// CLI kinds supported by the agent runner. 'claude' = Claude Code CLI (default,
// backward compat). 'codex' = Codex CLI (Plan 05). Future kinds require a new
// schema rev.
export const CliKind = z.enum(['claude', 'codex'])
export type CliKindT = z.infer<typeof CliKind>

// Phase 08: agent-reported git introspection for the connecting `project_dir`.
// Used by the hub to collapse N worktrees of the same GitHub repo into a single
// session. Passthrough so future supervisor fields don't break old hubs. All
// fields are nullable / optional — a no-git agent omits the whole block.
export const GitIntrospection = z.object({
  is_git_repo: z.boolean(),
  is_worktree: z.boolean(),
  worktree_parent_path: z.string().nullable(),
  git_remote: z.string().nullable(),
  git_origin_github: z.object({
    owner: z.string().min(1).max(100),
    repo: z.string().min(1).max(100),
  }).nullable(),
}).passthrough()
export type GitIntrospectionT = z.infer<typeof GitIntrospection>

// NOTE: AgentAuth is a member of a discriminatedUnion below, which requires a
// raw ZodObject (no .refine wrappers). The "project_dir OR rootless_sessions"
// invariant is enforced in hub/src/ws/agent.ts after parse.
export const AgentAuth = z.object({
  type: z.literal('auth'),
  api_key: z.string().min(1),
  // Plan 05-002: optional so a rootless-only agent (advertising only ambient
  // sessions) can connect without a project dir. Hub-side handler rejects when
  // BOTH project_dir AND rootless_sessions are missing.
  project_dir: z.string().min(1).optional(),
  // REQUIRED BY CONTRACT (fix/supervisor-hostname-required). A hostname-less
  // auth mints a `status='online', hostname=NULL` ghost row that fools the
  // orchestrator's liveness check. Every supervisor build since #96 sends it,
  // so it stays `.optional()` only for the COMPAT WINDOW (older installed MSIs
  // + hub-side hostname resolution fallbacks). An EMPTY string is rejected
  // outright — it carries no information and is never legitimate. The hub
  // enforces presence in `agent.ts` (warn by default; hard 4001
  // `hostname_required` once REMO_WS_REQUIRE_HOSTNAME is flipped on) — NOT in
  // the schema, so an old client gets a diagnosable close code instead of a
  // bare zod protocol error. An empty string is treated as absent there.
  hostname: z.string().optional(),
  role: z.enum(['agent', 'supervisor']).optional(),
  agent_info: AgentInfo.optional(),
  // Plan 05-002: which CLI this agent intends to spawn for its project session.
  // When omitted, hub defaults to 'claude' (backward compat).
  cli_kind: CliKind.optional(),
  // Plan 05-002: agent advertises ambient (hostname-scoped) session capability.
  // Hub find-or-creates one row per entry, scoped to (user, hostname, cli_kind).
  rootless_sessions: z.array(CliKind).max(2).optional(),
  // Phase 08: optional git introspection of the connecting project_dir. When
  // present AND `git_origin_github != null`, the hub upserts sessions keyed by
  // `github://owner/repo` (collapsing worktrees). When absent or no GitHub
  // remote, the hub falls back to the legacy project_dir path.
  git: GitIntrospection.optional(),
})

export const AgentThinking = z.object({
  type: z.literal('thinking'),
  session_id: z.string(),
  content: z.string(),
})

export const AgentTextDelta = z.object({
  type: z.literal('text_delta'),
  session_id: z.string(),
  content: z.string(),
})

export const AgentToolUse = z.object({
  type: z.literal('tool_use'),
  session_id: z.string(),
  tool: z.string(),
  tool_id: z.string(),
  input: z.unknown(),
})

export const AgentToolResult = z.object({
  type: z.literal('tool_result'),
  session_id: z.string(),
  tool_id: z.string(),
  content: z.string(),
  is_error: z.boolean().optional(),
})

export const AgentStatus = z.object({
  type: z.literal('status'),
  session_id: z.string(),
  state: z.enum(['idle', 'thinking', 'tool_calling', 'writing']),
})

export const AgentAssistantMessage = z.object({
  type: z.literal('assistant_message'),
  session_id: z.string(),
  content: z.string().min(1).max(65536),
})

export const AgentPermissionRequest = z.object({
  type: z.literal('permission_request'),
  session_id: z.string(),
  request_id: z.string(),
  tool_name: z.string(),
  tool_input: z.unknown(),
})

export const AgentUserQuestion = z.object({
  type: z.literal('user_question'),
  session_id: z.string(),
  request_id: z.string(),
  question: z.string(),
  options: z.array(z.object({
    label: z.string(),
    description: z.string().optional(),
  })).optional(),
  is_multi_select: z.boolean().optional(),
})

export const AgentLog = z.object({
  type: z.literal('agent_log'),
  session_id: z.string(),
  message: z.string().max(1000),
})

// Phase 06: Anthropic Claude subscription quota snapshot reported by the agent
// every 5 minutes. Utilization is a 0-100 percentage from Anthropic's
// /api/oauth/usage endpoint. Opus + OAuth-apps windows are optional.
const UsageWindow = z.object({
  utilization: z.number(),
  resets_at: z.string(),
})
// Phase 18 (R-PTY-17): the post-June-15-2026 Agent-SDK programmatic credit pool
// — a monthly DOLLAR bucket, not a util% window. Carried ADDITIVELY: an
// un-upgraded supervisor (or a pre-claim account) omits it and still validates.
const ProgrammaticCredit = z.object({
  used_usd: z.number(),
  limit_usd: z.number(),
  resets_at: z.string(),
  claimed: z.boolean(),
})
export const AgentUsageReport = z.object({
  type: z.literal('usage_report'),
  usage: z.object({
    five_hour: UsageWindow,
    seven_day: UsageWindow,
    seven_day_opus: UsageWindow.nullable().optional(),
    seven_day_oauth_apps: UsageWindow.nullable().optional(),
    programmatic_credit: ProgrammaticCredit.nullable().optional(),
  }),
})
export type AgentUsageReportT = z.infer<typeof AgentUsageReport>

// P2 usage ledger — one event per assistant turn from the supervisor bridge.
// Carries the four token buckets, the model, and the authoritative SDK cost
// (`cost_source='sdk'`) or a flag for the hub to estimate (`'estimated'`).
// Additive member of AgentInbound — does NOT disturb the auth handshake.
export const AgentUsageEvent = z.object({
  type: z.literal('usage_event'),
  session_id: z.string(),
  model: z.string().nullable().optional(),
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  cache_creation_input_tokens: z.number().int().nonnegative().default(0),
  cache_read_input_tokens: z.number().int().nonnegative().default(0),
  cost_usd: z.number().nonnegative().default(0),
  cost_source: z.enum(['sdk', 'estimated']).default('sdk'),
  request_id: z.string().optional(),
  ts: z.string().optional(),
  // PTYCAP Phase 1 — which runner produced this event. Omitted ⇒ 'stream-json'
  // (every pre-existing sender). 'pty-interactive' is the new PtyUsageEmitter
  // source (transcript-tail, no API key, no PTY write). LOAD-BEARING NAME: this
  // key MUST be exactly `runner_type` (matching `msg.runner_type` read in the
  // hub's usage_event handler and the supervisor's AgentToHub field) — zod
  // strips any key it doesn't know, so a name mismatch here silently discards
  // the tag and every PTY row lands mislabelled 'stream-json'.
  runner_type: z.enum(['stream-json', 'pty-interactive']).optional(),
})
export type AgentUsageEventT = z.infer<typeof AgentUsageEvent>

export const AgentInbound = z.discriminatedUnion('type', [
  AgentAuth,
  AgentThinking,
  AgentTextDelta,
  AgentToolUse,
  AgentToolResult,
  AgentStatus,
  AgentAssistantMessage,
  AgentPermissionRequest,
  AgentUserQuestion,
  AgentLog,
  AgentUsageReport,
  AgentUsageEvent,
  z.object({ type: z.literal('pong') }),
  SupervisorHello,
  SupervisorState,
  SupervisorLog,
  RepoScanResult,
  RepoCloneProgress,
  RepoOpResult,
  SupervisorCommandsSync,
  HostResourcesMessage,
  SupervisorRepoInventory,
  SetRootsAck,
  RescanAck,
  ForceUpdateAck,
  SupervisorSessionInventory,
  RepoCreateProgress,
  RepoCreateFailed,
])

export type AgentInboundType = z.infer<typeof AgentInbound>

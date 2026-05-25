import { z } from 'zod'
import {
  SupervisorHello, SupervisorState, SupervisorLog,
  RepoScanResult, RepoCloneProgress, RepoOpResult,
  SupervisorCommandsSync, HostResourcesMessage,
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

export const AgentAuth = z.object({
  type: z.literal('auth'),
  api_key: z.string().min(1),
  project_dir: z.string().min(1),
  hostname: z.string().optional(),
  role: z.enum(['agent', 'supervisor']).optional(),
  agent_info: AgentInfo.optional(),
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
  z.object({ type: z.literal('pong') }),
  SupervisorHello,
  SupervisorState,
  SupervisorLog,
  RepoScanResult,
  RepoCloneProgress,
  RepoOpResult,
  SupervisorCommandsSync,
  HostResourcesMessage,
])

export type AgentInboundType = z.infer<typeof AgentInbound>

import { z } from 'zod'

// -- Supervisor -> Hub --

export const SupervisorHello = z.object({
  type: z.literal('supervisor.hello'),
  version: z.string(),
  os: z.string(),
  hostname: z.string(),
  roots: z.array(z.string()).max(50),
  capabilities: z.array(z.string()).optional(),
})

export const SupervisorState = z.object({
  type: z.literal('supervisor.state'),
  state: z.enum(['idle', 'starting', 'running', 'stopping', 'crashed', 'stopped']),
  run_id: z.string().nullable().optional(),
  repo_path: z.string().nullable().optional(),
  pid: z.number().nullable().optional(),
  restart_count: z.number().optional(),
  last_exit: z.object({
    code: z.number().nullable(),
    reason: z.string(),
    stderr_tail: z.string().optional(),
  }).optional(),
})

export const SupervisorLog = z.object({
  type: z.literal('supervisor.log'),
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string().max(4000),
  run_id: z.string().optional(),
  ts: z.string().optional(),
})

export const RepoScanResult = z.object({
  type: z.literal('repo.scan_result'),
  req_id: z.string(),
  repos: z.array(z.object({
    path: z.string(),
    name: z.string(),
    remote: z.string().nullable(),
    branch: z.string().nullable(),
    dirty: z.boolean(),
    last_commit: z.string().nullable().optional(),
  })).max(500),
})

export const RepoCloneProgress = z.object({
  type: z.literal('repo.clone_progress'),
  req_id: z.string(),
  stage: z.string(),
  percent: z.number().optional(),
})

export const RepoOpResult = z.object({
  type: z.literal('repo.op_result'),
  req_id: z.string(),
  op: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
  data: z.unknown().optional(),
})

export const SupervisorInbound = [
  SupervisorHello,
  SupervisorState,
  SupervisorLog,
  RepoScanResult,
  RepoCloneProgress,
  RepoOpResult,
]

// -- Hub -> Supervisor (constructed by hub, not validated) --

export type HubToSupervisor =
  | { type: 'repo.scan'; req_id: string }
  | { type: 'repo.clone'; req_id: string; clone_url: string; target_path: string; repo_full_name: string }
  | { type: 'repo.pull'; req_id: string; repo_path: string; branch: string; clone_url: string }
  | { type: 'repo.branch_checkout'; req_id: string; repo_path: string; branch: string; create: boolean }
  | { type: 'session.start'; req_id: string; run_id: string; repo_path: string; branch?: string; pull: boolean; initial_prompt?: string; api_key: string; hub_url: string }
  | { type: 'session.stop'; req_id: string; run_id: string; reason: string }
  | { type: 'session.status'; req_id: string }

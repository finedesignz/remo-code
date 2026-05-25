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

export const SupervisorCommandsSync = z.object({
  type: z.literal('supervisor.commands_sync'),
  commands: z.array(z.object({
    kind: z.enum(['command', 'skill']),
    name: z.string().max(120),
    description: z.string().max(2000).nullable(),
    source: z.string().max(120),
    path: z.string().max(1024),
  })).max(2000),
})

// W2/T10 — scheduled-run command lifecycle (supervisor-side).
export const RunStarted = z.object({
  type: z.literal('run_started'),
  run_id: z.string(),
})
export const RunOutput = z.object({
  type: z.literal('run_output'),
  run_id: z.string(),
  chunk: z.string().max(64_000),
})
export const RunFinished = z.object({
  type: z.literal('run_finished'),
  run_id: z.string(),
  exit_code: z.number().nullable().optional(),
  duration_ms: z.number().optional(),
  snippet: z.string().max(4000).optional(),
  error: z.string().max(2000).optional(),
})

// Host resource snapshot — supervisors send on connect + every 60s.
// Phase 04 plan 001 canonical shape: cpu/mem counts + derived concurrency
// budget + the source path that produced it. Persisted by plan 002's hub
// handler into the `supervisors` row (cpu_cores, total_mem_mb, free_mem_mb,
// concurrency_budget, budget_source, budget_updated_at).
export const HostResourcesMessage = z.object({
  type: z.literal('host_resources'),
  cpu_cores: z.number().int().positive(),
  total_mem_mb: z.number().int().positive(),
  free_mem_mb: z.number().int().nonnegative(),
  concurrency_budget: z.number().int().min(1),
  source: z.enum(['cgroup_v2', 'cgroup_v1', 'host_fallback']),
})

export const SupervisorInbound = [
  SupervisorHello,
  SupervisorState,
  SupervisorLog,
  RepoScanResult,
  RepoCloneProgress,
  RepoOpResult,
  SupervisorCommandsSync,
  RunStarted,
  RunOutput,
  RunFinished,
  HostResourcesMessage,
]

// -- Hub -> Supervisor (constructed by hub, not validated) --

export type HubToSupervisor =
  | { type: 'repo.scan'; req_id: string }
  | { type: 'repo.clone'; req_id: string; clone_url: string; target_path: string; repo_full_name: string }
  | { type: 'repo.pull'; req_id: string; repo_path: string; branch: string; clone_url: string }
  | { type: 'repo.branch_checkout'; req_id: string; repo_path: string; branch: string; create: boolean }
  | { type: 'repo.list_branches'; req_id: string; repo_path: string }
  | { type: 'session.start'; req_id: string; run_id: string; repo_path: string; branch?: string; pull: boolean; initial_prompt?: string; api_key: string; hub_url: string }
  | { type: 'session.stop'; req_id: string; run_id: string; reason: string }
  | { type: 'session.status'; req_id: string }
  // W2/T10 — execute a saved supervisor command; supervisor responds with
  // run_started → 0..N run_output chunks → run_finished.
  | { type: 'run_command'; run_id: string; command: string; args?: string[] }
  | { type: 'run_cancel'; run_id: string }

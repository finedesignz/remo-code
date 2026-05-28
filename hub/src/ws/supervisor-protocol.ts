import { z } from 'zod'

// -- Supervisor -> Hub --

export const SupervisorHello = z.object({
  type: z.literal('supervisor.hello'),
  version: z.string(),
  os: z.string(),
  hostname: z.string(),
  roots: z.array(z.string()).max(50),
  capabilities: z.array(z.string()).optional(),
  // Phase 06 — security capability advertisement (additive, optional for back-compat with <0.3 supervisors).
  allow_dangerous_skip_permissions: z.boolean().optional(),
  restrict_to_git: z.boolean().optional(),
  max_concurrent: z.number().int().positive().optional(),
  audit_log_enabled: z.boolean().optional(),
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

/**
 * Plan 04-001 — supervisor self-reports CPU/RAM/concurrency budget.
 *
 * Sent on connect and every 60s. Imported by `agent-protocol.ts` so the
 * AgentInbound discriminated union accepts it on the same socket the
 * supervisor uses.
 */
export const HostResourcesMessage = z.object({
  type: z.literal('host_resources'),
  cpu_cores: z.number().int().positive(),
  total_mem_mb: z.number().int().positive(),
  free_mem_mb: z.number().int().nonnegative(),
  concurrency_budget: z.number().int().min(1),
  source: z.enum(['cgroup_v2', 'cgroup_v1', 'host_fallback']),
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

/**
 * Phase 08 §15 — supervisor pushes its full repo inventory after each scan.
 * Each entry carries the introspection metadata the hub needs to
 * findOrCreateAgentSessionV2 (for GitHub-keyed entries) or upsert
 * `pending_local_repos` (for everything else). `canonical` flags the entry
 * the supervisor picks as the launch cwd for a github-origin group; the hub
 * still receives sibling worktrees so the "Connected from" tooltip + legacy
 * migration matching have the full set.
 */
export const SupervisorRepoInventory = z.object({
  type: z.literal('supervisor.repo_inventory'),
  scanned_at: z.string(),
  repos: z.array(z.object({
    local_path: z.string(),
    is_git_repo: z.boolean(),
    is_worktree: z.boolean(),
    worktree_parent_path: z.string().nullable(),
    git_remote: z.string().nullable(),
    git_origin_github: z.object({ owner: z.string(), repo: z.string() }).nullable(),
    /** Current branch (null for detached HEAD; missing on pre-0.5 supervisors). */
    branch: z.string().nullable().optional(),
    canonical: z.boolean().optional(),
  })).max(2000),
})

/**
 * Bug A (2026-05-28) — supervisor pushes its live runner set every ~10s so
 * the hub has authoritative ground truth for which sessions are actually
 * running on disk (independent of the per-session WS bridge state). The hub
 * uses this to flag sessions `active=true` in GET /api/sessions even when the
 * row's `status` column lags behind the runner reality (e.g. status hasn't
 * been updated by the bridge yet, or DB row was created without an explicit
 * status flip).
 *
 * Payload must stay <10KB. Only include sessions with a live runner — drop
 * stopped/finalized entries. Pre-0.5.7 supervisors don't send this message
 * (back-compat: hub treats missing inventory as "use status column truth").
 */
export const SupervisorSessionInventory = z.object({
  type: z.literal('session_inventory'),
  sessions: z.array(z.object({
    session_id: z.string().min(1).max(256),
    cli_kind: z.enum(['claude', 'codex']),
    project_dir: z.string().max(4096),
    pid: z.number().int().nullable().optional(),
    started_at: z.string(),
    last_activity_at: z.string().nullable().optional(),
    status: z.enum(['spawning', 'running', 'idle', 'stopping']),
  })).max(64),
})
export type SupervisorSessionInventoryT = z.infer<typeof SupervisorSessionInventory>

export const SupervisorInbound = [
  SupervisorHello,
  SupervisorState,
  SupervisorLog,
  RepoScanResult,
  RepoCloneProgress,
  RepoOpResult,
  SupervisorCommandsSync,
  HostResourcesMessage,
  RunStarted,
  RunOutput,
  RunFinished,
  SupervisorRepoInventory,
  SupervisorSessionInventory,
]

/**
 * Phase 08 §16 — Launch directive: hub asks supervisor to spawn a runner
 * (claude or codex) for an existing session with the canonical cwd resolved
 * from the most recent SupervisorRepoInventory. The supervisor reuses the
 * existing single WS to multiplex run_started/run_output/run_finished events
 * tagged by run_id back to the hub. On `cwd` missing → session.launch_failed.
 */
export const SessionLaunch = z.object({
  type: z.literal('session.launch'),
  run_id: z.string(),
  session_id: z.string(),
  cli_kind: z.enum(['claude', 'codex']),
  cwd: z.string(),
  api_key: z.string(),
  system_prompt: z.string().nullable().optional(),
  seed_files: z.array(z.object({
    relative_path: z.string(),
    contents: z.string(),
    sha256: z.string().optional(),
  })).optional(),
})

/**
 * Phase 08 §6 — Create-on-GitHub: hub already created the empty remote;
 * supervisor runs `git init` (if needed) → commit → `remote add origin` →
 * `git push -u origin HEAD`. Emits `repo_create_progress` per stage.
 */
export const CreateLocalRepoAndPush = z.object({
  type: z.literal('create_local_repo_and_push'),
  job_id: z.string(),
  session_id: z.string(),
  owner: z.string(),
  name: z.string(),
  visibility: z.enum(['private', 'public']),
  remote_url: z.string(),
  local_path: z.string(),
})

// Supervisor → hub progress for §6 and §16 failure path.
export const SessionLaunchFailed = z.object({
  type: z.literal('session.launch_failed'),
  run_id: z.string(),
  session_id: z.string(),
  error: z.string(),
})

export const RepoCreateProgress = z.object({
  type: z.literal('repo_create_progress'),
  job_id: z.string(),
  stage: z.enum([
    'validating_scope',
    'creating_remote',
    'init',
    'commit',
    'remote_add',
    'pushing_locally',
    'pushed',
    'reindexing',
    'done',
  ]),
  percent: z.number().min(0).max(100).optional(),
  message: z.string().max(2000).optional(),
})

export const RepoCreateFailed = z.object({
  type: z.literal('repo_create_failed'),
  job_id: z.string(),
  stage: z.string(),
  error: z.string().max(2000),
})

// (Re-export the union additions; existing SupervisorInbound stays exported above.)
/**
 * Phase 12 W2 — supervisor.set_roots ack from supervisor → hub.
 * The hub sends a `set_roots` directive (see HubToSupervisor below) and
 * supervisor replies with this ack carrying the actually-applied roots list
 * (after dedupe/normalize on its side) and a re-scan trigger result.
 */
export const SetRootsAck = z.object({
  type: z.literal('supervisor.set_roots_ack'),
  req_id: z.string(),
  ok: z.boolean(),
  applied_roots: z.array(z.string()).max(50).optional(),
  error: z.string().max(2000).optional(),
})

export const SupervisorInboundV2 = [
  ...SupervisorInbound,
  SessionLaunchFailed,
  RepoCreateProgress,
  RepoCreateFailed,
  SetRootsAck,
]

// -- Hub -> Supervisor (constructed by hub, not validated) --

export type HubToSupervisor =
  | { type: 'repo.scan'; req_id: string }
  | { type: 'repo.clone'; req_id: string; clone_url: string; target_path: string; repo_full_name: string }
  | { type: 'repo.pull'; req_id: string; repo_path: string; branch: string; clone_url: string }
  | { type: 'repo.branch_checkout'; req_id: string; repo_path: string; branch: string; create: boolean }
  | { type: 'repo.list_branches'; req_id: string; repo_path: string }
  | { type: 'session.start'; req_id: string; run_id: string; repo_path: string; branch?: string; pull: boolean; initial_prompt?: string; api_key: string; hub_url: string; dangerously_skip_permissions?: boolean }
  | { type: 'session.stop'; req_id: string; run_id: string; reason: string }
  | { type: 'session.status'; req_id: string }
  // Phase 08 §16 — Launch on demand. Carries cwd resolved from inventory.
  | {
      type: 'session.launch'
      run_id: string
      session_id: string
      cli_kind: 'claude' | 'codex'
      cwd: string
      api_key: string
      system_prompt?: string | null
      seed_files?: Array<{ relative_path: string; contents: string; sha256?: string }>
    }
  // Phase 08 §6 — Create local repo + push to fresh GitHub remote.
  | {
      type: 'create_local_repo_and_push'
      job_id: string
      session_id: string
      owner: string
      name: string
      visibility: 'private' | 'public'
      remote_url: string
      local_path: string
    }
  // W2/T10 — execute a saved supervisor command; supervisor responds with
  // run_started → 0..N run_output chunks → run_finished.
  | { type: 'run_command'; run_id: string; command: string; args?: string[] }
  | { type: 'run_cancel'; run_id: string }
  // v0.5.4 — hub-pushed API key rotation. Supervisor swaps the in-memory key,
  // writes supervisor.json (no BOM), and reconnects with the new key. Sent
  // only to supervisor sockets owned by the same user as the rotated key.
  | { type: 'key_rotated'; new_api_key: string; key_id: string }
  // Phase 12 W2 — push updated root folder list from the web UI to the
  // running supervisor. Supervisor writes supervisor.json (no BOM via
  // Bun.write/native UTF-8 writeFileSync), re-scans, then emits set_roots_ack.
  | { type: 'supervisor.set_roots'; req_id: string; roots: string[] }

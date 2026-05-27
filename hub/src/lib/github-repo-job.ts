/**
 * Phase 08 §6 + Plan 005 T6 — Create-on-GitHub background job.
 *
 * In-memory job state (lost on hub restart — user clicks Create again).
 * Stages:
 *   validating_scope → creating_remote → pushing_locally → reindexing → done
 * Progress events are broadcast to the user's web clients via
 * `broadcastToUser(userId, { type: 'repo_create_progress', ... })`.
 *
 * The supervisor performs the actual git push on receipt of
 * `create_local_repo_and_push`. On `repo_create_progress { stage: 'pushed' }`
 * the job marks itself complete and triggers a re-scan request.
 */
import { Octokit } from '@octokit/rest'
import { randomUUID } from 'node:crypto'
import { broadcastToUser } from '../ws/registry'
import { sendToSupervisor, listOnlineSupervisorIdsForUser } from '../ws/supervisor-registry'
import { probeGithubAppScope } from './github-scope'

export type JobStage =
  | 'validating_scope'
  | 'creating_remote'
  | 'pushing_locally'
  | 'reindexing'
  | 'done'
  | 'failed'

export interface JobState {
  job_id: string
  user_id: string
  session_id: string
  stage: JobStage
  percent: number
  error?: string
  failed_at_stage?: JobStage
  created_at: number
  updated_at: number
  remote_url?: string
}

const jobs = new Map<string, JobState>()

export function getJob(jobId: string): JobState | undefined {
  return jobs.get(jobId)
}

export function listJobsForUser(userId: string): JobState[] {
  return Array.from(jobs.values()).filter((j) => j.user_id === userId)
}

function updateJob(jobId: string, patch: Partial<JobState>): JobState | undefined {
  const j = jobs.get(jobId)
  if (!j) return undefined
  Object.assign(j, patch, { updated_at: Date.now() })
  broadcastToUser(j.user_id, {
    type: 'repo_create_progress',
    job_id: jobId,
    stage: j.stage,
    percent: j.percent,
    error: j.error,
  })
  return j
}

/**
 * Called by the supervisor message handler when a `repo_create_progress`
 * arrives from the supervisor. Maps supervisor-side stages onto our
 * coarser job model and finalizes on `pushed`.
 */
export function applySupervisorProgress(jobId: string, supervisorStage: string): void {
  const j = jobs.get(jobId)
  if (!j) return
  const map: Record<string, { stage: JobStage; percent: number }> = {
    init: { stage: 'pushing_locally', percent: 50 },
    commit: { stage: 'pushing_locally', percent: 60 },
    remote_add: { stage: 'pushing_locally', percent: 70 },
    pushing_locally: { stage: 'pushing_locally', percent: 80 },
    pushed: { stage: 'reindexing', percent: 90 },
    reindexing: { stage: 'reindexing', percent: 95 },
    done: { stage: 'done', percent: 100 },
  }
  const m = map[supervisorStage]
  if (!m) return
  updateJob(jobId, { stage: m.stage, percent: m.percent })
}

export function failJob(jobId: string, stage: JobStage, error: string): void {
  updateJob(jobId, { stage: 'failed', failed_at_stage: stage, error })
}

interface EnqueueOpts {
  user_id: string
  session_id: string
  local_path: string
  name: string
  visibility: 'private' | 'public'
  org?: string | null
}

export function enqueueCreateGithubRepoJob(opts: EnqueueOpts): { job_id: string } {
  const job_id = randomUUID()
  const now = Date.now()
  const state: JobState = {
    job_id,
    user_id: opts.user_id,
    session_id: opts.session_id,
    stage: 'validating_scope',
    percent: 0,
    created_at: now,
    updated_at: now,
  }
  jobs.set(job_id, state)

  // Fire-and-forget — caller already returned 202 to the user.
  void runJob(state, opts).catch((err) => {
    console.error(`[github-repo-job ${job_id}] uncaught: ${err?.message}`)
    failJob(job_id, state.stage, err?.message ?? String(err))
  })

  return { job_id }
}

async function runJob(state: JobState, opts: EnqueueOpts): Promise<void> {
  // Stage 1: re-probe scope (cached for 5min — cheap if already warm).
  updateJob(state.job_id, { stage: 'validating_scope', percent: 5 })
  const scope = await probeGithubAppScope()
  if (!scope.hasAdminWrite) {
    failJob(state.job_id, 'validating_scope', 'github_app_missing_administration_write')
    return
  }

  // Stage 2: create the empty GitHub repo via the gateway-supplied token.
  // We re-fetch the token here rather than passing it through — scope probe's
  // raw payload doesn't include the token.
  updateJob(state.job_id, { stage: 'creating_remote', percent: 20 })
  const token = await loadGithubToken()
  if (!token) {
    failJob(state.job_id, 'creating_remote', 'no_github_token_from_gateway')
    return
  }

  let remoteUrl: string
  let owner: string
  try {
    const octokit = new Octokit({ auth: token, request: { timeout: 10_000 } })
    if (opts.org) {
      const res = await octokit.repos.createInOrg({
        org: opts.org,
        name: opts.name,
        private: opts.visibility === 'private',
        auto_init: false,
      })
      remoteUrl = res.data.clone_url
      owner = opts.org
    } else {
      const res = await octokit.repos.createForAuthenticatedUser({
        name: opts.name,
        private: opts.visibility === 'private',
        auto_init: false,
      })
      remoteUrl = res.data.clone_url
      owner = res.data.owner.login
    }
  } catch (err: any) {
    failJob(state.job_id, 'creating_remote', `octokit_create_failed: ${err?.message ?? err?.status}`)
    return
  }
  updateJob(state.job_id, { stage: 'creating_remote', percent: 40, remote_url: remoteUrl })

  // Stage 3: ask the supervisor to push.
  const supervisorIds = listOnlineSupervisorIdsForUser(state.user_id)
  if (supervisorIds.length === 0) {
    failJob(state.job_id, 'pushing_locally', 'supervisor_offline')
    return
  }
  const supervisorId = supervisorIds[0] // first online supervisor wins; multi-host out of scope for v1
  try {
    sendToSupervisor(supervisorId, {
      type: 'create_local_repo_and_push',
      job_id: state.job_id,
      session_id: state.session_id,
      owner,
      name: opts.name,
      visibility: opts.visibility,
      remote_url: remoteUrl,
      local_path: opts.local_path,
    })
  } catch (err: any) {
    failJob(state.job_id, 'pushing_locally', `dispatch_failed: ${err?.message}`)
    return
  }
  updateJob(state.job_id, { stage: 'pushing_locally', percent: 50 })
  // Supervisor will drive subsequent stages via applySupervisorProgress().
}

async function loadGithubToken(): Promise<string | null> {
  const pairs: Array<[string | undefined, string | undefined]> = [
    [process.env.GATEWAY_URL, process.env.GATEWAY_API_KEY],
    [process.env.FALLBACK_GATEWAY_URL, process.env.FALLBACK_GATEWAY_API_KEY],
  ]
  for (const [url, key] of pairs) {
    if (!url || !key) continue
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/api/credentials/service/github`, {
        headers: { 'X-Api-Key': key },
        signal: AbortSignal.timeout(5_000),
      })
      if (!res.ok) continue
      const body = (await res.json()) as { token?: string }
      if (body?.token) return body.token
    } catch {
      // try fallback
    }
  }
  return null
}

import { useEffect, useState } from 'react'

/**
 * Hub-side stage enum coming over WS via `repo_create_progress`.
 * Source of truth: `hub/src/ws/supervisor-protocol.ts > RepoCreateProgress`.
 * The hub forwards both its own stages (validating_scope, creating_remote,
 * reindexing, done) and the supervisor's lower-level stages (init, commit,
 * remote_add, pushing_locally, pushed) in the same channel.
 */
export type RepoCreateStage =
  | 'validating_scope'
  | 'creating_remote'
  | 'init'
  | 'commit'
  | 'remote_add'
  | 'pushing_locally'
  | 'pushed'
  | 'reindexing'
  | 'done'

export interface RepoCreateJobState {
  stage: RepoCreateStage | 'failed' | null
  /** Percent in 0..100 if the hub provides one, otherwise inferred from stage. */
  percent: number
  error: string | null
  /** Free-form supervisor-supplied message (e.g. "pushing to origin"). */
  message: string | null
  /** True once we've seen `done`. */
  finished: boolean
}

type Subscribe = (handler: (msg: any) => void) => () => void

const STAGE_PERCENT: Record<RepoCreateStage, number> = {
  validating_scope: 5,
  creating_remote: 20,
  init: 50,
  commit: 60,
  remote_add: 70,
  pushing_locally: 80,
  pushed: 90,
  reindexing: 95,
  done: 100,
}

/** Human-readable label for a stage — used by the modal progress bar. */
export function stageLabel(stage: RepoCreateStage | 'failed' | null): string {
  switch (stage) {
    case 'validating_scope': return 'Validating GitHub App scope'
    case 'creating_remote': return 'Creating repo on GitHub'
    case 'init':
    case 'commit': return 'Preparing initial commit'
    case 'remote_add': return 'Linking remote'
    case 'pushing_locally': return 'Pushing to GitHub'
    case 'pushed': return 'Pushed'
    case 'reindexing': return 'Re-indexing'
    case 'done': return 'Done'
    case 'failed': return 'Failed'
    default: return 'Starting…'
  }
}

/**
 * Subscribe to `repo_create_progress` / `repo_create_failed` WS messages
 * filtered to a single job_id. Returns the latest state. Pass `null` as the
 * jobId to disable (returns a neutral initial state).
 *
 * Usage:
 *   const { subscribe } = useWebSocket(token)
 *   const job = useRepoCreateJob(jobId, subscribe)
 *   // job.stage, job.percent, job.error, job.finished
 */
export function useRepoCreateJob(jobId: string | null, subscribe: Subscribe): RepoCreateJobState {
  const [state, setState] = useState<RepoCreateJobState>({
    stage: null,
    percent: 0,
    error: null,
    message: null,
    finished: false,
  })

  useEffect(() => {
    if (!jobId) {
      setState({ stage: null, percent: 0, error: null, message: null, finished: false })
      return
    }
    const off = subscribe((msg: any) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.job_id !== jobId) return

      if (msg.type === 'repo_create_progress') {
        const stage = msg.stage as RepoCreateStage | undefined
        if (!stage) return
        const pct = typeof msg.percent === 'number'
          ? msg.percent
          : STAGE_PERCENT[stage] ?? 0
        setState(prev => ({
          stage,
          percent: Math.max(prev.percent, pct),
          error: null,
          message: typeof msg.message === 'string' ? msg.message : prev.message,
          finished: stage === 'done',
        }))
        return
      }

      if (msg.type === 'repo_create_failed') {
        setState(prev => ({
          stage: 'failed',
          percent: prev.percent,
          error: typeof msg.error === 'string' ? msg.error : 'unknown',
          message: prev.message,
          finished: false,
        }))
        return
      }
    })
    return off
  }, [jobId, subscribe])

  return state
}

/**
 * v0.8.7 CHANGE 2 — hub side of create_local_repo_and_push.
 *
 * 1. AgentInbound must accept the supervisor's repo_create_progress and
 *    repo_create_failed frames (otherwise safeParse silently drops them before
 *    the agent.ts handler runs — the same class of bug that killed the
 *    supervisor hello once).
 * 2. applySupervisorProgress maps each supervisor stage onto the job model and
 *    finalizes pushed → reindexing(90), done → done(100).
 */
import { describe, expect, test } from 'bun:test'
import { AgentInbound } from '../src/ws/agent-protocol'
import {
  enqueueCreateGithubRepoJob,
  applySupervisorProgress,
  getJob,
} from '../src/lib/github-repo-job'

describe('repo_create_progress wiring', () => {
  test('AgentInbound accepts repo_create_progress', () => {
    const r = AgentInbound.safeParse({
      type: 'repo_create_progress',
      job_id: 'job-1',
      stage: 'pushed',
    })
    expect(r.success).toBe(true)
  })

  test('AgentInbound accepts repo_create_failed', () => {
    const r = AgentInbound.safeParse({
      type: 'repo_create_failed',
      job_id: 'job-1',
      stage: 'pushing_locally',
      error: 'remote rejected',
    })
    expect(r.success).toBe(true)
  })

  test('applySupervisorProgress advances job through the stage sequence', () => {
    const { job_id } = enqueueCreateGithubRepoJob({
      user_id: 'u1',
      session_id: 's1',
      local_path: '/tmp/x',
      name: 'x',
      visibility: 'private',
    })
    const seq: Array<[string, number]> = []
    for (const stage of ['init', 'commit', 'remote_add', 'pushing_locally', 'pushed', 'reindexing', 'done']) {
      applySupervisorProgress(job_id, stage)
      const j = getJob(job_id)!
      seq.push([j.stage, j.percent])
    }
    // Monotonic non-decreasing percent ending at 100/done.
    expect(seq[seq.length - 1]).toEqual(['done', 100])
    expect(seq[4]).toEqual(['reindexing', 90]) // 'pushed' maps to reindexing/90
    const percents = seq.map((s) => s[1])
    for (let i = 1; i < percents.length; i++) {
      expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1])
    }
  })
})

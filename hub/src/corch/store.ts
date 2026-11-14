// hub/src/corch/store.ts
//
// CORCH-01: persistence for the central-orchestrator queue. Every end-of-run transition is ONE
// transaction whose first statement is a guarded `UPDATE corch_runs ... WHERE ended_at IS NULL`, so
// a double delivery changes nothing (LD-9). The run's lifetime-counter key is passed as the
// positional SQL parameter `runKey` into column counter_key, never as an object property (LD-4).

import { randomUUID } from 'node:crypto'
import { sql } from '../db/postgres.ts'
import { buildCorchKey, corchBranch, corchUserLockKey } from './keys.ts'

export type WorkSource = 'manual' | 'gsd_console' | 'aaf' | 'memlog'

export interface CorchProject {
  id: string
  user_id: string
  repo_ident: string
  priority: number
  daily_token_budget: string | number
  enabled: boolean
  accept_external: boolean
  created_at: Date
  updated_at: Date
}

export interface CorchWorkItem {
  id: string
  user_id: string
  project_id: string
  source: WorkSource
  source_ref: string
  title: string
  body: string
  priority: number
  status: 'queued' | 'running' | 'pr_open' | 'done' | 'blocked' | 'cancelled'
  wait_reason: string | null
  not_before: Date | null
  attempts: number
  max_attempts: number
  branch: string
  pr_url: string | null
  created_at: Date
  updated_at: Date
}

export interface CorchRun {
  id: string
  work_item_id: string
  project_id: string
  user_id: string
  account_slot: string | null
  supervisor_id: string | null
  session_id: string | null
  worktree_path: string | null
  counter_key: string
  status: 'launching' | 'running' | 'stalled' | 'ended'
  end_reason: string | null
  heartbeat_at: Date
  started_at: Date
  ended_at: Date | null
}

export interface EnqueueInput {
  userId: string
  projectId: string
  source: WorkSource
  sourceRef: string
  title: string
  body: string
  priority: number
}

/** When a requeued item becomes eligible again. null = event-driven (no timer). */
export type NotBefore = null | { midnightTz: string } | { plusSeconds: number }

export interface EndRequeueInput {
  endReason: string
  /** true => attempts + 1, bounded backoff, blocked at max_attempts (LD-8). false => no attempt (LD-7). */
  consumeAttempt: boolean
  waitReason: string | null
  /** Used only when consumeAttempt is false. */
  notBefore: NotBefore
}

export type EndResult =
  | { changed: false }
  | { changed: true; workItemId: string; userId: string; itemStatus: CorchWorkItem['status']; attempts: number }

export interface Claimed {
  run: CorchRun
  item: CorchWorkItem
  project: CorchProject
}

export interface CreateProjectInput {
  userId: string
  repoIdent: string
  priority: number
  dailyTokenBudget: number
  enabled: boolean
  acceptExternal: boolean
}

export interface ProjectPatch {
  priority?: number
  dailyTokenBudget?: number
  enabled?: boolean
  acceptExternal?: boolean
}

/** Every store method, so tests can implement fakes. */
export interface CorchStore {
  createProject(i: CreateProjectInput): Promise<{ project: CorchProject; created: boolean }>
  listProjects(userId: string): Promise<CorchProject[]>
  getProject(userId: string, projectId: string): Promise<CorchProject | null>
  getProjectByIdent(userId: string, repoIdent: string): Promise<CorchProject | null>
  /** Returns the updated row and the previous enabled flag, or null when the caller has no such project. */
  updateProject(userId: string, projectId: string, patch: ProjectPatch): Promise<{ project: CorchProject; previousEnabled: boolean } | null>
  listWorkItems(userId: string, status: CorchWorkItem['status'] | null, limit: number): Promise<CorchWorkItem[]>
  enqueueWorkItem(i: EnqueueInput): Promise<{ item: CorchWorkItem; created: boolean }>
  claimNext(userId: string, excludeIds: string[]): Promise<Claimed | null>
  attachSession(runId: string, sessionId: string, worktreePath: string | null): Promise<boolean>
  endRunAndRequeue(runId: string, i: EndRequeueInput): Promise<EndResult>
  endRunMarkPrOpen(runId: string, prUrl: string): Promise<EndResult>
  isEnrolledEnabled(userId: string, repoIdent: string): Promise<boolean>
}

export const corchStore: CorchStore = {
  async createProject(i) {
    const inserted = await sql<CorchProject[]>`
      INSERT INTO corch_projects (user_id, repo_ident, priority, daily_token_budget, enabled, accept_external)
      VALUES (${i.userId}, ${i.repoIdent}, ${i.priority}, ${i.dailyTokenBudget}, ${i.enabled}, ${i.acceptExternal})
      ON CONFLICT (user_id, repo_ident) DO NOTHING
      RETURNING *`
    if (inserted.length > 0) return { project: inserted[0]!, created: true }
    const existing = await sql<CorchProject[]>`
      SELECT * FROM corch_projects WHERE user_id = ${i.userId} AND repo_ident = ${i.repoIdent}`
    return { project: existing[0]!, created: false }
  },

  async listProjects(userId) {
    return sql<CorchProject[]>`
      SELECT * FROM corch_projects WHERE user_id = ${userId} ORDER BY priority DESC, created_at ASC`
  },

  async getProject(userId, projectId) {
    const r = await sql<CorchProject[]>`SELECT * FROM corch_projects WHERE id = ${projectId} AND user_id = ${userId}`
    return r[0] ?? null
  },

  async getProjectByIdent(userId, repoIdent) {
    const r = await sql<CorchProject[]>`
      SELECT * FROM corch_projects WHERE user_id = ${userId} AND repo_ident = ${repoIdent}`
    return r[0] ?? null
  },

  async updateProject(userId, projectId, p) {
    return sql.begin(async (tx) => {
      const prev = await tx<{ enabled: boolean }[]>`
        SELECT enabled FROM corch_projects WHERE id = ${projectId} AND user_id = ${userId} FOR UPDATE`
      if (prev.length === 0) return null
      const rows = await tx<CorchProject[]>`
        UPDATE corch_projects SET
          priority = COALESCE(${p.priority ?? null}::integer, priority),
          daily_token_budget = COALESCE(${p.dailyTokenBudget ?? null}::bigint, daily_token_budget),
          enabled = COALESCE(${p.enabled ?? null}::boolean, enabled),
          accept_external = COALESCE(${p.acceptExternal ?? null}::boolean, accept_external),
          updated_at = now()
        WHERE id = ${projectId} AND user_id = ${userId} RETURNING *`
      return { project: rows[0]!, previousEnabled: prev[0]!.enabled }
    })
  },

  async listWorkItems(userId, status, limit) {
    return sql<CorchWorkItem[]>`
      SELECT * FROM corch_work_items
      WHERE user_id = ${userId} AND (${status}::text IS NULL OR status = ${status}::text)
      ORDER BY created_at DESC LIMIT ${limit}`
  },

  async enqueueWorkItem(i) {
    const id = randomUUID()
    const branch = corchBranch(id)
    const inserted = await sql<CorchWorkItem[]>`
      INSERT INTO corch_work_items (id, user_id, project_id, source, source_ref, title, body, priority, branch)
      VALUES (${id}, ${i.userId}, ${i.projectId}, ${i.source}, ${i.sourceRef}, ${i.title}, ${i.body}, ${i.priority}, ${branch})
      ON CONFLICT (user_id, source, source_ref) DO NOTHING
      RETURNING *`
    if (inserted.length > 0) return { item: inserted[0]!, created: true }
    const existing = await sql<CorchWorkItem[]>`
      SELECT * FROM corch_work_items WHERE user_id = ${i.userId} AND source = ${i.source} AND source_ref = ${i.sourceRef}`
    return { item: existing[0]!, created: false }
  },

  async claimNext(userId, excludeIds) {
    const lockKey = corchUserLockKey(userId)
    try {
      return await sql.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`
        const live = await tx<{ n: number }[]>`
          SELECT count(*)::int AS n FROM corch_runs WHERE user_id = ${userId} AND ended_at IS NULL`
        const cap = await tx<{ c: number }[]>`
          SELECT corch_max_concurrent_runs AS c FROM users WHERE id = ${userId}`
        if (cap.length === 0 || live[0]!.n >= cap[0]!.c) return null

        const cand = await tx<CorchWorkItem[]>`
          SELECT i.*
          FROM corch_work_items i
          JOIN corch_projects p ON p.id = i.project_id AND p.user_id = i.user_id
          WHERE i.user_id = ${userId}
            AND i.status = 'queued'
            AND (i.not_before IS NULL OR i.not_before <= now())
            AND p.enabled = true
            AND NOT EXISTS (SELECT 1 FROM corch_runs r WHERE r.project_id = p.id AND r.ended_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM corch_work_items x WHERE x.project_id = p.id AND x.status = 'pr_open')
            AND i.id <> ALL(${excludeIds}::uuid[])
          ORDER BY p.priority DESC, i.priority DESC, i.created_at ASC, i.id ASC
          LIMIT 1`
        const item = cand[0]
        if (!item) return null

        const runKey = buildCorchKey(item.id)
        const runs = await tx<CorchRun[]>`
          INSERT INTO corch_runs (work_item_id, project_id, user_id, counter_key)
          VALUES (${item.id}, ${item.project_id}, ${userId}, ${runKey})
          RETURNING *`
        await tx`
          UPDATE corch_work_items SET status = 'running', wait_reason = NULL, updated_at = now() WHERE id = ${item.id}`
        const project = await tx<CorchProject[]>`SELECT * FROM corch_projects WHERE id = ${item.project_id}`
        return { run: runs[0]!, item: { ...item, status: 'running' as const, wait_reason: null }, project: project[0]! }
      })
    } catch (err: any) {
      if (err?.code === '23505') return null // lost a race on a live-run unique index
      throw err
    }
  },

  async attachSession(runId, sessionId, worktreePath) {
    const r = await sql`
      UPDATE corch_runs SET session_id = ${sessionId}, worktree_path = ${worktreePath}
      WHERE id = ${runId} AND ended_at IS NULL RETURNING id`
    return r.length > 0
  },

  async endRunAndRequeue(runId, i) {
    return sql.begin(async (tx): Promise<EndResult> => {
      const ended = await tx<{ work_item_id: string; user_id: string }[]>`
        UPDATE corch_runs SET status = 'ended', end_reason = ${i.endReason}, ended_at = now()
        WHERE id = ${runId} AND ended_at IS NULL RETURNING work_item_id, user_id`
      if (ended.length === 0) return { changed: false }
      const itemId = ended[0]!.work_item_id
      let row: { status: CorchWorkItem['status']; attempts: number }[]
      if (i.consumeAttempt) {
        // New attempts = attempts + 1; blocked at max_attempts, else backoff 60s * 5^(newAttempts - 1).
        row = await tx`
          UPDATE corch_work_items SET
            attempts = attempts + 1,
            status = CASE WHEN attempts + 1 >= max_attempts THEN 'blocked' ELSE 'queued' END,
            wait_reason = ${i.endReason},
            not_before = CASE WHEN attempts + 1 >= max_attempts THEN NULL
                              ELSE now() + make_interval(secs => 60 * power(5, attempts)::double precision) END,
            updated_at = now()
          WHERE id = ${itemId} RETURNING status, attempts`
      } else {
        const nb = i.notBefore
        const midnightTz = nb && 'midnightTz' in nb ? nb.midnightTz : null
        const plusSeconds = nb && 'plusSeconds' in nb ? nb.plusSeconds : null
        row = await tx`
          UPDATE corch_work_items SET
            status = 'queued',
            wait_reason = ${i.waitReason},
            not_before = CASE
              WHEN ${midnightTz}::text IS NOT NULL
                THEN (date_trunc('day', now() AT TIME ZONE ${midnightTz}::text) + interval '1 day') AT TIME ZONE ${midnightTz}::text
              WHEN ${plusSeconds}::double precision IS NOT NULL
                THEN now() + make_interval(secs => ${plusSeconds}::double precision)
              ELSE NULL END,
            updated_at = now()
          WHERE id = ${itemId} RETURNING status, attempts`
      }
      return { changed: true, workItemId: itemId, userId: ended[0]!.user_id, itemStatus: row[0]!.status, attempts: row[0]!.attempts }
    })
  },

  async endRunMarkPrOpen(runId, prUrl) {
    return sql.begin(async (tx): Promise<EndResult> => {
      const ended = await tx<{ work_item_id: string; user_id: string }[]>`
        UPDATE corch_runs SET status = 'ended', end_reason = 'pr_open', ended_at = now()
        WHERE id = ${runId} AND ended_at IS NULL RETURNING work_item_id, user_id`
      if (ended.length === 0) return { changed: false }
      const row = await tx<{ status: CorchWorkItem['status']; attempts: number }[]>`
        UPDATE corch_work_items SET status = 'pr_open', pr_url = ${prUrl}, wait_reason = NULL, not_before = NULL, updated_at = now()
        WHERE id = ${ended[0]!.work_item_id} RETURNING status, attempts`
      return { changed: true, workItemId: ended[0]!.work_item_id, userId: ended[0]!.user_id, itemStatus: row[0]!.status, attempts: row[0]!.attempts }
    })
  },

  async isEnrolledEnabled(userId, repoIdent) {
    const r = await sql`
      SELECT 1 FROM corch_projects WHERE user_id = ${userId} AND repo_ident = ${repoIdent} AND enabled = true`
    return r.length > 0
  },
}

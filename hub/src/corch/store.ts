// hub/src/corch/store.ts
//
// CORCH-01: persistence for the central-orchestrator queue. Every end-of-run transition is ONE
// transaction whose first statement is a guarded `UPDATE corch_runs ... WHERE ended_at IS NULL`, so
// a double delivery changes nothing (LD-9). The run's lifetime-counter key is passed as the
// positional SQL parameter `runKey` into column counter_key, never as an object property (LD-4).

import { randomUUID } from 'node:crypto'
import { sql } from '../db/postgres.ts'
import { buildCorchKey, corchBranch, corchUserLockKey } from './keys.ts'

/** corch/<work_item_id> head ref (the id is a lowercase uuid). */
const AAF_HEAD_REF_RE = /^corch\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export type WorkSource = 'manual' | 'gsd_console' | 'aaf' | 'memlog'

export interface CorchProject {
  id: string
  user_id: string
  repo_ident: string
  priority: number
  daily_token_budget: string | number
  enabled: boolean
  accept_external: boolean
  /** CORCH-08: AAF project id once provisioned. */
  aaf_project_id: string | null
  /** CORCH-08: only 'provisioned' projects are dispatchable (fail closed). */
  aaf_provision_status: AafProvisionStatus
  created_at: Date
  updated_at: Date
}

export type AafProvisionStatus = 'aaf_unprovisioned' | 'provisioned'

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
export type NotBefore = null | { midnightTz: string } | { plusSeconds: number } | { at: string }

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
  | {
      changed: true
      workItemId: string
      userId: string
      itemStatus: CorchWorkItem['status']
      attempts: number
      /** CORCH-08: the item was no longer 'running' (an AAF closure event moved it), so it was left untouched. */
      itemUntouched?: boolean
    }

/** Everything a gate needs about one run: identity, the item/project, the user's cap and tz. */
export interface RunContext {
  run: CorchRun
  item: CorchWorkItem
  project: CorchProject
  maxConcurrent: number
  tz: string
}

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

/** A live run with the item facts the reconciler needs (no untrusted text). */
export interface LiveRun extends CorchRun {
  repo_ident: string
  item_attempts: number
}

/** CORCH-08: a validated AAF event (parsed fields only; never the raw body). */
export interface AafEventInput {
  eventId: string
  event: 'pr.merged' | 'pr.closed' | 'pr.failed'
  /** owner/name as sent (untrusted; validated by the route). */
  repo: string
  headRef: string
  prNumber: number | null
}

export type AafEventResult =
  | { kind: 'duplicate' }
  | { kind: 'unchanged'; reason: 'unknown_item' | 'terminal' | 'already_blocked' }
  | { kind: 'transitioned'; userId: string; workItemId: string; to: 'done' | 'blocked' }

export interface ProvisionResultInput {
  status: AafProvisionStatus
  aafProjectId: string | null
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
  /** CORCH-08: record the outcome of an AAF provision attempt on the project. */
  setProvisionResult(projectId: string, r: ProvisionResultInput): Promise<CorchProject | null>
  /** CORCH-08: projects still needing provisioning (one-shot corch-provision-existing script). */
  listUnprovisionedProjects(): Promise<CorchProject[]>
  /** CORCH-08: dedupe on event_id, resolve the item by repo + head ref, apply the closure transition, one tx. */
  applyAafEvent(e: AafEventInput): Promise<AafEventResult>
  /**
   * CORCH-08: atomically claim the owner notification of a pr.failed event (pending, or a 'sending' claim older
   * than 5 minutes). Returns the recipient, or null when there is nothing to send / another delivery owns it.
   */
  claimAafNotify(eventId: string): Promise<{ userId: string; workItemId: string } | null>
  /** CORCH-08: record the delivery outcome of a claimed notification (false releases it for a retry). */
  finishAafNotify(eventId: string, delivered: boolean): Promise<void>
  claimNext(userId: string, excludeIds: string[]): Promise<Claimed | null>
  attachSession(runId: string, sessionId: string, worktreePath: string | null): Promise<boolean>
  endRunAndRequeue(runId: string, i: EndRequeueInput): Promise<EndResult>
  endRunMarkPrOpen(runId: string, prUrl: string): Promise<EndResult>
  isEnrolledEnabled(userId: string, repoIdent: string): Promise<boolean>
  runContext(runId: string): Promise<RunContext | null>
  /** Live (not ended) runs for the user, excluding one run (the request's own). */
  liveRunsForUser(userId: string, excludeRunId: string): Promise<number>
  /** Today's four-bucket token total for the project's CORCH sessions, in the user's tz-day. */
  projectTokensToday(projectId: string, tz: string): Promise<number>
  /** Record the hosting supervisor once the governed launch succeeded (run stays `launching`). */
  markRunLaunched(runId: string, supervisorId: string): Promise<boolean>
  /** The turn was actually sent: status running, heartbeat now (no-op once the run ended). */
  markRunRunning(runId: string): Promise<boolean>
  /** Earliest not_before in the future over queued items of enabled projects, or null. */
  earliestFutureNotBefore(): Promise<Date | null>
  /** Users that currently have a queued item whose not_before has passed (or is unset). */
  usersWithDueItems(): Promise<string[]>
  /**
   * One page of live runs in stable id order: ids greater than `afterId` (null = from the start), at most
   * `limit`. The reconciler walks pages with a cursor so a run it can only mark `stalled` (heartbeat
   * unchanged) cannot monopolize every pass.
   */
  liveRunsPage(afterId: string | null, limit: number): Promise<LiveRun[]>
  /** Live runs hosted by one supervisor (socket-close reclaim). */
  liveRunsForSupervisor(supervisorId: string): Promise<LiveRun[]>
  /** Positive liveness: heartbeat now, and a stalled run is running again. */
  touchHeartbeat(runIds: string[]): Promise<void>
  /** Mark a live run stalled; true only when this call changed it (so the owner is told once). */
  markStalled(runId: string): Promise<boolean>
  /** CORCH-04: every ENABLED project of every user (the gsd-console ingest joins them to console slugs). */
  listEnabledProjects(): Promise<CorchProject[]>
  /**
   * CORCH-04: apply the derived gsd-console boards of ONE stream event in a single transaction (all or
   * nothing). Per entry: cancel QUEUED `gsd_console` items of that project whose source_ref is in `doneRefs`
   * (exact match; running, pr_open, done, blocked and already cancelled items are never touched), then upsert
   * the candidate (ON CONFLICT DO NOTHING on (user_id, source, source_ref)). Returns the user ids that have
   * a QUEUED candidate item after the call (new or already queued), so the caller re-evaluates them. An entry whose project is no longer enabled (re-checked inside the transaction under a
   * row lock that conflicts with updateProject) is skipped. `shouldCommit` is re-checked before each entry and
   * before the commit; false rolls everything back (throws).
   */
  applyGsdcBoards(entries: GsdcApplyEntry[], shouldCommit?: () => boolean): Promise<string[]>
}

export interface GsdcApplyEntry {
  projectId: string
  userId: string
  priority: number
  doneRefs: string[]
  candidate: { sourceRef: string; title: string; body: string } | null
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

  async setProvisionResult(projectId, r) {
    const rows = await sql<CorchProject[]>`
      UPDATE corch_projects SET aaf_provision_status = ${r.status}, aaf_project_id = ${r.aafProjectId}, updated_at = now()
      WHERE id = ${projectId} RETURNING *`
    return rows[0] ?? null
  },

  async listUnprovisionedProjects() {
    return sql<CorchProject[]>`
      SELECT * FROM corch_projects WHERE aaf_provision_status <> 'provisioned' ORDER BY created_at ASC, id ASC`
  },

  async applyAafEvent(e) {
    return sql.begin(async (tx): Promise<AafEventResult> => {
      // Dedupe first: a replayed event_id (unique) is a no-op with no second transition. A concurrent duplicate
      // blocks on the unique index until the first commits, then does nothing.
      const ins = await tx<{ id: string }[]>`
        INSERT INTO corch_events (event_id, event, repo, head_ref, pr_number)
        VALUES (${e.eventId}, ${e.event}, ${e.repo}, ${e.headRef}, ${e.prNumber})
        ON CONFLICT (event_id) DO NOTHING RETURNING id`
      if (ins.length === 0) return { kind: 'duplicate' }
      const rowId = ins[0]!.id
      const record = (outcome: string, userId: string | null, itemId: string | null, notify = false) =>
        tx`UPDATE corch_events SET outcome = ${outcome}, user_id = ${userId}, work_item_id = ${itemId},
             notify_state = ${notify ? 'pending' : 'none'} WHERE id = ${rowId}`

      const m = AAF_HEAD_REF_RE.exec(e.headRef)
      const found = m
        ? await tx<{ id: string }[]>`
            SELECT i.id
            FROM corch_work_items i JOIN corch_projects p ON p.id = i.project_id AND p.user_id = i.user_id
            WHERE i.id = ${m[1]!}::uuid AND i.branch = ${e.headRef} AND p.repo_ident = ${'github://' + e.repo.toLowerCase()}`
        : []
      if (found.length === 0) {
        await record('unknown_item', null, null)
        return { kind: 'unchanged', reason: 'unknown_item' }
      }
      // Lock order matches the run-end paths (run row, then item row), so a concurrent run end cannot deadlock us.
      await tx`SELECT id FROM corch_runs WHERE work_item_id = ${found[0]!.id} AND ended_at IS NULL FOR UPDATE`
      const locked = await tx<{ id: string; user_id: string; status: CorchWorkItem['status'] }[]>`
        SELECT id, user_id, status FROM corch_work_items WHERE id = ${found[0]!.id} FOR UPDATE`
      const item = locked[0]!
      // The item is closed out: any live run for it must stop. Ending the run row is what every dispatch gate and
      // the parked-turn replay check, so a turn parked offline can never be sent for a merged / closed / failed item.
      const endRuns = (reason: string) => tx`
        UPDATE corch_runs SET status = 'ended', end_reason = ${reason}, ended_at = now()
        WHERE work_item_id = ${item.id} AND ended_at IS NULL`
      if (item.status === 'done' || item.status === 'cancelled') {
        await record('terminal', item.user_id, item.id)
        return { kind: 'unchanged', reason: 'terminal' }
      }
      if (e.event === 'pr.merged') {
        await tx`
          UPDATE corch_work_items SET status = 'done', wait_reason = NULL, not_before = NULL, updated_at = now()
          WHERE id = ${item.id}`
        await endRuns('aaf_pr_merged')
        await record('done', item.user_id, item.id)
        return { kind: 'transitioned', userId: item.user_id, workItemId: item.id, to: 'done' }
      }
      if (item.status === 'blocked') {
        await record('already_blocked', item.user_id, item.id)
        return { kind: 'unchanged', reason: 'already_blocked' }
      }
      const reason = e.event === 'pr.failed' ? 'pr_failed' : 'pr_closed'
      await tx`
        UPDATE corch_work_items SET status = 'blocked', wait_reason = ${reason}, not_before = NULL, updated_at = now()
        WHERE id = ${item.id}`
      await endRuns(e.event === 'pr.failed' ? 'aaf_pr_failed' : 'aaf_pr_closed')
      await record('blocked', item.user_id, item.id, e.event === 'pr.failed')
      return { kind: 'transitioned', userId: item.user_id, workItemId: item.id, to: 'blocked' }
    })
  },

  async claimAafNotify(eventId) {
    const rows = await sql<{ user_id: string; work_item_id: string }[]>`
      UPDATE corch_events SET notify_state = 'sending', notify_claimed_at = now()
      WHERE event_id = ${eventId}
        AND user_id IS NOT NULL AND work_item_id IS NOT NULL
        AND (notify_state = 'pending'
             OR (notify_state = 'sending' AND notify_claimed_at < now() - interval '5 minutes'))
      RETURNING user_id, work_item_id`
    return rows[0] ? { userId: rows[0].user_id, workItemId: rows[0].work_item_id } : null
  },

  async finishAafNotify(eventId, delivered) {
    await sql`
      UPDATE corch_events SET notify_state = ${delivered ? 'sent' : 'pending'}, notify_claimed_at = NULL
      WHERE event_id = ${eventId} AND notify_state = 'sending'`
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
            AND p.aaf_provision_status = 'provisioned'
            AND NOT EXISTS (SELECT 1 FROM corch_runs r WHERE r.project_id = p.id AND r.ended_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM corch_work_items x WHERE x.project_id = p.id AND x.status = 'pr_open')
            AND i.id <> ALL(${excludeIds}::uuid[])
          ORDER BY p.priority DESC, i.priority DESC, i.created_at ASC, i.id ASC
          LIMIT 1
          FOR UPDATE OF i`
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
          WHERE id = ${itemId} AND status = 'running' RETURNING status, attempts`
      } else {
        const nb = i.notBefore
        const midnightTz = nb && 'midnightTz' in nb ? nb.midnightTz : null
        const plusSeconds = nb && 'plusSeconds' in nb ? nb.plusSeconds : null
        const at = nb && 'at' in nb ? nb.at : null // CORCH-02: an explicit instant (ISO)
        row = await tx`
          UPDATE corch_work_items SET
            status = 'queued',
            wait_reason = ${i.waitReason},
            not_before = CASE
              WHEN ${midnightTz}::text IS NOT NULL
                THEN (date_trunc('day', now() AT TIME ZONE ${midnightTz}::text) + interval '1 day') AT TIME ZONE ${midnightTz}::text
              WHEN ${plusSeconds}::double precision IS NOT NULL
                THEN now() + make_interval(secs => ${plusSeconds}::double precision)
              WHEN ${at}::timestamptz IS NOT NULL THEN ${at}::timestamptz
              ELSE NULL END,
            updated_at = now()
          WHERE id = ${itemId} AND status = 'running' RETURNING status, attempts`
      }
      // CORCH-08: an AAF closure event (done / blocked) may have moved the item while the run was live. The run
      // still ends, but the item is left exactly as the event set it (never requeued, never re-notified).
      if (row.length === 0) {
        const cur = await tx<{ status: CorchWorkItem['status']; attempts: number }[]>`
          SELECT status, attempts FROM corch_work_items WHERE id = ${itemId}`
        return {
          changed: true,
          workItemId: itemId,
          userId: ended[0]!.user_id,
          itemStatus: cur[0]!.status,
          attempts: cur[0]!.attempts,
          itemUntouched: true,
        }
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
        WHERE id = ${ended[0]!.work_item_id} AND status = 'running' RETURNING status, attempts`
      if (row.length === 0) {
        const cur = await tx<{ status: CorchWorkItem['status']; attempts: number }[]>`
          SELECT status, attempts FROM corch_work_items WHERE id = ${ended[0]!.work_item_id}`
        return {
          changed: true,
          workItemId: ended[0]!.work_item_id,
          userId: ended[0]!.user_id,
          itemStatus: cur[0]!.status,
          attempts: cur[0]!.attempts,
          itemUntouched: true,
        }
      }
      return { changed: true, workItemId: ended[0]!.work_item_id, userId: ended[0]!.user_id, itemStatus: row[0]!.status, attempts: row[0]!.attempts }
    })
  },

  async isEnrolledEnabled(userId, repoIdent) {
    const r = await sql`
      SELECT 1 FROM corch_projects WHERE user_id = ${userId} AND repo_ident = ${repoIdent} AND enabled = true`
    return r.length > 0
  },

  async runContext(runId) {
    const runs = await sql<CorchRun[]>`SELECT * FROM corch_runs WHERE id = ${runId}`
    const run = runs[0]
    if (!run) return null
    const items = await sql<CorchWorkItem[]>`SELECT * FROM corch_work_items WHERE id = ${run.work_item_id}`
    const projects = await sql<CorchProject[]>`SELECT * FROM corch_projects WHERE id = ${run.project_id}`
    const users = await sql<{ cap: number; tz: string }[]>`
      SELECT corch_max_concurrent_runs AS cap, COALESCE(timezone, 'UTC') AS tz FROM users WHERE id = ${run.user_id}`
    if (!items[0] || !projects[0] || !users[0]) return null
    return { run, item: items[0], project: projects[0], maxConcurrent: users[0].cap, tz: users[0].tz }
  },

  async liveRunsForUser(userId, excludeRunId) {
    const r = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM corch_runs
      WHERE user_id = ${userId} AND ended_at IS NULL AND id <> ${excludeRunId}`
    return r[0]!.n
  },

  async projectTokensToday(projectId, tz) {
    // Sessions that hosted a CORCH run of this project; IN (not JOIN) so a session reused across runs
    // is counted once. Same tz-day boundary and four buckets as getTodayTokenTotal.
    const r = await sql<{ sum: string | null }[]>`
      SELECT COALESCE(SUM(
        input_tokens + output_tokens + cache_creation_input_tokens + cache_read_input_tokens
      ), 0)::text AS sum
      FROM token_usage
      WHERE session_id IN (SELECT session_id FROM corch_runs WHERE project_id = ${projectId} AND session_id IS NOT NULL)
        AND created_at >= date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz}`
    return Number(r[0]?.sum ?? 0)
  },

  async markRunLaunched(runId, supervisorId) {
    const r = await sql`
      UPDATE corch_runs SET supervisor_id = ${supervisorId}, heartbeat_at = now()
      WHERE id = ${runId} AND ended_at IS NULL RETURNING id`
    return r.length > 0
  },

  async markRunRunning(runId) {
    const r = await sql`
      UPDATE corch_runs SET status = 'running', heartbeat_at = now()
      WHERE id = ${runId} AND ended_at IS NULL RETURNING id`
    return r.length > 0
  },

  async earliestFutureNotBefore() {
    const r = await sql<{ t: Date | null }[]>`
      SELECT min(i.not_before) AS t
      FROM corch_work_items i JOIN corch_projects p ON p.id = i.project_id
      WHERE i.status = 'queued' AND p.enabled = true AND p.aaf_provision_status = 'provisioned' AND i.not_before > now()`
    return r[0]?.t ?? null
  },

  async usersWithDueItems() {
    const r = await sql<{ user_id: string }[]>`
      SELECT DISTINCT i.user_id
      FROM corch_work_items i JOIN corch_projects p ON p.id = i.project_id
      WHERE i.status = 'queued' AND p.enabled = true AND p.aaf_provision_status = 'provisioned'
        AND (i.not_before IS NULL OR i.not_before <= now())`
    return r.map((x) => x.user_id)
  },

  async liveRunsPage(afterId, limit) {
    return sql<LiveRun[]>`
      SELECT r.*, p.repo_ident, i.attempts AS item_attempts
      FROM corch_runs r
      JOIN corch_projects p ON p.id = r.project_id
      JOIN corch_work_items i ON i.id = r.work_item_id
      WHERE r.ended_at IS NULL AND (${afterId}::uuid IS NULL OR r.id > ${afterId}::uuid)
      ORDER BY r.id ASC
      LIMIT ${limit}`
  },

  async liveRunsForSupervisor(supervisorId) {
    return sql<LiveRun[]>`
      SELECT r.*, p.repo_ident, i.attempts AS item_attempts
      FROM corch_runs r
      JOIN corch_projects p ON p.id = r.project_id
      JOIN corch_work_items i ON i.id = r.work_item_id
      WHERE r.ended_at IS NULL AND r.supervisor_id = ${supervisorId}`
  },

  async touchHeartbeat(runIds) {
    if (runIds.length === 0) return
    await sql`
      UPDATE corch_runs
      SET heartbeat_at = now(), status = CASE WHEN status = 'stalled' THEN 'running' ELSE status END
      WHERE id = ANY(${runIds}::uuid[]) AND ended_at IS NULL`
  },

  async markStalled(runId) {
    const r = await sql`
      UPDATE corch_runs SET status = 'stalled'
      WHERE id = ${runId} AND ended_at IS NULL AND status <> 'stalled' RETURNING id`
    return r.length > 0
  },

  async listEnabledProjects() {
    return sql<CorchProject[]>`
      SELECT * FROM corch_projects WHERE enabled = true ORDER BY user_id, repo_ident`
  },

  async applyGsdcBoards(entries, shouldCommit = () => true) {
    if (entries.length === 0) return []
    return sql.begin(async (tx) => {
      const created = new Set<string>()
      for (const e of entries) {
        if (!shouldCommit()) throw new Error('gsdc_apply_cancelled')
        const enrolled = await tx`
          SELECT 1 FROM corch_projects WHERE id = ${e.projectId} AND user_id = ${e.userId} AND enabled = true FOR SHARE`
        if (enrolled.length === 0) continue
        if (e.doneRefs.length > 0) {
          await tx`
            UPDATE corch_work_items
            SET status = 'cancelled', wait_reason = NULL, not_before = NULL, updated_at = now()
            WHERE project_id = ${e.projectId} AND source = 'gsd_console' AND status = 'queued'
              AND source_ref = ANY(${e.doneRefs}::text[])`
        }
        if (e.candidate) {
          const id = randomUUID()
          const r = await tx`
            INSERT INTO corch_work_items (id, user_id, project_id, source, source_ref, title, body, priority, branch)
            VALUES (${id}, ${e.userId}, ${e.projectId}, 'gsd_console', ${e.candidate.sourceRef}, ${e.candidate.title}, ${e.candidate.body}, ${e.priority}, ${corchBranch(id)})
            ON CONFLICT (user_id, source, source_ref) DO NOTHING
            RETURNING id`
          if (r.length > 0) created.add(e.userId)
          else {
            // Already known: still report the user when that item is waiting in the queue, so a lost evaluation
            // trigger (a reconnect after a mid-processing abort) is re-fired by the fresh snapshot.
            const known = await tx`
              SELECT 1 FROM corch_work_items
              WHERE user_id = ${e.userId} AND source = 'gsd_console' AND source_ref = ${e.candidate.sourceRef} AND status = 'queued'`
            if (known.length > 0) created.add(e.userId)
          }
        }
      }
      if (!shouldCommit()) throw new Error('gsdc_apply_cancelled')
      return [...created]
    })
  },
}

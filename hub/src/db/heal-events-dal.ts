/**
 * PTYCAP-07 heal-events DAL: the self-heal event ledger (heal_events).
 *
 * - claimHealEvent is ATOMIC: one transaction takes a tx-scoped advisory lock on
 *   (user, source, dedupe_key), checks the REAL elapsed window (a bucket boundary
 *   cannot split a storm - the flaw in claimDeployFailure's prev-bucket SELECT),
 *   enforces the per-user hourly claim cap, then INSERTs. The unique indexes in
 *   schema.sql are only the backstop. Any throw propagates: callers fail closed.
 * - claimHealNotification is a conditional UPDATE ... WHERE notification_claimed_at
 *   IS NULL RETURNING. It yields exactly ONE SEND ATTEMPT per event, not
 *   exactly-once delivery (a crash after the claim and before the send loses it).
 * - isHealGenerated is the recursion guard: it throws on DB error so callers fail
 *   closed.
 * - Retention is bounded-delete only and never below 24h.
 *
 * Every function takes a trailing executor (default: the shared sql client) so
 * unit tests can inject a fake - the automation-controls reserveInject precedent.
 * Window / cap / retention values are ARGUMENTS; this module never reads env.
 */
import { sql } from './postgres.ts'

/** postgres.js client or transaction (tagged template; the client also has .begin). */
export type HealExec = any

const HOUR_MS = 3_600_000
const MIN_RETENTION_HOURS = 24
const PRUNE_BATCH = 100
const STALE_BATCH = 50

export function windowBucket(nowMs: number, windowMs: number): number {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`heal window must be a positive finite number of ms, got ${windowMs}`)
  }
  return Math.floor(nowMs / windowMs)
}

export interface ClaimHealArgs {
  userId: string
  source: string
  dedupeKey: string
  repoIdent?: string | null
  triggerRunId?: string | null
  windowMs: number
  maxClaimsPerUserHour: number
  retentionHours: number
  /** Injectable clock (tests); defaults to Date.now(). */
  nowMs?: number
}

export type ClaimHealResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'duplicate' | 'user_claim_cap' }

export interface HealEventRow {
  id: string
  user_id: string
  source: string
  repo_ident: string | null
  dedupe_key: string
  window_bucket: string | number
  trigger_run_id: string | null
  dispatch_run_id: string | null
  metadata_run_id: string | null
  session_id: string | null
  outcome: string | null
  notification_claimed_at: string | Date | null
  created_at: string | Date
  updated_at: string | Date
}

/** Delete at most 100 rows older than max(retentionHours, 24h). Never younger than 24h. */
export async function pruneHealEvents(
  retentionHours: number,
  exec: HealExec = sql,
  nowMs: number = Date.now(),
): Promise<void> {
  const hours = Number.isFinite(retentionHours) ? Math.max(retentionHours, MIN_RETENTION_HOURS) : MIN_RETENTION_HOURS
  const cutoff = new Date(nowMs - hours * HOUR_MS)
  await exec`
    DELETE FROM heal_events WHERE id IN (
      SELECT id FROM heal_events WHERE created_at < ${cutoff} ORDER BY created_at LIMIT 100
    )
  `
}

export async function claimHealEvent(args: ClaimHealArgs, exec: HealExec = sql): Promise<ClaimHealResult> {
  const now = args.nowMs ?? Date.now()
  const bucket = windowBucket(now, args.windowMs) // throws RangeError on a bad window
  if (!Number.isFinite(args.maxClaimsPerUserHour) || args.maxClaimsPerUserHour <= 0) {
    throw new RangeError(`maxClaimsPerUserHour must be a positive finite number, got ${args.maxClaimsPerUserHour}`)
  }

  // Opportunistic bounded reap, outside the lock. A reap failure must not block a claim.
  try {
    await pruneHealEvents(args.retentionHours, exec, now)
  } catch (err: any) {
    console.warn(`[heal-events] opportunistic prune failed: ${err?.message ?? err}`)
  }

  const windowStart = new Date(now - args.windowMs)
  const hourStart = new Date(now - HOUR_MS)
  const createdAt = new Date(now)

  return exec.begin(async (tx: HealExec): Promise<ClaimHealResult> => {
    // (a) per-(user, source, key) lock FIRST, then (c) per-user lock: fixed order, no deadlock.
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtext(${'heal:' + args.userId + ':' + args.source + ':' + args.dedupeKey})::bigint
      )
    `
    if (args.triggerRunId) {
      const seen = await tx`
        SELECT 1 AS one FROM heal_events
        WHERE source = ${args.source} AND trigger_run_id = ${args.triggerRunId}
        LIMIT 1
      `
      if (seen.length > 0) return { ok: false, reason: 'duplicate' }
    }
    // (b) REAL elapsed window, not just the bucket.
    const inWindow = await tx`
      SELECT 1 AS one FROM heal_events
      WHERE user_id = ${args.userId} AND source = ${args.source} AND dedupe_key = ${args.dedupeKey}
        AND created_at > ${windowStart}
      LIMIT 1
    `
    if (inWindow.length > 0) return { ok: false, reason: 'duplicate' }

    await tx`SELECT pg_advisory_xact_lock(hashtext(${'heal-user:' + args.userId})::bigint)`
    const counted = await tx`
      SELECT count(*)::text AS n FROM heal_events
      WHERE user_id = ${args.userId} AND created_at > ${hourStart}
    `
    if (Number(counted[0]?.n ?? 0) >= args.maxClaimsPerUserHour) return { ok: false, reason: 'user_claim_cap' }

    // (d) INSERT; the unique indexes are the backstop - an empty return means duplicate.
    const inserted = await tx`
      INSERT INTO heal_events (user_id, source, repo_ident, dedupe_key, window_bucket, trigger_run_id, created_at, updated_at)
      VALUES (${args.userId}, ${args.source}, ${args.repoIdent ?? null}, ${args.dedupeKey}, ${bucket},
              ${args.triggerRunId ?? null}, ${createdAt}, ${createdAt})
      ON CONFLICT DO NOTHING
      RETURNING id
    `
    if (inserted.length === 0) return { ok: false, reason: 'duplicate' }
    return { ok: true, id: inserted[0].id as string }
  })
}

/** True exactly once per id: the caller that wins owns the single send attempt. */
export async function claimHealNotification(id: string, exec: HealExec = sql): Promise<boolean> {
  const rows = await exec`
    UPDATE heal_events SET notification_claimed_at = now(), updated_at = now()
    WHERE id = ${id} AND notification_claimed_at IS NULL
    RETURNING id
  `
  return rows.length > 0
}

export interface HealOutcomeExtra {
  dispatchRunId?: string | null
  metadataRunId?: string | null
  sessionId?: string | null
  repoIdent?: string | null
}

export async function setHealOutcome(
  id: string,
  outcome: string,
  extra: HealOutcomeExtra = {},
  exec: HealExec = sql,
): Promise<void> {
  await exec`
    UPDATE heal_events SET
      outcome = ${outcome},
      dispatch_run_id = COALESCE(${extra.dispatchRunId ?? null}, dispatch_run_id),
      metadata_run_id = COALESCE(${extra.metadataRunId ?? null}, metadata_run_id),
      session_id = COALESCE(${extra.sessionId ?? null}, session_id),
      repo_ident = COALESCE(${extra.repoIdent ?? null}, repo_ident),
      updated_at = now()
    WHERE id = ${id}
  `
}

export async function getHealEvent(id: string, exec: HealExec = sql): Promise<HealEventRow | null> {
  const rows = await exec`SELECT * FROM heal_events WHERE id = ${id} LIMIT 1`
  return (rows[0] as HealEventRow | undefined) ?? null
}

/**
 * True when the run, or any triggered_by_run_id ancestor (depth <= 5), appears as
 * trigger/dispatch/metadata run of a heal event. THROWS on DB error: fail closed.
 */
export async function isHealGenerated(runId: string, exec: HealExec = sql): Promise<boolean> {
  const rows = await exec`
    WITH RECURSIVE chain(id, depth) AS (
      SELECT ${runId}::text, 0
      UNION ALL
      SELECT r.triggered_by_run_id, c.depth + 1
      FROM chain c JOIN scheduled_task_runs r ON r.id = c.id
      WHERE r.triggered_by_run_id IS NOT NULL AND c.depth < 5
    )
    SELECT 1 AS one FROM heal_events h
    WHERE h.trigger_run_id IN (SELECT id FROM chain)
       OR h.dispatch_run_id IN (SELECT id FROM chain)
       OR h.metadata_run_id IN (SELECT id FROM chain)
    LIMIT 1
  `
  return rows.length > 0
}

export async function countRepoDispatchesLastHour(
  userId: string,
  repoIdent: string,
  exec: HealExec = sql,
  nowMs: number = Date.now(),
): Promise<number> {
  const since = new Date(nowMs - HOUR_MS)
  const rows = await exec`
    SELECT count(*)::text AS n FROM heal_events
    WHERE user_id = ${userId} AND repo_ident = ${repoIdent}
      AND outcome IN ('dispatched_live', 'autospawn_launched', 'autospawn_parked')
      AND created_at > ${since}
  `
  return Number(rows[0]?.n ?? 0)
}

export async function countTaskClaimsToday(
  userId: string,
  taskId: string,
  exec: HealExec = sql,
  nowMs: number = Date.now(),
): Promise<number> {
  const since = new Date(nowMs - 24 * HOUR_MS)
  const rows = await exec`
    SELECT count(*)::text AS n FROM heal_events
    WHERE user_id = ${userId} AND starts_with(dedupe_key, ${'task:' + taskId + ':'})
      AND created_at > ${since}
  `
  return Number(rows[0]?.n ?? 0)
}

export async function listStaleLaunchingHealEvents(
  olderThanMs: number,
  exec: HealExec = sql,
  nowMs: number = Date.now(),
): Promise<HealEventRow[]> {
  const cutoff = new Date(nowMs - olderThanMs)
  const rows = await exec`
    SELECT * FROM heal_events
    WHERE outcome = 'autospawn_launched' AND updated_at < ${cutoff}
    ORDER BY updated_at
    LIMIT 50
  `
  return rows as HealEventRow[]
}

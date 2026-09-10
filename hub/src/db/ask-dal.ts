/**
 * DAL for the external session-ask API (milestone ASK).
 *
 * - `verifyApiKeyForExt` resolves an api_key hash → {id, user_id, scopes}. The
 *   `scopes` column is NULLABLE and NULL means LEGACY FULL ACCESS, so existing
 *   keys keep working untouched.
 * - `session_asks` CRUD. `finalizeAsk` is CONDITIONAL (`AND status IN
 *   ('queued','dispatched')`) so a late reply can never overwrite a reaped row and
 *   the reaper can never overwrite a landed answer (same discipline as
 *   scheduler/run-reaper.ts + finalizeRun's `only_if_active`).
 */
import { sql } from './postgres.ts'

export interface ExtApiKey {
  id: string
  user_id: string
  scopes: string[] | null
}

export async function verifyApiKeyForExt(keyHash: string): Promise<ExtApiKey | null> {
  const rows = await sql<{ id: string; user_id: string; scopes: string[] | null }[]>`
    SELECT id, user_id::text AS user_id, scopes
      FROM api_keys
     WHERE key_hash = ${keyHash} AND revoked_at IS NULL
     LIMIT 1
  `
  const row = rows[0]
  if (!row) return null
  await sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`
  return { id: row.id, user_id: row.user_id, scopes: row.scopes ?? null }
}

// NOTE: the former `hasScope` here treated an empty array `[]` as "no access"
// (`[].includes(x)` ⇒ false), diverging from the canonical NULL-AND-empty-permissive
// `hasScope` in ../auth/scopes.ts. It had a single importer (ext-api-key-middleware),
// now switched to the canonical one, so it was DELETED to avoid two divergent copies.

export type AskStatus = 'queued' | 'dispatched' | 'answered' | 'timeout' | 'skipped' | 'failed'

export interface SessionAsk {
  id: string
  user_id: string
  session_id: string
  target_session_id: string | null
  api_key_id: string | null
  question: string
  status: AskStatus
  answer: string | null
  confidence: string | null
  evidence: string[] | null
  raw_reply: string | null
  reason: string | null
  created_at: Date
  answered_at: Date | null
}

export async function insertAsk(input: {
  userId: string
  sessionId: string
  targetSessionId: string | null
  apiKeyId: string | null
  question: string
}): Promise<SessionAsk> {
  const rows = await sql<SessionAsk[]>`
    INSERT INTO session_asks (user_id, session_id, target_session_id, api_key_id, question, status)
    VALUES (${input.userId}, ${input.sessionId}, ${input.targetSessionId},
            ${input.apiKeyId}, ${input.question}, 'queued')
    RETURNING *
  `
  return rows[0]
}

export async function getAsk(askId: string, userId: string): Promise<SessionAsk | null> {
  const rows = await sql<SessionAsk[]>`
    SELECT * FROM session_asks WHERE id = ${askId} AND user_id = ${userId} LIMIT 1
  `
  return rows[0] ?? null
}

export async function markAskDispatched(askId: string): Promise<void> {
  await sql`
    UPDATE session_asks SET status = 'dispatched'
     WHERE id = ${askId} AND status = 'queued'
  `
}

/**
 * Terminal write. CONDITIONAL on the row still being non-terminal, so a reaper /
 * late reply race resolves to exactly one winner. Returns true iff this call won.
 */
export async function finalizeAsk(
  askId: string,
  status: Extract<AskStatus, 'answered' | 'timeout' | 'skipped' | 'failed'>,
  patch: {
    answer?: string | null
    confidence?: string | null
    evidence?: string[] | null
    raw_reply?: string | null
    reason?: string | null
  } = {},
): Promise<boolean> {
  const rows = await sql<{ id: string }[]>`
    UPDATE session_asks
       SET status      = ${status},
           answer      = ${patch.answer ?? null},
           confidence  = ${patch.confidence ?? null},
           evidence    = ${patch.evidence ? JSON.stringify(patch.evidence) : null}::jsonb,
           raw_reply   = ${patch.raw_reply ?? null},
           reason      = ${patch.reason ?? null},
           answered_at = now()
     WHERE id = ${askId}
       AND status IN ('queued', 'dispatched')
     RETURNING id
  `
  return rows.length > 0
}

/** Asks still non-terminal, with their age in ms. Drives the reaper. */
export async function loadOpenAsks(): Promise<Array<{ id: string; created_at_ms: number }>> {
  const rows = await sql<{ id: string; created_at_ms: string }[]>`
    SELECT id, EXTRACT(EPOCH FROM created_at) * 1000 AS created_at_ms
      FROM session_asks
     WHERE status IN ('queued', 'dispatched')
  `
  return rows.map((r) => ({ id: r.id, created_at_ms: Number(r.created_at_ms) }))
}

/** Count this api_key's asks in the trailing `minutes` — drives `askRateGate`. */
export async function countAsksForKeySince(apiKeyId: string, minutes: number): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n
      FROM session_asks
     WHERE api_key_id = ${apiKeyId}
       AND created_at >= now() - (${minutes} || ' minutes')::interval
  `
  return Number(rows[0]?.n ?? 0)
}

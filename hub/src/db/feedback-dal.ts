/**
 * Feedback-intake DAL (Option A — end-user feedback → bound session).
 *
 * `feedback_keys` is the per-app submit credential. ONE key per app:
 *   { token_hash (PK), session_id, user_id, label, enabled, created_at }
 *
 * The submit token is opaque (`fb_` + 32 random bytes base64url) and is
 * returned in PLAINTEXT exactly ONCE at mint time — only its SHA-256 hash is
 * stored, mirroring the `remo_`/`mh_` session-token pattern in dal.ts. Resolve
 * hashes the presented token and looks the row up by hash; there is no way to
 * recover the plaintext from the DB.
 *
 * Schema (idempotent DDL) lives in schema.sql; this module never creates tables.
 */
import { sql } from './postgres.ts'
import { randomBytes, createHash } from 'crypto'

function hashFeedbackToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface FeedbackKeyRow {
  token_hash: string
  session_id: string
  user_id: string
  label: string | null
  enabled: boolean
  created_at: Date
}

/**
 * Mint a feedback key for `sessionId` owned by `userId`. Returns the plaintext
 * token ONCE — the caller must surface it immediately; it is unrecoverable
 * afterwards. Only the hash is persisted.
 */
export async function createFeedbackKey(
  sessionId: string,
  userId: string,
  label: string | null = null,
): Promise<{ token: string; token_hash: string }> {
  const token = 'fb_' + randomBytes(32).toString('base64url')
  const tokenHash = hashFeedbackToken(token)
  await sql`
    INSERT INTO feedback_keys (token_hash, session_id, user_id, label, enabled)
    VALUES (${tokenHash}, ${sessionId}, ${userId}, ${label}, true)
  `
  return { token, token_hash: tokenHash }
}

/**
 * Resolve a presented plaintext token → its key row. Hashes the token and does
 * a single indexed PK lookup (the hash compare IS constant-time at the
 * cryptographic level — an attacker never learns anything from timing because
 * the lookup key is a fixed-length digest, never the raw secret). Returns null
 * on miss. The caller decides 404-vs-401 and whether to honour `enabled`.
 */
export async function resolveFeedbackKey(token: string): Promise<FeedbackKeyRow | null> {
  if (!token || !token.startsWith('fb_')) return null
  const tokenHash = hashFeedbackToken(token)
  const rows = await sql<FeedbackKeyRow[]>`
    SELECT token_hash, session_id, user_id, label, enabled, created_at
      FROM feedback_keys
     WHERE token_hash = ${tokenHash}
     LIMIT 1
  `
  return rows[0] ?? null
}

/** List a user's feedback keys (NO plaintext — hashes only, for management UI). */
export async function listFeedbackKeys(userId: string): Promise<FeedbackKeyRow[]> {
  return await sql<FeedbackKeyRow[]>`
    SELECT token_hash, session_id, user_id, label, enabled, created_at
      FROM feedback_keys
     WHERE user_id = ${userId}
     ORDER BY created_at DESC
  `
}

/** Enable/disable a key (revoke without deleting). Scoped by user_id. */
export async function setFeedbackKeyEnabled(
  userId: string,
  tokenHash: string,
  enabled: boolean,
): Promise<boolean> {
  const rows = await sql`
    UPDATE feedback_keys SET enabled = ${enabled}
     WHERE user_id = ${userId} AND token_hash = ${tokenHash}
     RETURNING token_hash
  `
  return rows.length > 0
}

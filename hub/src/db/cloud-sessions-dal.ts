/**
 * Cloud sessions — a remo `sessions` row that fronts a claude.ai cloud session.
 * `sessions.cloud_session_id` non-NULL ⇒ the row is cloud-backed. See docs/cloud-sessions.md.
 */
import { sql } from './postgres.ts'

/** `cse_…` / `session_…` ids as accepted by `claude -p --cloud <id>`. */
export const CLOUD_SESSION_ID_RE = /^(cse|session)_[A-Za-z0-9_-]{1,128}$/

export function isCloudSessionId(id: unknown): id is string {
  return typeof id === 'string' && CLOUD_SESSION_ID_RE.test(id)
}

/**
 * Accept a bare id or a claude.ai/code URL (with or without scheme/query) and
 * return the bare id, or null when it doesn't parse.
 */
export function normalizeCloudSessionId(input: string): string | null {
  const s = input.trim()
  if (isCloudSessionId(s)) return s
  const m = s.match(/claude\.ai\/code\/((?:cse|session)_[A-Za-z0-9_-]{1,128})/)
  return m && isCloudSessionId(m[1]) ? m[1]! : null
}

export async function findSessionByCloudId(
  userId: string,
  cloudSessionId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM sessions
     WHERE user_id = ${userId} AND cloud_session_id = ${cloudSessionId} AND deleted_at IS NULL
     LIMIT 1
  `
  return rows[0] ?? null
}

/**
 * Find-or-create the remo session linked to a cloud session. Race-safe against
 * the partial unique index (user_id, cloud_session_id): a concurrent insert
 * loses with ON CONFLICT and we re-read the winner.
 */
export async function linkCloudSession(
  userId: string,
  cloudSessionId: string,
  name: string,
  tokenHash: string,
): Promise<{ id: string; name: string; created: boolean }> {
  const existing = await findSessionByCloudId(userId, cloudSessionId)
  if (existing) return { ...existing, created: false }
  const rows = await sql<{ id: string; name: string }[]>`
    INSERT INTO sessions (user_id, name, project_dir, token_hash, status, cloud_session_id)
    VALUES (${userId}, ${name}, NULL, ${tokenHash}, 'online', ${cloudSessionId})
    ON CONFLICT (user_id, cloud_session_id) WHERE cloud_session_id IS NOT NULL AND deleted_at IS NULL
    DO NOTHING
    RETURNING id, name
  `
  if (rows[0]) return { ...rows[0], created: true }
  const winner = await findSessionByCloudId(userId, cloudSessionId)
  if (!winner) throw new Error('cloud_session_link_failed')
  return { ...winner, created: false }
}

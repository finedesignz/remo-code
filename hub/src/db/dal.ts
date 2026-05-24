import { sql } from "./postgres.ts";

// ── Sessions ──────────────────────────────────────────────────────────────────

export async function listSessions(userId: string) {
  return sql`
    SELECT id, name, project_dir, status, token_hash, last_activity, created_at
    FROM sessions WHERE user_id = ${userId} AND deleted_at IS NULL
    ORDER BY last_activity DESC NULLS LAST
  `;
}

export async function getSession(sessionId: string, userId: string) {
  const rows = await sql`
    SELECT id, name, project_dir, status, token_hash, last_activity, created_at
    FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL
  `;
  return rows[0] ?? null;
}

export async function getSessionById(sessionId: string) {
  const rows = await sql`SELECT * FROM sessions WHERE id = ${sessionId} AND deleted_at IS NULL`;
  return rows[0] ?? null;
}

export async function findSessionByProjectDir(userId: string, projectDir: string) {
  const rows = await sql`
    SELECT * FROM sessions
    WHERE user_id = ${userId} AND project_dir = ${projectDir} AND deleted_at IS NULL
    ORDER BY last_activity DESC NULLS LAST LIMIT 1
  `;
  return rows[0] ?? null;
}

// Was there a session for this project_dir that the user disconnected in the
// last `withinSeconds` seconds? Used to reject stale agent reconnects after
// an explicit "Disconnect" click in the UI.
export async function recentlyDisconnectedForProjectDir(
  userId: string,
  projectDir: string,
  withinSeconds: number = 30,
) {
  const rows = await sql`
    SELECT id, deleted_at FROM sessions
    WHERE user_id = ${userId}
      AND project_dir = ${projectDir}
      AND deleted_at IS NOT NULL
      AND deleted_at > now() - (${withinSeconds} || ' seconds')::interval
    ORDER BY deleted_at DESC LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function createSession(userId: string, name: string, projectDir: string | null, tokenHash: string) {
  const rows = await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash)
    VALUES (${userId}, ${name}, ${projectDir}, ${tokenHash})
    RETURNING *
  `;
  return rows[0];
}

// Find existing session by project_dir (reuse) or create a new one.
// Returns { ...session, created: boolean }
export async function findOrCreateAgentSession(userId: string, projectDir: string, tokenHash: string) {
  const existing = await findSessionByProjectDir(userId, projectDir);
  if (existing) {
    // Update the token hash so the agent gets a fresh token
    await sql`UPDATE sessions SET token_hash = ${tokenHash}, last_activity = now() WHERE id = ${existing.id}`;
    return { ...existing, token_hash: tokenHash, created: false };
  }
  // Derive a human-readable name from the last path segment
  const name = projectDir.split('/').filter(Boolean).pop() ?? 'session';
  const rows = await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash)
    VALUES (${userId}, ${name}, ${projectDir}, ${tokenHash})
    RETURNING *
  `;
  return { ...rows[0], created: true };
}

// Create a session for a legacy channel/plugin connection
export async function createPluginSession(userId: string, projectDir: string, tokenHash: string) {
  const name = projectDir.split('/').filter(Boolean).pop() ?? 'session';
  const rows = await sql`
    INSERT INTO sessions (user_id, name, project_dir, token_hash)
    VALUES (${userId}, ${name}, ${projectDir}, ${tokenHash})
    RETURNING *
  `;
  return rows[0];
}

export async function updateSessionStatus(sessionId: string, status: string) {
  await sql`UPDATE sessions SET status = ${status}, last_activity = now() WHERE id = ${sessionId}`;
}

export async function updateSessionToken(sessionId: string, tokenHash: string) {
  await sql`UPDATE sessions SET token_hash = ${tokenHash} WHERE id = ${sessionId}`;
}

export async function deleteSession(sessionId: string, userId: string) {
  // Soft-delete so an agent process trying to reconnect after the user clicked
  // "Disconnect" cannot resurrect the row via findOrCreateAgentSession.
  await sql`UPDATE sessions SET deleted_at = now(), status = 'offline' WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL`;
}

export async function markSessionDisconnected(sessionId: string, userId: string) {
  await sql`UPDATE sessions SET deleted_at = now(), status = 'offline' WHERE id = ${sessionId} AND user_id = ${userId} AND deleted_at IS NULL`;
}

export async function setOfflineStaleAgentSessions() {
  await sql`UPDATE sessions SET status = 'offline' WHERE status = 'online'`;
}

// ── Messages ──────────────────────────────────────────────────────────────────

export async function listMessages(sessionId: string, userId: string) {
  return sql`
    SELECT m.id, m.session_id, m.role, m.content, m.status, m.created_at
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE m.session_id = ${sessionId} AND s.user_id = ${userId}
    ORDER BY m.created_at ASC
  `;
}

export async function insertMessage(sessionId: string, role: string, content: string) {
  const rows = await sql`
    INSERT INTO messages (session_id, role, content) VALUES (${sessionId}, ${role}, ${content}) RETURNING *
  `;
  return rows[0];
}

// Insert an empty assistant placeholder for incremental streaming. The row is
// created as soon as Claude starts a turn so the response survives a hub
// restart mid-stream.
export async function insertAssistantPlaceholder(sessionId: string) {
  const rows = await sql`
    INSERT INTO messages (session_id, role, content, status)
    VALUES (${sessionId}, 'assistant', '', 'streaming') RETURNING *
  `;
  return rows[0];
}

// Append a delta chunk to a streaming message. Called from a per-session
// throttled flush (~500ms / 1KB) so we don't hammer Postgres on every event.
export async function appendToMessage(messageId: string, delta: string) {
  await sql`
    UPDATE messages SET content = content || ${delta}
    WHERE id = ${messageId} AND status = 'streaming'
  `;
}

// Final overwrite at turn end — ensures the persisted content matches the
// fully assembled text from the agent (covers any deltas dropped during
// throttle flush or network blips) and flips status to 'complete'.
export async function finalizeMessage(messageId: string, content: string) {
  const rows = await sql`
    UPDATE messages SET content = ${content}, status = 'complete'
    WHERE id = ${messageId}
    RETURNING *
  `;
  return rows[0];
}

// Boot-time sweep: any messages still marked 'streaming' must have been left
// over by a previous hub process that died mid-turn. Mark them interrupted so
// the UI can show them with a distinct indicator.
export async function markStreamingMessagesAsInterrupted() {
  await sql`UPDATE messages SET status = 'interrupted' WHERE status = 'streaming'`;
}

// ── API Keys ──────────────────────────────────────────────────────────────────

export async function verifyApiKey(keyHash: string) {
  const rows = await sql`
    SELECT user_id FROM api_keys WHERE key_hash = ${keyHash} AND revoked_at IS NULL LIMIT 1
  `;
  if (!rows[0]) return null;
  await sql`UPDATE api_keys SET last_used_at = now() WHERE key_hash = ${keyHash} AND revoked_at IS NULL`;
  return rows[0].user_id as string;
}

export async function listApiKeys(userId: string) {
  return sql`
    SELECT id, name, created_at, last_used_at FROM api_keys
    WHERE user_id = ${userId} AND revoked_at IS NULL ORDER BY created_at DESC
  `;
}

export async function createApiKey(userId: string, keyHash: string, name: string) {
  await sql`UPDATE api_keys SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
  const rows = await sql`
    INSERT INTO api_keys (user_id, key_hash, name) VALUES (${userId}, ${keyHash}, ${name}) RETURNING *
  `;
  return rows[0];
}

export async function revokeApiKey(userId: string) {
  await sql`UPDATE api_keys SET revoked_at = now() WHERE user_id = ${userId} AND revoked_at IS NULL`;
}

// ── Users / Profiles ──────────────────────────────────────────────────────────

export async function getUserById(id: string) {
  const rows = await sql`SELECT id, email, display_name, role, system_prompt, created_at, updated_at FROM users WHERE id = ${id}`;
  return rows[0] ?? null;
}

export async function getUserSystemPrompt(id: string): Promise<string | null> {
  const rows = await sql`SELECT system_prompt FROM users WHERE id = ${id}`;
  return (rows[0]?.system_prompt as string | null) ?? null;
}

export async function getUserByEmail(email: string) {
  const rows = await sql`SELECT * FROM users WHERE email = ${email}`;
  return rows[0] ?? null;
}

export async function countUsers() {
  const rows = await sql`SELECT COUNT(*)::int AS count FROM users`;
  return rows[0].count as number;
}

export async function createUser(email: string, passwordHash: string, role: string = 'user') {
  const rows = await sql`
    INSERT INTO users (email, password_hash, role) VALUES (${email}, ${passwordHash}, ${role}) RETURNING id, email, display_name, role, created_at
  `;
  return rows[0];
}

export async function updateProfile(userId: string, fields: { display_name?: string; system_prompt?: string | null }) {
  // Build a partial update — only touch the columns provided.
  if (fields.display_name !== undefined && fields.system_prompt !== undefined) {
    const rows = await sql`
      UPDATE users SET display_name = ${fields.display_name}, system_prompt = ${fields.system_prompt}, updated_at = now()
      WHERE id = ${userId}
      RETURNING id, email, display_name, role, system_prompt
    `;
    return rows[0] ?? null;
  }
  if (fields.display_name !== undefined) {
    const rows = await sql`
      UPDATE users SET display_name = ${fields.display_name}, updated_at = now() WHERE id = ${userId}
      RETURNING id, email, display_name, role, system_prompt
    `;
    return rows[0] ?? null;
  }
  if (fields.system_prompt !== undefined) {
    const rows = await sql`
      UPDATE users SET system_prompt = ${fields.system_prompt}, updated_at = now() WHERE id = ${userId}
      RETURNING id, email, display_name, role, system_prompt
    `;
    return rows[0] ?? null;
  }
  // Nothing to update — return current row
  return getUserById(userId);
}

// ── Channel token ─────────────────────────────────────────────────────────────

export async function verifyChannelToken(sessionId: string) {
  const rows = await sql`SELECT token_hash, user_id FROM sessions WHERE id = ${sessionId}`;
  return rows[0] ?? null;
}

#!/usr/bin/env bun
/**
 * One-shot, idempotent: ensure an `error_projects` row exists for browser-side
 * web error capture (Bundle B3). Prints the project_id to stdout so the
 * caller can stash it in Coolify env as `VITE_WEB_ERROR_PROJECT_ID`.
 *
 * Owner: env `HUB_SELF_OWNER_USER_ID`, falling back to the known dev user
 * `233c6d63-5f44-43f4-9eae-efc34a00735a`.
 *
 * Reuses an existing `error_projects` row keyed by sentry_key='__web_self__'.
 * Errors that surface here are intentional — script aborts so CI/operator
 * sees them.
 */
import { Client } from 'pg'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}
const OWNER_ID = process.env.HUB_SELF_OWNER_USER_ID || '233c6d63-5f44-43f4-9eae-efc34a00735a'
const SENTRY_KEY = '__web_self__'
const PROJECT_NAME = 'Web (browser self-capture)'
const SESSION_NAME = '__web_self__ (B3 observability)'

// SSL only when the URL asks for it; Coolify internal Postgres serves plain TCP.
const wantSsl = /sslmode=require|sslmode=verify/.test(DATABASE_URL)
const c = new Client({ connectionString: DATABASE_URL, ssl: wantSsl ? { rejectUnauthorized: false } : false })
await c.connect()
try {
  await c.query('BEGIN')

  // Existing row? Reuse.
  const existing = await c.query<{ id: string }>(
    `SELECT id FROM error_projects WHERE sentry_key = $1`,
    [SENTRY_KEY],
  )
  if (existing.rows[0]) {
    await c.query('COMMIT')
    process.stdout.write(existing.rows[0].id + '\n')
    process.exit(0)
  }

  // Find-or-create a sentinel session for the FK on error_projects.session_id.
  // We use project_dir='__web_self__' as the keying convention so subsequent
  // runs find this row instead of allocating new ones.
  const sess = await c.query<{ id: string }>(
    `SELECT id FROM sessions WHERE user_id = $1 AND project_dir = $2 LIMIT 1`,
    [OWNER_ID, '__web_self__'],
  )
  let sessionId: string
  if (sess.rows[0]) {
    sessionId = sess.rows[0].id
  } else {
    // token_hash is required; this session never connects so a constant
    // sentinel is fine — never matched against a real API key.
    const ins = await c.query<{ id: string }>(
      `INSERT INTO sessions (user_id, name, project_dir, status, token_hash)
       VALUES ($1, $2, $3, 'offline', $4)
       RETURNING id`,
      [OWNER_ID, SESSION_NAME, '__web_self__', '__web_self__sentinel__'],
    )
    sessionId = ins.rows[0].id
  }

  const inserted = await c.query<{ id: string }>(
    `INSERT INTO error_projects (user_id, name, sentry_key, session_id, enabled)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (sentry_key) DO NOTHING
     RETURNING id`,
    [OWNER_ID, PROJECT_NAME, SENTRY_KEY, sessionId],
  )
  let id: string
  if (inserted.rows[0]) {
    id = inserted.rows[0].id
  } else {
    // Lost a race; re-read.
    const re = await c.query<{ id: string }>(`SELECT id FROM error_projects WHERE sentry_key = $1`, [SENTRY_KEY])
    id = re.rows[0].id
  }

  await c.query('COMMIT')
  process.stdout.write(id + '\n')
} catch (err) {
  await c.query('ROLLBACK').catch(() => {})
  console.error(err)
  process.exit(1)
} finally {
  await c.end()
}

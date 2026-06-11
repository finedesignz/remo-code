/**
 * Feedback-key session-ownership e2e (SECURITY BLOCKER-1).
 *
 * `createFeedbackKey` must NEVER bind a key to a session the minting user does
 * not own — otherwise a leaked submit token would inject feedback into another
 * user's live agent session (cross-user escalation).
 *
 * Gated on `REMO_E2E_DB_URL` (same convention as session-keying-dal.test.ts):
 * CI without a disposable Postgres skips cleanly. The DAL reads `sql` from
 * postgres.ts bound to DATABASE_URL at import, so we point DATABASE_URL at the
 * test DB BEFORE importing and seed two users.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import postgres from 'postgres'
import { randomUUID } from 'crypto'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

maybe('createFeedbackKey — session ownership (BLOCKER-1)', () => {
  let dal: typeof import('../src/db/feedback-dal')
  let sql: ReturnType<typeof postgres>
  let userA: string
  let userB: string
  let sessionB: string // owned by B

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL!
    dal = await import('../src/db/feedback-dal')
    sql = postgres(process.env.REMO_E2E_DB_URL!, { max: 4, idle_timeout: 5 })

    const mk = async () => {
      const email = `fb-owner-${randomUUID()}@invalid.local`
      const r = await sql<{ id: string }[]>`
        INSERT INTO users (email, password_hash, role)
        VALUES (${email}, 'x', 'user') RETURNING id`
      return r[0].id
    }
    userA = await mk()
    userB = await mk()

    const s = await sql<{ id: string }[]>`
      INSERT INTO sessions (user_id, name, token_hash)
      VALUES (${userB}, 'B session', ${'h_' + randomUUID()})
      RETURNING id`
    sessionB = s[0].id
  })

  afterAll(async () => {
    if (!sql) return
    await sql`DELETE FROM feedback_keys WHERE user_id IN (${userA}, ${userB})`
    await sql`DELETE FROM sessions WHERE user_id IN (${userA}, ${userB})`
    await sql`DELETE FROM users WHERE id IN (${userA}, ${userB})`
    await sql.end({ timeout: 5 })
  })

  test('user A CANNOT mint a key for user B\'s session', async () => {
    await expect(dal.createFeedbackKey(sessionB, userA)).rejects.toBeInstanceOf(
      dal.FeedbackSessionNotOwned,
    )
    const rows = await sql`SELECT 1 FROM feedback_keys WHERE session_id = ${sessionB}`
    expect(rows.length).toBe(0)
  })

  test('owner B CAN mint a key for their own session', async () => {
    const { token } = await dal.createFeedbackKey(sessionB, userB)
    expect(token.startsWith('fb_')).toBe(true)
  })

  test('unknown session id is rejected', async () => {
    await expect(
      dal.createFeedbackKey(randomUUID(), userA),
    ).rejects.toBeInstanceOf(dal.FeedbackSessionNotOwned)
  })
})

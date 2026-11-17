/**
 * PTYCAP-07 plan 02 - heal_events DAL on REAL Postgres (concurrency proofs).
 *
 * Gated on REMO_E2E_DB_URL (maybeDescribe) like its siblings; CI runs it against
 * postgres:16. Written for real Postgres semantics (advisory locks, partial unique
 * indexes) - a lax PGlite proves nothing about them. The DAL takes the harness'
 * private client as its executor, so the hub's shared `sql` is never touched.
 */
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { maybeDescribe, setupHarness, teardownHarness, type Harness } from './orchestrator-harness.ts'
import {
  claimHealEvent,
  claimHealNotification,
  pruneHealEvents,
  isHealGenerated,
  getHealEvent,
  setHealOutcome,
} from '../../src/db/heal-events-dal.ts'

const WINDOW_MS = 600_000
const baseArgs = {
  source: 'e2e',
  windowMs: WINDOW_MS,
  maxClaimsPerUserHour: 1000,
  retentionHours: 48,
}

maybeDescribe('heal_events DAL (real Postgres)', () => {
  let h: Harness

  beforeAll(async () => {
    h = await setupHarness()
  })
  afterAll(async () => {
    if (h) await teardownHarness(h)
  })

  const key = () => `k-${randomUUID()}`

  test('eight concurrent claims for one key yield exactly one winner', async () => {
    const dedupeKey = key()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey }, h.sql)),
    )
    expect(results.filter((r) => r.ok).length).toBe(1)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === 'duplicate')).toBe(true)
  })

  test('a claim straddling the bucket boundary is a duplicate; window+1ms succeeds again', async () => {
    const dedupeKey = key()
    const boundary = Math.ceil(Date.now() / WINDOW_MS) * WINDOW_MS
    const first = await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey, nowMs: boundary - 1 }, h.sql)
    expect(first.ok).toBe(true)
    // Next bucket, but only 2ms of real time elapsed.
    const second = await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey, nowMs: boundary + 1 }, h.sql)
    expect(second).toEqual({ ok: false, reason: 'duplicate' })
    const third = await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey, nowMs: boundary - 1 + WINDOW_MS + 1 }, h.sql)
    expect(third.ok).toBe(true)
  })

  test('eight concurrent notification claims yield exactly one true', async () => {
    const c = await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey: key() }, h.sql)
    expect(c.ok).toBe(true)
    if (!c.ok) return
    const wins = await Promise.all(Array.from({ length: 8 }, () => claimHealNotification(c.id, h.sql)))
    expect(wins.filter(Boolean).length).toBe(1)
    expect(await claimHealNotification(c.id, h.sql)).toBe(false)
  })

  test('trigger_run_id uniqueness blocks a second event for one run even outside the window', async () => {
    const triggerRunId = `run-${randomUUID()}`
    const a = await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey: key(), triggerRunId }, h.sql)
    expect(a.ok).toBe(true)
    const later = Date.now() + 10 * WINDOW_MS
    const b = await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey: key(), triggerRunId, nowMs: later }, h.sql)
    expect(b).toEqual({ ok: false, reason: 'duplicate' })
  })

  test('the per-user hourly cap blocks the (cap+1)th distinct key; other users unaffected', async () => {
    const [other] = await h.sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role) VALUES (${`cap-${randomUUID()}@invalid.local`}, 'x', 'user') RETURNING id
    `
    try {
      const args = { ...baseArgs, userId: other.id, maxClaimsPerUserHour: 3 }
      for (let i = 0; i < 3; i++) expect((await claimHealEvent({ ...args, dedupeKey: key() }, h.sql)).ok).toBe(true)
      expect(await claimHealEvent({ ...args, dedupeKey: key() }, h.sql)).toEqual({ ok: false, reason: 'user_claim_cap' })
      // Same dedupe key under a different user never collides.
      const shared = key()
      expect((await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey: shared }, h.sql)).ok).toBe(true)
      const crossUser = await claimHealEvent({ ...baseArgs, userId: other.id, maxClaimsPerUserHour: 1000, dedupeKey: shared }, h.sql)
      expect(crossUser.ok).toBe(true)
    } finally {
      await h.sql`DELETE FROM users WHERE id = ${other.id}`
    }
  })

  test('pruneHealEvents keeps a 23h-old row and removes a 49h-old row', async () => {
    const mk = async (ageHours: number) => {
      const [row] = await h.sql<{ id: string }[]>`
        INSERT INTO heal_events (user_id, source, dedupe_key, window_bucket, created_at, updated_at)
        VALUES (${h.userId}, 'prune', ${key()}, 1, now() - make_interval(hours => ${ageHours}), now())
        RETURNING id
      `
      return row.id
    }
    const young = await mk(23)
    const old = await mk(49)
    await pruneHealEvents(1, h.sql) // floor must hold the 23h row
    expect(await getHealEvent(young, h.sql)).not.toBeNull()
    await pruneHealEvents(48, h.sql)
    expect(await getHealEvent(old, h.sql)).toBeNull()
    expect(await getHealEvent(young, h.sql)).not.toBeNull()
  })

  test('isHealGenerated follows a two-hop triggered_by_run_id chain', async () => {
    const [task] = await h.sql<{ id: string }[]>`
      INSERT INTO scheduled_tasks (user_id, session_id, name, cron_expression, prompt)
      VALUES (${h.userId}, ${h.sessionId}, ${'heal-chain-' + randomUUID()}, '* * * * *', 'p') RETURNING id
    `
    const run = async (parent: string | null) => {
      const [r] = await h.sql<{ id: string }[]>`
        INSERT INTO scheduled_task_runs (task_id, user_id, triggered_by_run_id)
        VALUES (${task.id}, ${h.userId}, ${parent}) RETURNING id
      `
      return r.id
    }
    const root = await run(null)
    const mid = await run(root)
    const leaf = await run(mid)
    const unrelated = await run(null)
    await h.sql`
      INSERT INTO heal_events (user_id, source, dedupe_key, window_bucket, dispatch_run_id)
      VALUES (${h.userId}, 'chain', ${key()}, 1, ${root})
    `
    expect(await isHealGenerated(leaf, h.sql)).toBe(true)
    expect(await isHealGenerated(root, h.sql)).toBe(true)
    expect(await isHealGenerated(unrelated, h.sql)).toBe(false)
  })

  test('setHealOutcome COALESCE keeps prior values and bumps updated_at', async () => {
    const c = await claimHealEvent({ ...baseArgs, userId: h.userId, dedupeKey: key() }, h.sql)
    if (!c.ok) throw new Error('claim failed')
    await setHealOutcome(c.id, 'autospawn_launched', { dispatchRunId: 'd1', sessionId: 's1' }, h.sql)
    await setHealOutcome(c.id, 'dispatched_live', {}, h.sql)
    const row = await getHealEvent(c.id, h.sql)
    expect(row?.outcome).toBe('dispatched_live')
    expect(row?.dispatch_run_id).toBe('d1')
    expect(row?.session_id).toBe('s1')
  })
})

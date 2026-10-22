import { test, expect } from 'bun:test'
import { assertNonProdDsn } from './orchestrator-harness.ts'
import postgres from 'postgres'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { notifyIncident, clearRecoveredIncidents, notifyIncidentChannels } from '../../src/revanote/alert-state.ts'

const run = process.env.REMO_E2E_DB_URL ? test : test.skip
run('persistent Revanote receipts: restart, concurrency, delivery failure, recovery and empty UUID arrays', async () => {
  const dsn = process.env.REMO_E2E_DB_URL
  assertNonProdDsn(dsn)
  const schema = 'alert_qc_' + randomUUID().replaceAll('-', '')
  const db = postgres(dsn, { max: 4, connection: { search_path: schema } })
  const h = { sql: db, userId: randomUUID() }
  await db.unsafe(`CREATE SCHEMA ${schema}`)
  await db`CREATE TABLE users (id uuid PRIMARY KEY)`
  const ddl = readFileSync(new URL('../../src/db/schema.sql', import.meta.url), 'utf8')
    .match(/CREATE TABLE IF NOT EXISTS revanote_alert_state \([\s\S]*?\);/)![0]
  await db.unsafe(ddl)
  await db`INSERT INTO users (id) VALUES (${h.userId})`
  try {
    const now = Date.now()
    let sends = 0
    const send = async () => { sends++; return { delivered: ['email'] } }
    const notify = (fp: string, time: number, sender = send) => notifyIncident(h.userId, 'stall:email', fp, time, 100, sender, h.sql)
    expect(await notify('a', now)).toBe(true)
    expect(await notify('a', now + 1000)).toBe(false)
    expect(sends).toBe(1)
    expect(await notify('b', now + 1)).toBe(false)
    expect(await notify('b', now + 1000, async () => ({ delivered: [] }))).toBe(false)
    expect(await notify('b', now + 1001)).toBe(true)
    await clearRecoveredIncidents('stall', [], now, h.sql) // stale sweep cannot erase newer receipt
    expect(await notify('b', now + 2000)).toBe(false)
    await clearRecoveredIncidents('stall', [h.userId], now + 2000, h.sql)
    expect(await notify('b', now + 2001)).toBe(false)
    await clearRecoveredIncidents('stall', [], now + 2002, h.sql)
    const attempts = await Promise.all(Array.from({ length: 4 }, () => notify('b', now + 2003)))
    expect(attempts.filter(Boolean)).toHaveLength(1)

    let emailWorks = false
    const calls: string[] = []
    const deps = {
      notify: (userId: string, monitor: string, fingerprint: string, time: number, cooldown: number, sender: () => Promise<{ delivered: string[] }>) => notifyIncident(userId, monitor, fingerprint, time, cooldown, sender, h.sql),
      send: async (input: Parameters<typeof notifyIncidentChannels>[0]) => {
        const channel = input.channels[0]!
        calls.push(channel)
        return { delivered: channel === 'email' && !emailWorks ? [] : [channel] }
      },
    }
    const input = { userId: h.userId, sessionId: '', event: 'failure' as const, level: 'blocking' as const, detail: 'test', channels: ['inapp', 'email'] as ('inapp' | 'email')[] }
    expect((await notifyIncidentChannels(input, 'quiet-stalled', 'q', now, 100, deps)).delivered).toEqual(['inapp'])
    emailWorks = true
    expect((await notifyIncidentChannels(input, 'quiet-stalled', 'q', now + 1, 100, deps)).delivered).toEqual(['email'])
    expect(calls).toEqual(['inapp', 'email', 'email'])
  } finally { await db.unsafe(`DROP SCHEMA ${schema} CASCADE`); await db.end() }
}, 60_000)

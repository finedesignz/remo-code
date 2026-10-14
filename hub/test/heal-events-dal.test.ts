/**
 * PTYCAP-07 plan 02 task 2 - heal-events DAL, DB-free unit tests (injected fake
 * executor + source-text pins). The concurrency proofs live in
 * hub/test/e2e/heal-events.e2e.test.ts against real Postgres.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  windowBucket,
  claimHealEvent,
  claimHealNotification,
  setHealOutcome,
  getHealEvent,
  isHealGenerated,
  countTaskClaimsToday,
  pruneHealEvents,
  listStaleLaunchingHealEvents,
} from '../src/db/heal-events-dal.ts'

type Call = { text: string; values: unknown[] }

/** Fake postgres.js executor: tagged template + .begin(). Responder maps a query to rows. */
function fake(responder: (text: string, values: unknown[]) => unknown[] = () => []) {
  const calls: Call[] = []
  const tag = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?')
    calls.push({ text, values })
    return Promise.resolve(responder(text, values))
  }
  const exec: any = Object.assign((s: TemplateStringsArray, ...v: unknown[]) => tag(s, ...v), {
    begin: async (fn: (tx: any) => Promise<unknown>) => fn(exec.__tx),
  })
  exec.__tx = (s: TemplateStringsArray, ...v: unknown[]) => tag(s, ...v)
  return { exec, calls }
}

const base = {
  userId: '11111111-1111-1111-1111-111111111111',
  source: 'coolify',
  dedupeKey: 'app:abc',
  windowMs: 600_000,
  maxClaimsPerUserHour: 5,
  retentionHours: 48,
}

describe('windowBucket', () => {
  test('floor(now / window)', () => {
    expect(windowBucket(1_000_000, 600_000)).toBe(1)
    expect(windowBucket(599_999, 600_000)).toBe(0)
    expect(windowBucket(600_000, 600_000)).toBe(1)
  })
  test('non-positive or non-finite window throws RangeError', () => {
    expect(() => windowBucket(1, 0)).toThrow(RangeError)
    expect(() => windowBucket(1, -5)).toThrow(RangeError)
    expect(() => windowBucket(1, Number.NaN)).toThrow(RangeError)
    expect(() => windowBucket(1, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('claimHealEvent (fake executor)', () => {
  test('ok with new id when nothing blocks', async () => {
    const { exec } = fake((text) => {
      if (/INSERT INTO heal_events/.test(text)) return [{ id: 'new-id' }]
      if (/count\(\*\)/i.test(text)) return [{ n: '0' }]
      return []
    })
    const r = await claimHealEvent({ ...base, nowMs: 1_000_000 }, exec)
    expect(r).toEqual({ ok: true, id: 'new-id' })
  })

  test('duplicate when the window already holds a row for the key', async () => {
    const { exec, calls } = fake((text) => (/FROM heal_events/.test(text) && /dedupe_key/.test(text) && /created_at >/.test(text) ? [{ one: 1 }] : []))
    const r = await claimHealEvent({ ...base, nowMs: 1_000_000 }, exec)
    expect(r).toEqual({ ok: false, reason: 'duplicate' })
    expect(calls.some((c) => /INSERT INTO heal_events/.test(c.text))).toBe(false)
  })

  test('duplicate when trigger_run_id already recorded', async () => {
    const { exec } = fake((text) => (/trigger_run_id/.test(text) && /SELECT/.test(text) && !/INSERT/.test(text) ? [{ one: 1 }] : []))
    const r = await claimHealEvent({ ...base, triggerRunId: 'run-1', nowMs: 1_000_000 }, exec)
    expect(r).toEqual({ ok: false, reason: 'duplicate' })
  })

  test('user_claim_cap at the hourly cap', async () => {
    const { exec } = fake((text) => (/count\(\*\)/i.test(text) ? [{ n: '5' }] : []))
    const r = await claimHealEvent({ ...base, nowMs: 1_000_000 }, exec)
    expect(r).toEqual({ ok: false, reason: 'user_claim_cap' })
  })

  test('empty INSERT return (unique-index backstop) maps to duplicate', async () => {
    const { exec } = fake((text) => (/count\(\*\)/i.test(text) ? [{ n: '0' }] : []))
    const r = await claimHealEvent({ ...base, nowMs: 1_000_000 }, exec)
    expect(r).toEqual({ ok: false, reason: 'duplicate' })
  })

  test('propagates a DB error (fail closed)', async () => {
    const exec: any = Object.assign(() => Promise.resolve([]), {
      begin: async () => {
        throw new Error('db down')
      },
    })
    await expect(claimHealEvent({ ...base, nowMs: 1_000_000 }, exec)).rejects.toThrow('db down')
  })

  test('invalid window / cap throws instead of claiming', async () => {
    const { exec } = fake()
    await expect(claimHealEvent({ ...base, windowMs: 0 }, exec)).rejects.toThrow(RangeError)
    await expect(claimHealEvent({ ...base, maxClaimsPerUserHour: 0 }, exec)).rejects.toThrow(RangeError)
  })
})

describe('source pins', () => {
  const src = readFileSync(resolve(import.meta.dir, '../src/db/heal-events-dal.ts'), 'utf-8')
  test('advisory lock precedes INSERT, inside a begin transaction', () => {
    const lock = src.indexOf('pg_advisory_xact_lock')
    const ins = src.indexOf('INSERT INTO heal_events')
    expect(lock).toBeGreaterThan(-1)
    expect(ins).toBeGreaterThan(lock)
    expect(src.slice(0, ins)).toMatch(/\.begin\(/)
  })
  test('notification ownership is a conditional UPDATE', () => {
    expect(src).toContain('notification_claimed_at IS NULL')
  })
  test('claimDeployFailure / coolify idempotency untouched', () => {
    expect(src).not.toContain('coolify_deploy_idempotency')
  })
})

describe('claimHealNotification', () => {
  test('true when the conditional UPDATE returns a row, false otherwise', async () => {
    expect(await claimHealNotification('x', fake(() => [{ id: 'x' }]).exec)).toBe(true)
    expect(await claimHealNotification('x', fake(() => []).exec)).toBe(false)
  })
})

describe('setHealOutcome / getHealEvent', () => {
  test('setHealOutcome bumps updated_at and passes optional columns', async () => {
    const { exec, calls } = fake()
    await setHealOutcome('id1', 'dispatched_live', { dispatchRunId: 'r2', sessionId: 's1', repoIdent: 'github://o/r' }, exec)
    expect(calls[0].text).toMatch(/UPDATE heal_events/)
    expect(calls[0].text).toMatch(/updated_at = now\(\)/)
    expect(calls[0].values).toContain('dispatched_live')
    expect(calls[0].values).toContain('r2')
  })
  test('getHealEvent returns first row or null', async () => {
    expect(await getHealEvent('a', fake(() => [{ id: 'a' }]).exec)).toEqual({ id: 'a' } as any)
    expect(await getHealEvent('a', fake(() => []).exec)).toBeNull()
  })
})

describe('isHealGenerated', () => {
  test('recursive CTE, depth limited to 5, true on match', async () => {
    const { exec, calls } = fake(() => [{ one: 1 }])
    expect(await isHealGenerated('run-9', exec)).toBe(true)
    expect(calls[0].text).toMatch(/WITH RECURSIVE/i)
    expect(calls[0].text).toMatch(/triggered_by_run_id/)
    expect(calls[0].text).toMatch(/depth < 5/)
    for (const col of ['trigger_run_id', 'dispatch_run_id', 'metadata_run_id']) expect(calls[0].text).toContain(col)
  })
  test('false when nothing matches; rethrows on DB error', async () => {
    expect(await isHealGenerated('run-9', fake(() => []).exec)).toBe(false)
    const bad: any = () => Promise.reject(new Error('boom'))
    await expect(isHealGenerated('run-9', bad)).rejects.toThrow('boom')
  })
})

describe('counts', () => {
  test('countTaskClaimsToday uses the task: prefix', async () => {
    const { exec, calls } = fake(() => [{ n: '2' }])
    expect(await countTaskClaimsToday('u', 't1', exec, 10_000_000)).toBe(2)
    expect(calls[0].values).toContain('task:t1:')
  })
})

describe('pruneHealEvents', () => {
  const NOW = 1_000_000_000_000
  const cutoffOf = (calls: Call[]) => (calls[0].values.find((v) => v instanceof Date) as Date).getTime()
  test('never prunes below 24h even when called with 1', async () => {
    const { exec, calls } = fake()
    await pruneHealEvents(1, exec, NOW)
    expect(cutoffOf(calls)).toBe(NOW - 24 * 3_600_000)
  })
  test('honours a larger retention and bounds the delete', async () => {
    const { exec, calls } = fake()
    await pruneHealEvents(48, exec, NOW)
    expect(cutoffOf(calls)).toBe(NOW - 48 * 3_600_000)
    expect(calls[0].text).toMatch(/DELETE FROM heal_events WHERE id IN \(\s*SELECT id FROM heal_events WHERE created_at </)
    expect(calls[0].text).toMatch(/LIMIT 100/)
  })
  test('non-finite retention falls back to the 24h floor', async () => {
    const { exec, calls } = fake()
    await pruneHealEvents(Number.NaN, exec, NOW)
    expect(cutoffOf(calls)).toBe(NOW - 24 * 3_600_000)
  })
})

describe('listStaleLaunchingHealEvents', () => {
  test('selects stranded autospawn rows (starting, launched, parked) older than the cutoff, limit 50', async () => {
    const { exec, calls } = fake(() => [{ id: 'a' }])
    const rows = await listStaleLaunchingHealEvents(60_000, exec, 10_000_000)
    expect(rows).toHaveLength(1)
    expect(calls[0].text).toContain("outcome IN ('autospawn_starting', 'autospawn_launched', 'autospawn_parked')")
    expect(calls[0].text).toMatch(/LIMIT 50/)
  })
})

// ---------------------------------------------------------------------------
// QC r1 (codex #8): per-repo / per-task ceilings are atomic with the INSERT. The fake models the
// two Postgres behaviours the proof rests on: pg_advisory_xact_lock serializes transactions that
// take the same key until commit, and COUNT sees only committed rows.
// ---------------------------------------------------------------------------
type Row = { id: string; user_id: string; repo_ident: string | null; dedupe_key: string; outcome: string | null; created_at: Date }

function statefulDb() {
  const rows: Row[] = []
  const held = new Map<string, Promise<void>>()
  let seq = 0
  const begin = async (fn: (tx: any) => Promise<unknown>) => {
    const releases: Array<() => void> = []
    const pending: Row[] = []
    const tx: any = async (s: TemplateStringsArray, ...v: unknown[]) => {
      const text = s.join('?')
      if (/pg_advisory_xact_lock/.test(text)) {
        const key = String(v[0])
        while (held.has(key)) await held.get(key)
        let done!: () => void
        held.set(key, new Promise<void>((r) => (done = r)))
        releases.push(() => {
          held.delete(key)
          done()
        })
        return []
      }
      await Promise.resolve() // a yield point: interleaving is possible between statements
      if (/INSERT INTO heal_events/.test(text)) {
        const row: Row = {
          id: `ev${++seq}`,
          user_id: v[0] as string,
          repo_ident: v[2] as string | null,
          dedupe_key: v[3] as string,
          outcome: v[6] as string | null,
          created_at: v[9] as Date,
        }
        pending.push(row)
        return [{ id: row.id }]
      }
      if (/starts_with\(dedupe_key/.test(text)) {
        const prefix = v[1] as string
        return [{ n: String(rows.filter((r) => r.user_id === v[0] && r.dedupe_key.startsWith(prefix)).length) }]
      }
      if (/repo_ident = \?/.test(text) && /count\(\*\)/.test(text)) {
        const counted = ['dispatched_live', 'dispatched_after_spawn', 'autospawn_starting', 'autospawn_launched', 'autospawn_parked']
        return [
          { n: String(rows.filter((r) => r.user_id === v[0] && r.repo_ident === v[1] && (r.outcome === null || counted.includes(r.outcome))).length) },
        ]
      }
      if (/count\(\*\)/.test(text)) return [{ n: String(rows.filter((r) => r.user_id === v[0]).length) }]
      return []
    }
    try {
      return await fn(tx)
    } finally {
      rows.push(...pending) // commit, then release the locks
      releases.forEach((r) => r())
    }
  }
  return { rows, exec: Object.assign(async () => [], { begin }) as any }
}

describe('claimHealEvent atomic ceilings (concurrent, distinct dedupe keys)', () => {
  const REPO = 'github://o/r'
  const user = '11111111-1111-1111-1111-111111111111'

  test('per-repo hourly ceiling: 8 concurrent distinct-key claims admit exactly the ceiling, the rest are repoRateBound', async () => {
    const db = statefulDb()
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        claimHealEvent(
          { ...base, userId: user, source: 'coolify_deploy', dedupeKey: `coolify:d${i}`, repoIdent: REPO, maxClaimsPerUserHour: 100, maxPerRepoHour: 3, nowMs: 5_000_000 },
          db.exec,
        ),
      ),
    )
    const ok = results.filter((r) => r.ok) as Array<{ ok: true; id: string; repoRateBound?: true }>
    expect(ok.length).toBe(8) // every claim records a row...
    expect(ok.filter((r) => !r.repoRateBound).length).toBe(3) // ...but only the ceiling is admitted
    expect(ok.filter((r) => r.repoRateBound).length).toBe(5)
    expect(db.rows.filter((r) => r.outcome === 'refused:repo_rate_bound').length).toBe(5)
  })

  test('per-repo ceiling counts in-flight (NULL outcome) rows and ignores refused rows of another repo', async () => {
    const db = statefulDb()
    const mk = (i: number, repo: string) =>
      claimHealEvent(
        { ...base, userId: user, source: 'coolify_deploy', dedupeKey: `coolify:x${i}`, repoIdent: repo, maxClaimsPerUserHour: 100, maxPerRepoHour: 1, nowMs: 5_000_000 },
        db.exec,
      )
    expect(await mk(1, REPO)).toMatchObject({ ok: true })
    expect((await mk(2, REPO)) as any).toMatchObject({ ok: true, repoRateBound: true })
    expect(((await mk(3, 'github://o/other')) as any).repoRateBound).toBeUndefined()
  })

  test('per-task daily ceiling: 6 concurrent distinct-signature claims for one task admit exactly the ceiling', async () => {
    const db = statefulDb()
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        claimHealEvent(
          { ...base, userId: user, source: 'scheduled_task', dedupeKey: `task:t1:sig${i}`, repoIdent: REPO, maxClaimsPerUserHour: 100, maxPerTaskDay: 3, nowMs: 5_000_000 },
          db.exec,
        ),
      ),
    )
    expect(results.filter((r) => r.ok).length).toBe(3)
    expect(results.filter((r) => !r.ok && (r as any).reason === 'task_day_cap').length).toBe(3)
    expect(db.rows.length).toBe(3)
  })

  test('recoveryCtx is persisted on the claim row (JSON text, jsonb cast)', async () => {
    const calls: Array<{ text: string; values: unknown[] }> = []
    const { exec } = fake((text, values) => {
      if (/INSERT INTO heal_events/.test(text)) {
        calls.push({ text, values })
        return [{ id: 'new' }]
      }
      return /count\(\*\)/.test(text) ? [{ n: '0' }] : []
    })
    await claimHealEvent({ ...base, recoveryCtx: { error_id: 'e1', project_id: 'p1' }, nowMs: 1_000_000 }, exec)
    expect(calls[0]!.text).toContain('recovery_ctx')
    expect(calls[0]!.values).toContain(JSON.stringify({ error_id: 'e1', project_id: 'p1' }))
  })
})

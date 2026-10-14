/**
 * PTYCAP-04-05 Task 3 (F-7): recordTokenUsage's listener slot. DB-free, same fake-sql
 * shape as the existing DAL tests; the fake records every statement so we can prove
 * the listener adds NO statement and fires only after the daily upsert.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, mock, afterAll, beforeEach } from 'bun:test'

const statements: string[] = []
function fakeSql(strings: TemplateStringsArray, ..._values: any[]) {
  const text = strings.join('?')
  if (text.includes('INSERT INTO token_usage ') && text.includes('RETURNING id')) {
    statements.push('ledger')
    return Promise.resolve([{ id: 'tu_1' }])
  }
  if (text.includes('INSERT INTO token_usage_daily')) {
    statements.push('daily')
    return Promise.resolve([])
  }
  statements.push('other')
  return Promise.resolve([])
}
mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))

const { recordTokenUsage, setTokenUsageListener } = await import('../src/db/token-usage-dal.ts')

afterAll(() => {
  setTokenUsageListener(null)
  mock.restore()
})

const usage = {
  userId: 'u1',
  sessionId: 's1',
  model: 'm',
  inputTokens: 1,
  outputTokens: 2,
  cacheCreationInputTokens: 3,
  cacheReadInputTokens: 4,
  costUsd: 0,
  costSource: 'sdk' as const,
}

beforeEach(() => {
  statements.length = 0
  setTokenUsageListener(null)
})

describe('recordTokenUsage listener slot', () => {
  test('no listener: exactly the two existing statements', async () => {
    const r = await recordTokenUsage(usage)
    expect(r.id).toBe('tu_1')
    expect(statements).toEqual(['ledger', 'daily'])
  })

  test('listener is invoked once, AFTER the daily upsert, with the usage input', async () => {
    const seen: { u: any; at: string[] }[] = []
    setTokenUsageListener((u) => {
      seen.push({ u, at: [...statements] })
    })
    await recordTokenUsage(usage)
    expect(seen.length).toBe(1)
    expect(seen[0]!.u).toEqual(usage)
    expect(seen[0]!.at).toEqual(['ledger', 'daily'])
    expect(statements).toEqual(['ledger', 'daily']) // still no extra SQL
  })

  test('a throwing or rejecting listener does not change the returned id', async () => {
    setTokenUsageListener(() => {
      throw new Error('boom')
    })
    expect((await recordTokenUsage(usage)).id).toBe('tu_1')
    setTokenUsageListener(async () => {
      throw new Error('async boom')
    })
    expect((await recordTokenUsage(usage)).id).toBe('tu_1')
    await new Promise((r) => setTimeout(r, 5)) // let the swallowed rejection settle: must not surface
  })

  test('setTokenUsageListener(null) clears it', async () => {
    let n = 0
    setTokenUsageListener(() => {
      n++
    })
    await recordTokenUsage(usage)
    setTokenUsageListener(null)
    await recordTokenUsage(usage)
    expect(n).toBe(1)
  })

  test('the listener is not awaited (a never-resolving listener does not block)', async () => {
    setTokenUsageListener(() => new Promise(() => {}))
    const r = await Promise.race([recordTokenUsage(usage), new Promise((res) => setTimeout(() => res('timeout'), 500))])
    expect((r as any).id).toBe('tu_1')
  })
})

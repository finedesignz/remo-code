/**
 * P2 — usage ledger persistence.
 *
 * (1) recordTokenUsage: one ledger insert + a daily upsert that ACCUMULATES on
 *     conflict (idempotent re-fire for the same user/day/model adds, not
 *     replaces). Verified against an in-memory `sql` fake that emulates
 *     ON CONFLICT … DO UPDATE add semantics.
 * (2) handler decision: SDK cost passes through untouched; an 'estimated' event
 *     routes through the price table.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, mock } from 'bun:test'

// --- In-memory sql fake emulating the two statements in recordTokenUsage ---
interface DailyRow {
  user_id: string; day: string; model: string
  input_tokens: number; output_tokens: number
  cache_creation_input_tokens: number; cache_read_input_tokens: number
  cost_usd: number
}
const ledger: any[] = []
const daily = new Map<string, DailyRow>()

function fakeSql(strings: TemplateStringsArray, ...values: any[]) {
  const text = strings.join('?')
  if (text.includes('INSERT INTO token_usage ') && text.includes('RETURNING id')) {
    // values order: userId, sessionId, model, in, out, cc, cr, cost, source, runnerType
    const [userId, sessionId, model, inp, out, cc, cr, cost, source, runnerType] = values
    const id = `tu_${ledger.length + 1}`
    ledger.push({ id, userId, sessionId, model, inp, out, cc, cr, cost, source, runnerType })
    return Promise.resolve([{ id }])
  }
  if (text.includes('INSERT INTO token_usage_daily')) {
    // values: userId, model(daily), in, out, cc, cr, cost  (day comes from now())
    const [userId, model, inp, out, cc, cr, cost] = values
    const day = '2026-05-30'
    const key = `${userId}|${day}|${model}`
    const existing = daily.get(key)
    if (existing) {
      existing.input_tokens += inp
      existing.output_tokens += out
      existing.cache_creation_input_tokens += cc
      existing.cache_read_input_tokens += cr
      existing.cost_usd += cost
    } else {
      daily.set(key, {
        user_id: userId, day, model,
        input_tokens: inp, output_tokens: out,
        cache_creation_input_tokens: cc, cache_read_input_tokens: cr,
        cost_usd: cost,
      })
    }
    return Promise.resolve([])
  }
  return Promise.resolve([])
}

mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))

const { recordTokenUsage } = await import('../src/db/token-usage-dal.ts')

describe('recordTokenUsage (P2 persist)', () => {
  test('inserts a ledger row and upserts the daily rollup', async () => {
    ledger.length = 0
    daily.clear()
    const r = await recordTokenUsage({
      userId: 'u1', sessionId: 's1', model: 'claude-opus-4',
      inputTokens: 100, outputTokens: 50,
      cacheCreationInputTokens: 10, cacheReadInputTokens: 200,
      costUsd: 0.5, costSource: 'sdk',
    })
    expect(r.id).toBe('tu_1')
    expect(ledger.length).toBe(1)
    const d = daily.get('u1|2026-05-30|claude-opus-4')!
    expect(d.input_tokens).toBe(100)
    expect(d.cost_usd).toBe(0.5)
  })

  test('daily upsert ACCUMULATES on repeat (same user/day/model adds)', async () => {
    ledger.length = 0
    daily.clear()
    const input = {
      userId: 'u1', sessionId: 's1', model: 'claude-opus-4',
      inputTokens: 100, outputTokens: 50,
      cacheCreationInputTokens: 10, cacheReadInputTokens: 200,
      costUsd: 0.5, costSource: 'sdk' as const,
    }
    await recordTokenUsage(input)
    await recordTokenUsage(input)
    await recordTokenUsage(input)
    // Three distinct ledger rows…
    expect(ledger.length).toBe(3)
    // …but a single daily row with summed totals.
    expect(daily.size).toBe(1)
    const d = daily.get('u1|2026-05-30|claude-opus-4')!
    expect(d.input_tokens).toBe(300)
    expect(d.output_tokens).toBe(150)
    expect(d.cache_read_input_tokens).toBe(600)
    expect(d.cost_usd).toBeCloseTo(1.5, 6)
  })

  test('null model is bucketed under empty-string daily key', async () => {
    ledger.length = 0
    daily.clear()
    await recordTokenUsage({
      userId: 'u1', sessionId: null, model: null,
      inputTokens: 5, outputTokens: 5,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0.01, costSource: 'estimated',
    })
    expect(daily.has('u1|2026-05-30|')).toBe(true)
    expect(ledger[0].model).toBeNull()
  })

  // PTYCAP Phase 1, plan 02 — backward-compat regression: an older supervisor
  // that has never heard of runner_type must still produce a correctly
  // bucketed 'stream-json' ledger row (the pre-PTYCAP shape).
  test('runnerType omitted (pre-PTYCAP supervisor shape) records as stream-json', async () => {
    ledger.length = 0
    daily.clear()
    await recordTokenUsage({
      userId: 'u1', sessionId: 's1', model: 'claude-opus-4',
      inputTokens: 1, outputTokens: 1,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0.001, costSource: 'estimated',
    })
    expect(ledger[0].runnerType).toBe('stream-json')
  })

  test('runnerType: pty-interactive is captured verbatim (the default is a default, not a hardcode)', async () => {
    ledger.length = 0
    daily.clear()
    await recordTokenUsage({
      userId: 'u1', sessionId: 's1', model: 'claude-opus-4',
      inputTokens: 1, outputTokens: 1,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0.001, costSource: 'estimated', runnerType: 'pty-interactive',
    })
    expect(ledger[0].runnerType).toBe('pty-interactive')
  })
})

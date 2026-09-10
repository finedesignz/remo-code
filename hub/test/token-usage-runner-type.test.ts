/**
 * PTYCAP Phase 1, plan 02 — proves SC-2 (interactive and programmatic usage stay
 * in separate buckets) at three levels:
 *   1. The DAL threads `runnerType` into the ledger INSERT (DB-free, in-memory fake).
 *   2. The hub's zod `AgentUsageEvent` PRESERVES `runner_type` on a PTY-shaped frame
 *      instead of silently stripping it as an unknown key.
 *   3. `token_usage.runner_type`'s CHECK constraint domain is exactly the two-value
 *      enum, read directly from the schema.sql source.
 *
 * (The real-Postgres proof that an out-of-enum value is REJECTED lives in
 * hub/test/e2e/schema-double-apply.e2e.test.ts — this file is DB-free by design.)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, mock, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentUsageEvent } from '../src/ws/agent-protocol.ts'

// --- In-memory sql fake, same shape as usage-event-handler.test.ts, with the
// trailing runner_type bind added to the token_usage INSERT branch. ---
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

afterAll(() => {
  mock.restore()
})

describe('recordTokenUsage — runner_type bucket split (SC-2)', () => {
  test('two calls differing only in runnerType produce two ledger rows tagged distinctly', async () => {
    ledger.length = 0
    daily.clear()
    await recordTokenUsage({
      userId: 'u1', sessionId: 's1', model: 'claude-sonnet-5',
      inputTokens: 10, outputTokens: 5,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0, costSource: 'estimated', runnerType: 'pty-interactive',
    })
    await recordTokenUsage({
      userId: 'u1', sessionId: 's1', model: 'claude-sonnet-5',
      inputTokens: 20, outputTokens: 8,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0.01, costSource: 'sdk', runnerType: 'stream-json',
    })
    expect(ledger.length).toBe(2)
    expect(ledger[0].runnerType).toBe('pty-interactive')
    expect(ledger[1].runnerType).toBe('stream-json')
  })

  test('runnerType omitted captures the DAL-level default stream-json', async () => {
    ledger.length = 0
    daily.clear()
    await recordTokenUsage({
      userId: 'u1', sessionId: 's1', model: 'claude-sonnet-5',
      inputTokens: 1, outputTokens: 1,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0, costSource: 'estimated',
    })
    expect(ledger[0].runnerType).toBe('stream-json')
  })

  test('both buckets still upsert ONE combined daily row (P1-D-D: no runner_type split in the rollup)', async () => {
    ledger.length = 0
    daily.clear()
    const base = {
      userId: 'u1', sessionId: 's1', model: 'claude-sonnet-5',
      inputTokens: 10, outputTokens: 5,
      cacheCreationInputTokens: 0, cacheReadInputTokens: 0,
      costUsd: 0, costSource: 'estimated' as const,
    }
    await recordTokenUsage({ ...base, runnerType: 'pty-interactive' })
    await recordTokenUsage({ ...base, runnerType: 'stream-json' })
    expect(ledger.length).toBe(2)
    expect(daily.size).toBe(1) // ONE row for (user_id, day, model) — combined, not split
    const d = daily.get('u1|2026-05-30|claude-sonnet-5')!
    expect(d.input_tokens).toBe(20) // summed across both runner_type buckets
  })
})

describe('AgentUsageEvent zod contract — runner_type survives the WS hop (SC-2)', () => {
  const PTY_SHAPED_FRAME = {
    type: 'usage_event' as const,
    session_id: 'sess-1',
    model: 'claude-sonnet-5',
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 1,
    cache_read_input_tokens: 0,
    cost_usd: 0,
    cost_source: 'estimated' as const,
    ts: new Date().toISOString(),
    runner_type: 'pty-interactive' as const,
  }

  test('a PTY-shaped frame parses successfully and PRESERVES runner_type (not stripped as an unknown key)', () => {
    const parsed = AgentUsageEvent.parse(PTY_SHAPED_FRAME)
    expect(parsed.runner_type).toBe('pty-interactive')
  })

  test('an old-shape frame with no runner_type key parses successfully, yielding undefined', () => {
    const { runner_type, ...oldShape } = PTY_SHAPED_FRAME
    const parsed = AgentUsageEvent.parse(oldShape)
    expect(parsed.runner_type).toBeUndefined()
  })

  test('a third, non-enum runner_type value FAILS zod parsing', () => {
    const bad = { ...PTY_SHAPED_FRAME, runner_type: 'api-key' }
    expect(() => AgentUsageEvent.parse(bad)).toThrow()
  })
})

describe('schema.sql source — token_usage_runner_type_check domain (SC-2)', () => {
  test('the CHECK constraint names exactly stream-json and pty-interactive, no other value', () => {
    const schemaPath = resolve(import.meta.dir, '../src/db/schema.sql')
    const raw = readFileSync(schemaPath, 'utf8')
    // Strip `--` line comments before matching, so an explanatory comment can
    // never satisfy (or invalidate) this source assertion.
    const codeOnly = raw
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('--')
        return idx === -1 ? line : line.slice(0, idx)
      })
      .join('\n')
    const m = codeOnly.match(/token_usage_runner_type_check\s+CHECK\s*\(runner_type IN \(([^)]+)\)\)/)
    expect(m).not.toBeNull()
    const values = (m![1].match(/'([^']+)'/g) ?? []).map((s) => s.slice(1, -1))
    expect(values.sort()).toEqual(['pty-interactive', 'stream-json'])
  })
})

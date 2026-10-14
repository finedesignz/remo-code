/**
 * PTYCAP-05 QC round 1 (codex #4): the proof's "hard" token budget must not silently
 * under-count when a usage_event fails to persist. hub/src/ws/agent.ts used to log and drop the
 * failure; the proof gate then saw a live session and an undercounted total.
 *
 * Mechanism under test: a failed usage_event persist marks the session in an in-process registry;
 * sumSessionTokensSince reports `attributionLost` for any proof window that the loss falls inside,
 * and both proof consumers (budget gate, tick evaluator) fail closed on it.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/placeholder'

import { describe, test, expect, mock, afterAll, beforeEach } from 'bun:test'

let failInsert = true
const inserts: unknown[][] = []

function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  const text = strings.join('?')
  if (text.includes('INSERT INTO token_usage ')) {
    if (failInsert) return Promise.reject(new Error('connection terminated'))
    inserts.push(values)
    return Promise.resolve([{ id: 'tu_1' }])
  }
  if (text.includes('INSERT INTO token_usage_daily')) return Promise.resolve([])
  if (text.includes('FROM token_usage') && text.includes('session_exists')) {
    return Promise.resolve([{ sum: '120', session_exists: true }])
  }
  return Promise.resolve([])
}
mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))

const { handleAgentMessage, createAgentWsData } = await import('../src/ws/agent.ts')
const { sumSessionTokensSince } = await import('../src/db/token-usage-dal.ts')
const loss = await import('../src/usage/attribution-loss.ts')

afterAll(() => mock.restore())

const SESSION = 'sess-proof-1'
const T0 = new Date('2026-10-13T10:00:00Z')

function wsFor(sessionId: string) {
  const data = createAgentWsData()
  data.authenticated = true
  data.userId = 'user-1'
  data.sessionId = sessionId
  return { data, send() {}, close() {} } as never
}

const usageFrame = (sessionId: string) =>
  JSON.stringify({
    type: 'usage_event',
    session_id: sessionId,
    model: 'claude-sonnet-5',
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    cost_usd: 0.01,
    cost_source: 'sdk',
  })

beforeEach(() => {
  loss.resetUsageAttributionLoss()
  inserts.length = 0
  failInsert = true
})

describe('usage attribution loss registry', () => {
  test('a failed usage_event persist marks the session; a clean one does not', async () => {
    await handleAgentMessage(wsFor(SESSION), usageFrame(SESSION))
    expect(loss.usageAttributionLostSince(SESSION, T0)).toBe(true)

    loss.resetUsageAttributionLoss()
    failInsert = false
    await handleAgentMessage(wsFor(SESSION), usageFrame(SESSION))
    expect(inserts.length).toBe(1)
    expect(loss.usageAttributionLostSince(SESSION, T0)).toBe(false)
  })

  test('a loss BEFORE the proof window does not poison it; another session is unaffected', () => {
    loss.markUsageAttributionLost(SESSION, Date.parse('2026-10-13T09:00:00Z'))
    expect(loss.usageAttributionLostSince(SESSION, T0)).toBe(false)
    loss.markUsageAttributionLost(SESSION, Date.parse('2026-10-13T10:05:00Z'))
    expect(loss.usageAttributionLostSince(SESSION, T0)).toBe(true)
    expect(loss.usageAttributionLostSince('other', T0)).toBe(false)
  })

  test('an unparseable window start fails closed once any loss is recorded for the session', () => {
    loss.markUsageAttributionLost(SESSION)
    expect(loss.usageAttributionLostSince(SESSION, 'not-a-date')).toBe(true)
  })

  test('the registry is bounded (oldest entries evicted)', () => {
    for (let i = 0; i < 1500; i++) loss.markUsageAttributionLost(`s-${i}`)
    expect(loss.usageAttributionLostSize()).toBeLessThanOrEqual(1000)
  })
})

describe('turn_id correlation (repair round)', () => {
  test('a usage_event turn_id is persisted on the ledger row; absent => null', async () => {
    failInsert = false
    const frame = (turnId?: string) => JSON.stringify({ ...JSON.parse(usageFrame(SESSION)), ...(turnId ? { turn_id: turnId } : {}) })
    await handleAgentMessage(wsFor(SESSION), frame('turn-abc'))
    await handleAgentMessage(wsFor(SESSION), frame())
    expect(inserts[0]).toContain('turn-abc')
    expect(inserts[1]).not.toContain('turn-abc')
    expect(inserts[1][inserts[1].length - 1]).toBeNull()
  })
})

describe('sumSessionTokensSince surfaces the loss', () => {
  test('lost -> attributionLost true even though the session row exists and sum looks fine', async () => {
    loss.markUsageAttributionLost(SESSION, Date.parse('2026-10-13T10:05:00Z'))
    expect(await sumSessionTokensSince(SESSION, T0)).toEqual({ tokens: 120, sessionExists: true, attributionLost: true })
  })

  test('no loss -> shape unchanged (no attributionLost key)', async () => {
    expect(await sumSessionTokensSince(SESSION, T0)).toEqual({ tokens: 120, sessionExists: true })
  })
})

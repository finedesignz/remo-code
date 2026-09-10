/**
 * Daily TOKEN cap counts CACHE tokens (2026-07 incident fix).
 *
 * PR #335 excluded cache_read/cache_creation from `getTodayTokenTotal` on the
 * theory cache-read is "free". It is not free against a subscription RATE LIMIT:
 * a wedged orchestrator tick loop burned 2.83B cache_read tokens in 2 days while
 * the I/O-only cap never tripped. This asserts the SQL sums ALL FOUR buckets and
 * keeps the same tz-day boundary as the cost cap.
 */
import { describe, test, expect, mock } from 'bun:test'

let lastQuery = ''
const rows: any[] = [{ sum: '2830000000' }]

mock.module('../src/db/postgres.ts', () => ({
  sql: async (strings: TemplateStringsArray, ..._vals: unknown[]) => {
    lastQuery = Array.isArray(strings) ? strings.join('?') : String(strings)
    return rows
  },
}))

const dalUrl = `../src/db/token-usage-dal.ts?t=${Date.now()}${Math.random()}`
const { getTodayTokenTotal } = await import(dalUrl)

describe('getTodayTokenTotal — all four token buckets', () => {
  test('sums input + output + cache_creation + cache_read', async () => {
    const total = await getTodayTokenTotal('u1', 'America/Los_Angeles')
    expect(total).toBe(2_830_000_000)
    for (const col of [
      'input_tokens',
      'output_tokens',
      'cache_creation_input_tokens',
      'cache_read_input_tokens',
    ]) {
      expect(lastQuery).toContain(col)
    }
  })

  test('keeps the tz-day boundary used by /api/usage/cost', async () => {
    await getTodayTokenTotal('u1', 'America/Los_Angeles')
    expect(lastQuery).toContain("date_trunc('day', now() AT TIME ZONE")
  })
})

// CORCH-14: the slot supervisor's built-in quota poll (supervisor/src/usage/slot-quota-poll.ts).
// Injected env + fetch only: no network, and the token never appears in a result.
import { describe, test, expect } from 'bun:test'
import {
  parseUnifiedHeaders,
  pollSlotQuota,
  slotQuotaEnabled,
  slotQuotaIntervalMs,
  SLOT_QUOTA_URL,
} from '../src/usage/slot-quota-poll'

const SENTINEL = 'sentinel-token-value-0123456789'
const SLOT_ENV = { REMO_ACCOUNT_SLOT: 'acct-2', CLAUDE_CODE_OAUTH_TOKEN: SENTINEL }
const H = (o: Record<string, string>) => new Headers(o)
const FULL = {
  'anthropic-ratelimit-unified-5h-utilization': '0.25',
  'anthropic-ratelimit-unified-7d-utilization': '0.5',
  'anthropic-ratelimit-unified-5h-reset': '1794844800',
  'anthropic-ratelimit-unified-7d-reset': '1795276800',
}

describe('parseUnifiedHeaders', () => {
  test('fractions become percentages and unix seconds become ISO instants', () => {
    expect(parseUnifiedHeaders(H(FULL))).toEqual({
      five_h_pct: 25,
      seven_d_pct: 50,
      resets_5h: new Date(1794844800 * 1000).toISOString(),
      resets_7d: new Date(1795276800 * 1000).toISOString(),
    })
  })

  test('boundaries 0 and 1 are valid', () => {
    const r = parseUnifiedHeaders(H({ ...FULL, 'anthropic-ratelimit-unified-5h-utilization': '0', 'anthropic-ratelimit-unified-7d-utilization': '1' }))
    expect(r?.five_h_pct).toBe(0)
    expect(r?.seven_d_pct).toBe(100)
  })

  test('absent 5h headers (no open 5h window, seen live) give a null 5h, not 0 and not a failure', () => {
    expect(parseUnifiedHeaders(H({ 'anthropic-ratelimit-unified-7d-utilization': '0.4', 'anthropic-ratelimit-unified-7d-reset': '1795014000' }))).toEqual({
      five_h_pct: null, seven_d_pct: 40, resets_5h: null, resets_7d: new Date(1795014000 * 1000).toISOString(),
    })
  })

  test('a missing 7d, or a non-numeric, empty or out-of-range utilization, is no reading', () => {
    const { ['anthropic-ratelimit-unified-7d-utilization']: _drop, ...missing } = FULL
    expect(parseUnifiedHeaders(H(missing))).toBeNull()
    for (const bad of ['abc', '', '1.01', '-0.1', 'NaN']) {
      expect(parseUnifiedHeaders(H({ ...FULL, 'anthropic-ratelimit-unified-5h-utilization': bad }))).toBeNull()
    }
  })

  test('a missing or malformed reset is null, not a failure', () => {
    const r = parseUnifiedHeaders(H({
      'anthropic-ratelimit-unified-5h-utilization': '0.1',
      'anthropic-ratelimit-unified-7d-utilization': '0.2',
      'anthropic-ratelimit-unified-7d-reset': 'soon',
    }))
    expect(r).toEqual({ five_h_pct: 10, seven_d_pct: 20, resets_5h: null, resets_7d: null })
  })
})

describe('gating', () => {
  test('enabled only for a slot that holds its token', () => {
    expect(slotQuotaEnabled(SLOT_ENV)).toBe(true)
    expect(slotQuotaEnabled({ CLAUDE_CODE_OAUTH_TOKEN: SENTINEL })).toBe(false)
    expect(slotQuotaEnabled({ REMO_ACCOUNT_SLOT: 'acct-2' })).toBe(false)
    expect(slotQuotaEnabled({ REMO_ACCOUNT_SLOT: 'bad slot!', CLAUDE_CODE_OAUTH_TOKEN: SENTINEL })).toBe(false)
  })

  test('a non-slot or token-less supervisor never calls out', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls++; return new Response(null) }) as unknown as typeof fetch
    expect(await pollSlotQuota({ env: {}, fetchImpl })).toEqual({ ok: false, reason: 'not_a_slot' })
    expect(await pollSlotQuota({ env: { REMO_ACCOUNT_SLOT: 'acct-2' }, fetchImpl })).toEqual({ ok: false, reason: 'slot_token_missing' })
    expect(calls).toBe(0)
  })

  test('interval: default 5 min, floor 1 min, garbage falls back', () => {
    expect(slotQuotaIntervalMs({})).toBe(300_000)
    expect(slotQuotaIntervalMs({ REMO_SLOT_QUOTA_INTERVAL_MS: '120000' })).toBe(120_000)
    // Ceiling: the hub's 10 min staleness TTL must never be reachable by configuration.
    expect(slotQuotaIntervalMs({ REMO_SLOT_QUOTA_INTERVAL_MS: '600000' })).toBe(480_000)
    expect(slotQuotaIntervalMs({ REMO_SLOT_QUOTA_INTERVAL_MS: '5' })).toBe(60_000)
    expect(slotQuotaIntervalMs({ REMO_SLOT_QUOTA_INTERVAL_MS: 'x' })).toBe(300_000)
  })
})

describe('pollSlotQuota', () => {
  test('sends the token only as the Authorization header and reports parsed windows only', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response('{"ignored":true}', { status: 200, headers: FULL })
    }) as unknown as typeof fetch
    const r = await pollSlotQuota({ env: SLOT_ENV, fetchImpl, now: () => new Date('2026-11-17T12:00:00Z') })
    expect(r).toEqual({
      ok: true,
      report: {
        account_slot: 'acct-2',
        five_h_pct: 25,
        seven_d_pct: 50,
        resets_5h: new Date(1794844800 * 1000).toISOString(),
        resets_7d: new Date(1795276800 * 1000).toISOString(),
        fetched_at: '2026-11-17T12:00:00.000Z',
      },
    })
    expect(seen!.url).toBe(SLOT_QUOTA_URL)
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SENTINEL}`)
    expect(JSON.parse(seen!.init.body as string).max_tokens).toBe(1)
    expect(String(seen!.init.body)).not.toContain(SENTINEL)
    expect(JSON.stringify(r)).not.toContain(SENTINEL)
  })

  test('a 429 that carries the windows is still a reading', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 429, headers: { ...FULL, 'anthropic-ratelimit-unified-5h-utilization': '1' } })) as unknown as typeof fetch
    const r = await pollSlotQuota({ env: SLOT_ENV, fetchImpl })
    expect(r.ok && r.report.five_h_pct).toBe(100)
  })

  test('non-2xx, missing headers and a thrown fetch are reason codes that never carry the token', async () => {
    const mk = (f: () => Promise<Response>) => f as unknown as typeof fetch
    const cases = [
      await pollSlotQuota({ env: SLOT_ENV, fetchImpl: mk(async () => new Response(SENTINEL, { status: 401 })) }),
      await pollSlotQuota({ env: SLOT_ENV, fetchImpl: mk(async () => new Response('{}', { status: 200 })) }),
      await pollSlotQuota({ env: SLOT_ENV, fetchImpl: mk(async () => { throw new Error(`boom ${SENTINEL}`) }) }),
    ]
    expect(cases.map((c) => (c.ok ? 'ok' : c.reason))).toEqual(['http_401', 'usage_headers_unavailable', 'network_error: Error'])
    expect(JSON.stringify(cases)).not.toContain(SENTINEL)
  })
})

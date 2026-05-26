import { describe, expect, test } from 'bun:test'
import { parseUsagePayload, pollOnce } from '../src/usage-poller'

const VALID_BODY = {
  five_hour: { utilization: 42.5, resets_at: '2026-05-25T20:00:00Z' },
  seven_day: { utilization: 12.0, resets_at: '2026-06-01T00:00:00Z' },
  seven_day_opus: null,
  seven_day_oauth_apps: { utilization: 5, resets_at: '2026-06-01T00:00:00Z' },
}

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as any
}

describe('parseUsagePayload', () => {
  test('accepts a valid payload', () => {
    const p = parseUsagePayload(VALID_BODY)
    expect(p).not.toBeNull()
    expect(p!.five_hour.utilization).toBe(42.5)
    expect(p!.seven_day_opus).toBeNull()
  })

  test('rejects missing five_hour', () => {
    expect(parseUsagePayload({ seven_day: VALID_BODY.seven_day })).toBeNull()
  })

  test('rejects bad types', () => {
    expect(parseUsagePayload({ five_hour: { utilization: 'x', resets_at: 'y' }, seven_day: VALID_BODY.seven_day })).toBeNull()
  })

  test('accepts omitted optional fields', () => {
    const p = parseUsagePayload({ five_hour: VALID_BODY.five_hour, seven_day: VALID_BODY.seven_day })
    expect(p).not.toBeNull()
    expect(p!.seven_day_opus).toBeNull()
    expect(p!.seven_day_oauth_apps).toBeNull()
  })
})

describe('pollOnce', () => {
  test('returns payload on 200 with valid body', async () => {
    const result = await pollOnce({
      fetchFn: fakeFetch(200, VALID_BODY),
      readToken: () => 'sk-tok',
      logger: () => {},
    })
    expect(result).not.toBeNull()
    expect(result!.five_hour.utilization).toBe(42.5)
  })

  test('returns null + logs warning when no token', async () => {
    const logs: string[] = []
    const result = await pollOnce({
      fetchFn: fakeFetch(200, VALID_BODY),
      readToken: () => null,
      logger: (m) => logs.push(m),
    })
    expect(result).toBeNull()
    expect(logs.length).toBe(1)
    expect(logs[0]).toMatch(/no access token/)
  })

  test('returns null on 401', async () => {
    const logs: string[] = []
    const result = await pollOnce({
      fetchFn: fakeFetch(401, { error: 'expired' }),
      readToken: () => 'sk-tok',
      logger: (m) => logs.push(m),
    })
    expect(result).toBeNull()
    expect(logs[0]).toMatch(/HTTP 401/)
  })

  test('returns null on network error', async () => {
    const logs: string[] = []
    const result = await pollOnce({
      fetchFn: (async () => { throw new Error('econnreset') }) as any,
      readToken: () => 'sk-tok',
      logger: (m) => logs.push(m),
    })
    expect(result).toBeNull()
    expect(logs[0]).toMatch(/network error.*econnreset/)
  })

  test('returns null on malformed JSON', async () => {
    const logs: string[] = []
    const result = await pollOnce({
      fetchFn: (async () => new Response('not-json{', { status: 200 })) as any,
      readToken: () => 'sk-tok',
      logger: (m) => logs.push(m),
    })
    expect(result).toBeNull()
    expect(logs[0]).toMatch(/malformed JSON/)
  })

  test('returns null when payload fails schema', async () => {
    const logs: string[] = []
    const result = await pollOnce({
      fetchFn: fakeFetch(200, { five_hour: 'not-an-object' }),
      readToken: () => 'sk-tok',
      logger: (m) => logs.push(m),
    })
    expect(result).toBeNull()
    expect(logs[0]).toMatch(/schema/)
  })

  test('sends correct Anthropic headers', async () => {
    let sawHeaders: Headers | null = null
    const result = await pollOnce({
      fetchFn: (async (_url: any, init: any) => {
        sawHeaders = new Headers(init.headers)
        return new Response(JSON.stringify(VALID_BODY), { status: 200 })
      }) as any,
      readToken: () => 'sk-abc',
      logger: () => {},
    })
    expect(result).not.toBeNull()
    expect(sawHeaders!.get('authorization')).toBe('Bearer sk-abc')
    expect(sawHeaders!.get('anthropic-beta')).toBe('oauth-2025-04-20')
    expect(sawHeaders!.get('user-agent')).toMatch(/^claude-code\//)
  })
})

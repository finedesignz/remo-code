// CORCH-15 (R3.8): the REST memlog transport. Injected fetch only: no network, and the token never appears in a
// result or a log line.
import { describe, test, expect, spyOn, afterEach } from 'bun:test'
import { createRestMemlog } from '../src/corch/memlog-rest.ts'
import { memlogRestConfig } from '../src/corch/flag.ts'

const TOKEN = 'mcp_sentinel-token-0123456789'
const CLAIM = { repo: 'throwaway', session: 'corch:0b0e0c1a-1111-4222-8333-444455556666', branch: 'corch/0b0e0c1a', worktree: '/data/work/throwaway-corch', scope: 'CORCH item' }

function client(respond: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return respond(url, init)
  }) as unknown as typeof fetch
  return { c: createRestMemlog({ baseUrl: 'https://memlog.example/', token: TOKEN, cli: 'claude', fetchImpl }), calls }
}

const warn = spyOn(console, 'warn').mockImplementation(() => {})
afterEach(() => warn.mockClear())

describe('claim', () => {
  test('200: POST /v1/claims with the token only in x-api-key, cli set and no host', async () => {
    const { c, calls } = client(() => new Response('{"ok":true}', { status: 200 }))
    expect(await c.claim(CLAIM)).toEqual({ ok: true })
    expect(calls.length).toBe(1)
    expect(calls[0]!.url).toBe('https://memlog.example/v1/claims')
    expect(calls[0]!.init.method).toBe('POST')
    expect((calls[0]!.init.headers as Record<string, string>)['x-api-key']).toBe(TOKEN)
    const body = JSON.parse(calls[0]!.init.body as string)
    expect(body).toEqual({ ...CLAIM, cli: 'claude' })
    expect('host' in body).toBe(false)
    expect(String(calls[0]!.init.body)).not.toContain(TOKEN)
  })

  test('409 is a conflict; every other failure is memlog_unavailable (fail closed)', async () => {
    expect(await client(() => new Response('{"ok":false,"holder":"x"}', { status: 409 })).c.claim(CLAIM)).toEqual({ ok: false, reason: 'memlog_conflict' })
    for (const status of [400, 401, 403, 500, 503]) {
      expect(await client(() => new Response(TOKEN, { status })).c.claim(CLAIM)).toEqual({ ok: false, reason: 'memlog_unavailable' })
    }
    expect(await client(() => { throw new Error(`boom ${TOKEN}`) }).c.claim(CLAIM)).toEqual({ ok: false, reason: 'memlog_unavailable' })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
  })
})

describe('heartbeat and release', () => {
  test('true on 2xx, false otherwise, never throw', async () => {
    const good = client(() => new Response('{}', { status: 200 }))
    expect(await good.c.heartbeat({ repo: 'throwaway', session: CLAIM.session })).toBe(true)
    expect(await good.c.release({ repo: 'throwaway', session: CLAIM.session, status: 'DONE', note: 'merged' })).toBe(true)
    expect(good.calls.map((x) => x.url)).toEqual(['https://memlog.example/v1/claims/heartbeat', 'https://memlog.example/v1/claims/release'])
    expect(JSON.parse(good.calls[1]!.init.body as string)).toEqual({ repo: 'throwaway', session: CLAIM.session, status: 'DONE', note: 'merged' })

    const held = client(() => new Response('{}', { status: 409 }))
    expect(await held.c.heartbeat({ repo: 'throwaway', session: CLAIM.session })).toBe(false)
    const down = client(() => { throw new Error('down') })
    expect(await down.c.heartbeat({ repo: 'throwaway', session: CLAIM.session })).toBe(false)
    expect(await down.c.release({ repo: 'throwaway', session: CLAIM.session, status: 'ORPHANED', note: 'x' })).toBe(false)
  })
})

describe('memlogRestConfig', () => {
  const VARS = ['REMO_CORCH_MEMLOG_URL', 'REMO_CORCH_MEMLOG_TOKEN', 'REMO_CORCH_MEMLOG_CLI'] as const
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]))
  afterEach(() => {
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })
  const set = (o: Partial<Record<(typeof VARS)[number], string>>) => {
    for (const k of VARS) delete process.env[k]
    Object.assign(process.env, o)
  }

  test('null unless both URL and token are set and the URL is https (or loopback http)', () => {
    set({})
    expect(memlogRestConfig()).toBeNull()
    set({ REMO_CORCH_MEMLOG_URL: 'https://memlog.example' })
    expect(memlogRestConfig()).toBeNull()
    set({ REMO_CORCH_MEMLOG_TOKEN: TOKEN })
    expect(memlogRestConfig()).toBeNull()
    set({ REMO_CORCH_MEMLOG_URL: 'http://memlog.example', REMO_CORCH_MEMLOG_TOKEN: TOKEN })
    expect(memlogRestConfig()).toBeNull()
    set({ REMO_CORCH_MEMLOG_URL: 'not a url', REMO_CORCH_MEMLOG_TOKEN: TOKEN })
    expect(memlogRestConfig()).toBeNull()
  })

  test('both set: base URL normalized, cli defaults to claude and is overridable', () => {
    set({ REMO_CORCH_MEMLOG_URL: 'https://memlog.example/', REMO_CORCH_MEMLOG_TOKEN: TOKEN })
    expect(memlogRestConfig()).toEqual({ baseUrl: 'https://memlog.example', token: TOKEN, cli: 'claude' })
    set({ REMO_CORCH_MEMLOG_URL: 'http://127.0.0.1:9000', REMO_CORCH_MEMLOG_TOKEN: TOKEN, REMO_CORCH_MEMLOG_CLI: 'human' })
    expect(memlogRestConfig()).toEqual({ baseUrl: 'http://127.0.0.1:9000', token: TOKEN, cli: 'human' })
  })
})

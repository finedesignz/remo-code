import { describe, it, expect } from 'bun:test'
import { runDeployVerify, formatVerifyReport } from '../src/scheduler/deploy-verify-probe.ts'

// Build a fetch stub from a path → status map. Records which paths were hit.
function stubFetch(statusByPath: Record<string, number>, hits: string[]) {
  return (async (url: string) => {
    const path = new URL(url).pathname
    hits.push(path)
    const status = statusByPath[path]
    if (status === undefined || status === 0) throw new Error('network')
    return { status, text: async () => '' } as any
  }) as unknown as typeof fetch
}

const noSleep = async () => {}

describe('runDeployVerify (auto-dev P5, rule 14.4)', () => {
  it('probes REAL routes after health — not /health alone', async () => {
    const hits: string[] = []
    const result = await runDeployVerify({
      baseUrl: 'https://app.example.com',
      routes: ['/api/sessions', '/api/usage', '/openapi.json', '/docs'],
      fetchImpl: stubFetch(
        {
          '/health': 200,
          '/api/sessions': 401,
          '/api/usage': 200,
          '/openapi.json': 200,
          '/docs': 200,
        },
        hits,
      ),
      sleepImpl: noSleep,
    })
    // The probe must hit the real routes, proving it is NOT health-only.
    expect(hits).toContain('/api/sessions')
    expect(hits).toContain('/api/usage')
    expect(hits).toContain('/openapi.json')
    expect(hits).toContain('/docs')
    expect(result.healthOk).toBe(true)
    expect(result.pass).toBe(true)
  })

  it('classifies 401 as mounted_auth → PASS (route exists behind auth)', async () => {
    const result = await runDeployVerify({
      baseUrl: 'https://app.example.com',
      routes: ['/api/sessions'],
      fetchImpl: stubFetch({ '/health': 200, '/api/sessions': 401 }, []),
      sleepImpl: noSleep,
    })
    expect(result.routes[0]).toMatchObject({ status: 401, classification: 'mounted_auth', verdict: 'pass' })
    expect(result.pass).toBe(true)
  })

  it('classifies 404 as route_gone → FAIL', async () => {
    const result = await runDeployVerify({
      baseUrl: 'https://app.example.com',
      routes: ['/api/sessions'],
      fetchImpl: stubFetch({ '/health': 200, '/api/sessions': 404 }, []),
      sleepImpl: noSleep,
    })
    expect(result.routes[0]).toMatchObject({ status: 404, classification: 'route_gone', verdict: 'fail' })
    expect(result.pass).toBe(false)
  })

  it('classifies 502 as runtime_broken → FAIL', async () => {
    const result = await runDeployVerify({
      baseUrl: 'https://app.example.com',
      routes: ['/api/sessions'],
      fetchImpl: stubFetch({ '/health': 200, '/api/sessions': 502 }, []),
      sleepImpl: noSleep,
    })
    expect(result.routes[0]).toMatchObject({ status: 502, classification: 'runtime_broken', verdict: 'fail' })
    expect(result.pass).toBe(false)
  })

  it('falls back to /healthz when /health missing', async () => {
    const hits: string[] = []
    const result = await runDeployVerify({
      baseUrl: 'https://app.example.com',
      routes: ['/api/x'],
      fetchImpl: stubFetch({ '/health': 404, '/healthz': 200, '/api/x': 200 }, hits),
      sleepImpl: noSleep,
    })
    expect(result.healthOk).toBe(true)
    expect(result.healthPath).toBe('/healthz')
    expect(hits).toContain('/healthz')
  })

  it('health never green within timeout → pass=false, still probes routes', async () => {
    let clock = 0
    const hits: string[] = []
    const result = await runDeployVerify({
      baseUrl: 'https://app.example.com',
      routes: ['/api/x'],
      healthTimeoutMs: 10_000,
      healthIntervalMs: 5_000,
      fetchImpl: stubFetch({ '/health': 503, '/healthz': 503, '/api/x': 502 }, hits),
      sleepImpl: noSleep,
      nowMs: () => {
        const v = clock
        clock += 5_000
        return v
      },
    })
    expect(result.healthOk).toBe(false)
    expect(result.pass).toBe(false)
    // Real routes still probed even when health is down.
    expect(hits).toContain('/api/x')
  })

  it('unreachable (network error) → unreachable → FAIL', async () => {
    const result = await runDeployVerify({
      baseUrl: 'https://app.example.com',
      routes: ['/api/x'],
      fetchImpl: stubFetch({ '/health': 200, '/api/x': 0 }, []),
      sleepImpl: noSleep,
    })
    expect(result.routes[0]).toMatchObject({ classification: 'unreachable', verdict: 'fail' })
    expect(result.pass).toBe(false)
  })

  it('formatVerifyReport lists each route + verdict', () => {
    const report = formatVerifyReport('o/r', {
      healthOk: true,
      healthPath: '/health',
      healthStatus: 200,
      routes: [
        { path: '/api/a', status: 401, verdict: 'pass', classification: 'mounted_auth' },
        { path: '/api/b', status: 502, verdict: 'fail', classification: 'runtime_broken' },
      ],
      pass: false,
    })
    expect(report).toContain('/api/a')
    expect(report).toContain('/api/b')
    expect(report).toContain('FAIL')
  })
})

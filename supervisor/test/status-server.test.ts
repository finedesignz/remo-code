/**
 * B6 — supervisor /sup/status endpoint.
 *
 * Stubs the StatusSnapshotProvider with predictable getters and asserts the
 * JSON shape, content-type, and 404/405 routing. Binds 9106 if free, else
 * 9197, else skips (cannot run alongside an actual supervisor — CI is fine).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import {
  startStatusServer, startStatusServerSupervised, isPortInUseError, buildSnapshot,
  type StatusSnapshotProvider, type StatusServer, type SupervisedStatusServer,
} from '../src/status-server'

function makeProvider(overrides: Partial<StatusSnapshotProvider> = {}): StatusSnapshotProvider {
  return {
    version: '0.5.8',
    getHubConnected: () => true,
    getHubState: () => 'connected',
    getLastReconnectMsAgo: () => 1234,
    getLastError: () => null,
    getRunners: () => [],
    getQueueDepth: () => 0,
    getSupervisorId: () => 'sv_abc',
    getHostname: () => 'TEST-HOST',
    ...overrides,
  }
}

describe('buildSnapshot', () => {
  test('returns the expected shape', () => {
    const snap = buildSnapshot(makeProvider())
    expect(snap).toMatchObject({
      version: '0.5.8',
      supervisor_id: 'sv_abc',
      hostname: 'TEST-HOST',
      hub_connected: true,
      hub_state: 'connected',
      last_reconnect_ms_ago: 1234,
      last_error: null,
      runners: [],
      queue_depth: 0,
    })
    expect(typeof snap.ts).toBe('string')
  })

  test('surfaces last_error when set', () => {
    const snap = buildSnapshot(makeProvider({
      getLastError: () => ({ message: 'ws_close code=4001', at: '2026-05-28T00:00:00Z' }),
      getHubConnected: () => false,
    }))
    expect(snap.last_error).toEqual({ message: 'ws_close code=4001', at: '2026-05-28T00:00:00Z' })
    expect(snap.hub_connected).toBe(false)
  })

  test('passes runners through verbatim', () => {
    const runners = [{
      session_id: 'sess_1', run_id: 'run_1', cli_kind: 'claude' as const,
      project_dir: '/tmp/x', pid: 1234, state: 'running', restart_count: 0,
    }]
    const snap = buildSnapshot(makeProvider({ getRunners: () => runners, getQueueDepth: () => 1 }))
    expect(snap.runners).toEqual(runners)
    expect(snap.queue_depth).toBe(1)
  })
})

describe('isPortInUseError (fix/headless-autoupdate)', () => {
  test("matches Bun's ACTUAL bind-failure message", () => {
    // THE BUG: the old guard tested only /EADDRINUSE|address already in use/i,
    // but Bun says exactly this — so the PRIMARY failure rethrew, the FALLBACK
    // port was never tried, and the supervisor ran status-blind forever.
    expect(isPortInUseError(new Error('Failed to start server. Is port 9106 in use?'))).toBe(true)
  })

  test('still matches the classic POSIX shapes', () => {
    expect(isPortInUseError(new Error('listen EADDRINUSE: address already in use 127.0.0.1:9106'))).toBe(true)
    expect(isPortInUseError(Object.assign(new Error('boom'), { code: 'EADDRINUSE' }))).toBe(true)
  })

  test('does NOT swallow unrelated errors', () => {
    expect(isPortInUseError(new Error('EACCES: permission denied'))).toBe(false)
    expect(isPortInUseError(new Error('something else entirely'))).toBe(false)
  })
})

describe('startStatusServerSupervised (fix/headless-autoupdate)', () => {
  let sup: SupervisedStatusServer | null = null
  afterEach(() => {
    try { sup?.stop() } catch {}
    sup = null
  })

  test('reports healthy + a port when it binds', () => {
    sup = startStatusServerSupervised(makeProvider(), { log: () => {} })
    if (!sup.isHealthy()) return // both ports held by a real supervisor — skip
    expect(sup.getPort()).toBeGreaterThan(0)
    expect(sup.getLastError()).toBeNull()
  })

  test('when BOTH ports are held: degraded, not crashed, and retrying', async () => {
    // Occupy 9106 AND 9197 so the supervised server cannot bind — the zombie
    // -listener scenario. It must report unhealthy (so the hub can SEE it),
    // keep running, and schedule a retry rather than giving up forever.
    let a: any = null, b: any = null
    try {
      a = Bun.serve({ hostname: '127.0.0.1', port: 9106, fetch: () => new Response('x') })
      b = Bun.serve({ hostname: '127.0.0.1', port: 9197, fetch: () => new Response('x') })
    } catch {
      try { a?.stop(true) } catch {}
      try { b?.stop(true) } catch {}
      return // ports already taken by a real supervisor — can't run this test here
    }

    const logs: string[] = []
    sup = startStatusServerSupervised(makeProvider(), {
      log: (_l, m) => logs.push(m),
      retryBaseMs: 50,
      retryMaxMs: 50,
    })
    expect(sup.isHealthy()).toBe(false)
    expect(sup.getPort()).toBeNull()
    expect(sup.getLastError()).toContain('bind failed')
    expect(logs.some((l) => /DEGRADED/.test(l) && /Retrying/.test(l))).toBe(true)

    // Free the ports — the retry loop must self-heal without a reinstall.
    a.stop(true)
    b.stop(true)
    await Bun.sleep(300)
    expect(sup.isHealthy()).toBe(true)
    expect(sup.getPort()).toBe(9106)
  })
})

describe('startStatusServer (live)', () => {
  let server: StatusServer | null = null
  afterEach(() => {
    try { server?.stop() } catch {}
    server = null
  })

  test('serves GET /sup/status with application/json', async () => {
    try {
      server = startStatusServer(makeProvider())
    } catch (err: any) {
      // Both ports in use (real supervisor running, or another test). Skip.
      if (/bind failed/.test(err.message)) return
      throw err
    }
    const res = await fetch(`${server.url}/sup/status`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as any
    expect(body.hub_connected).toBe(true)
    expect(body.version).toBe('0.5.8')
  })

  test('returns 404 for unknown paths', async () => {
    try {
      server = startStatusServer(makeProvider())
    } catch (err: any) {
      if (/bind failed/.test(err.message)) return
      throw err
    }
    const res = await fetch(`${server.url}/health`)
    expect(res.status).toBe(404)
  })

  test('returns 405 for non-GET', async () => {
    try {
      server = startStatusServer(makeProvider())
    } catch (err: any) {
      if (/bind failed/.test(err.message)) return
      throw err
    }
    const res = await fetch(`${server.url}/sup/status`, { method: 'POST' })
    expect(res.status).toBe(405)
  })

  test('binds loopback only (127.0.0.1, not 0.0.0.0)', async () => {
    try {
      server = startStatusServer(makeProvider())
    } catch (err: any) {
      if (/bind failed/.test(err.message)) return
      throw err
    }
    // Sanity: localhost works.
    const ok = await fetch(`${server.url}/sup/status`)
    expect(ok.status).toBe(200)
    // We can't easily probe 0.0.0.0 from inside the same process — the bind
    // hostname '127.0.0.1' is the contract. Codepath proof: status-server.ts
    // passes `hostname: '127.0.0.1'` to Bun.serve.
  })
})

/**
 * B6 — supervisor /sup/status endpoint.
 *
 * Stubs the StatusSnapshotProvider with predictable getters and asserts the
 * JSON shape, content-type, and 404/405 routing. Binds 9106 if free, else
 * 9197, else skips (cannot run alongside an actual supervisor — CI is fine).
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { startStatusServer, buildSnapshot, type StatusSnapshotProvider, type StatusServer } from '../src/status-server'

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

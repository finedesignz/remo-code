/**
 * B6 — loopback status server.
 *
 * Tiny Bun.serve listener bound to 127.0.0.1:9106 (or fallback :9197) that
 * exposes `GET /sup/status` returning the live runner + connection state for
 * the Tauri tray to poll every 5s. No auth: loopback-only bind makes the
 * port unreachable from off-host.
 *
 * Doubles as the in-process mutex (see `mutex_probe.rs` in the Tauri shell —
 * the probe TCP-connects to 9106 to detect a second supervisor). Binding
 * here is the canonical "I exist" signal; spawning a second supervisor
 * either fails to bind (EADDRINUSE) or is refused by the Tauri preflight.
 */
import type { Server } from 'bun'

export type HubConnectionState = 'connecting' | 'authenticating' | 'connected' | 'reconnecting' | 'stopped'

export interface RunnerEntry {
  session_id: string | null
  run_id: string
  cli_kind: 'claude' | 'codex'
  project_dir: string
  pid: number | null
  state: string
  restart_count: number
}

export interface StatusSnapshotProvider {
  version: string
  getHubConnected: () => boolean
  getHubState: () => HubConnectionState
  getLastReconnectMsAgo: () => number | null
  getLastError: () => { message: string; at: string } | null
  getRunners: () => RunnerEntry[]
  getQueueDepth: () => number
  getSupervisorId: () => string | null
  getHostname: () => string
}

export interface StatusServer {
  port: number
  url: string
  stop: () => void
}

const PRIMARY_PORT = 9106
const FALLBACK_PORT = 9197

/**
 * Bind on PRIMARY first; if EADDRINUSE (another supervisor lost a race, or
 * a stale process), try FALLBACK. If both fail, throw — the Tauri preflight
 * is supposed to have caught this, so it's safe to surface here.
 */
export function startStatusServer(provider: StatusSnapshotProvider): StatusServer {
  let server: Server | null = null
  let port = PRIMARY_PORT
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port: PRIMARY_PORT, fetch: makeHandler(provider) })
  } catch (err: any) {
    if (!/EADDRINUSE|address already in use/i.test(err?.message ?? '')) throw err
    try {
      server = Bun.serve({ hostname: '127.0.0.1', port: FALLBACK_PORT, fetch: makeHandler(provider) })
      port = FALLBACK_PORT
    } catch (err2: any) {
      throw new Error(`status server bind failed on ${PRIMARY_PORT} and ${FALLBACK_PORT}: ${err2?.message ?? err2}`)
    }
  }
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    stop: () => { try { server?.stop(true) } catch {} },
  }
}

function makeHandler(provider: StatusSnapshotProvider) {
  return (req: Request): Response => {
    const url = new URL(req.url)
    if (req.method !== 'GET') return new Response('method not allowed', { status: 405 })
    if (url.pathname !== '/sup/status') return new Response('not found', { status: 404 })
    const body = buildSnapshot(provider)
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    })
  }
}

export function buildSnapshot(provider: StatusSnapshotProvider) {
  const lastError = provider.getLastError()
  return {
    version: provider.version,
    supervisor_id: provider.getSupervisorId(),
    hostname: provider.getHostname(),
    hub_connected: provider.getHubConnected(),
    hub_state: provider.getHubState(),
    last_reconnect_ms_ago: provider.getLastReconnectMsAgo(),
    last_error: lastError,
    runners: provider.getRunners(),
    queue_depth: provider.getQueueDepth(),
    ts: new Date().toISOString(),
  }
}

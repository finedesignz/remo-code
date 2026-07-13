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

/**
 * Self-healing handle. `healthy` is what the hub sees in `session_inventory`
 * (→ `GET /api/supervisors`): a supervisor with no status server is now VISIBLY
 * degraded instead of silently degraded.
 */
export interface SupervisedStatusServer {
  isHealthy: () => boolean
  getPort: () => number | null
  getLastError: () => string | null
  stop: () => void
}

const PRIMARY_PORT = 9106
const FALLBACK_PORT = 9197

/** Retry curve for a failed bind: 5s → 10s → … capped at 5min, forever. */
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 300_000

/**
 * Does this error mean "the port is taken" (retryable) rather than something
 * structural?
 *
 * fix/headless-autoupdate: this used to test only /EADDRINUSE|address already in
 * use/i — but Bun's actual message is `Failed to start server. Is port 9106 in
 * use?`, which matches NEITHER. So the PRIMARY bind failure rethrew immediately,
 * the FALLBACK port was never even attempted, and index.ts logged one
 * `[status] failed to bind` line and ran on with no status server, forever. On
 * the owner's host a ZOMBIE listener (a dead PID still holding 127.0.0.1:9106)
 * made that permanent: >1 day status-blind, `:9106/sup/status` connection-refused.
 */
export function isPortInUseError(err: unknown): boolean {
  const msg = (err as any)?.message ?? String(err ?? '')
  const code = (err as any)?.code ?? ''
  return (
    code === 'EADDRINUSE' ||
    /EADDRINUSE/i.test(msg) ||
    /address already in use/i.test(msg) ||
    /is port \d+ in use/i.test(msg) ||
    /failed to start server/i.test(msg)
  )
}

/**
 * Bind on PRIMARY first; if the port is taken (another supervisor lost a race, a
 * stale process, or a zombie socket), try FALLBACK. If both fail, throw.
 */
export function startStatusServer(provider: StatusSnapshotProvider): StatusServer {
  let server: Server | null = null
  let port = PRIMARY_PORT
  try {
    server = Bun.serve({ hostname: '127.0.0.1', port: PRIMARY_PORT, fetch: makeHandler(provider) })
  } catch (err: any) {
    if (!isPortInUseError(err)) throw err
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

/**
 * Start the status server and KEEP TRYING if it can't bind.
 *
 * A zombie listener holding 9106 (and/or 9197) can be released later — by the OS
 * reaping the socket, or by whatever held it going away — so a one-shot bind that
 * gives up forever is the wrong shape. We retry on a bounded backoff until we get
 * a listener, and report health in the meantime.
 *
 * We deliberately do NOT try to free the port ourselves: killing a process by
 * name/glob to steal a socket is out of bounds (CLAUDE.md rule 17).
 */
export function startStatusServerSupervised(
  provider: StatusSnapshotProvider,
  opts: {
    log?: (level: 'info' | 'warn' | 'error', msg: string) => void
    retryBaseMs?: number
    retryMaxMs?: number
  } = {},
): SupervisedStatusServer {
  const log = opts.log ?? ((level, msg) => (level === 'info' ? console.log(msg) : console.error(msg)))
  const baseMs = opts.retryBaseMs ?? RETRY_BASE_MS
  const maxMs = opts.retryMaxMs ?? RETRY_MAX_MS

  let server: StatusServer | null = null
  let lastError: string | null = null
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const attemptBind = () => {
    if (stopped || server) return
    try {
      server = startStatusServer(provider)
      lastError = null
      const suffix = attempt > 0 ? ` (recovered after ${attempt} failed attempt${attempt === 1 ? '' : 's'})` : ''
      attempt = 0
      log('info', `[status] listening on ${server.url}/sup/status${suffix}`)
    } catch (err: any) {
      attempt += 1
      lastError = err?.message ?? String(err)
      const delay = Math.min(baseMs * 2 ** (attempt - 1), maxMs)
      log(
        'error',
        `[status] failed to bind (attempt ${attempt}): ${lastError} — ` +
          `supervisor is running DEGRADED (no /sup/status; tray + :9106 probe blind). ` +
          `Retrying in ${Math.round(delay / 1000)}s.`,
      )
      timer = setTimeout(attemptBind, delay)
      // Don't hold the event loop open on account of the retry timer.
      ;(timer as any)?.unref?.()
    }
  }

  attemptBind()

  return {
    isHealthy: () => server !== null,
    getPort: () => server?.port ?? null,
    getLastError: () => lastError,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
      try { server?.stop() } catch {}
      server = null
    },
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

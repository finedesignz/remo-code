// supervisor/src/ws-proxy.ts
// Cloud-host support — route the supervisor's hub WebSockets through the
// standard proxy env vars. Bun's `fetch` honours HTTPS_PROXY on its own, but a
// `WebSocket` only goes through a proxy when one is passed explicitly
// (`new WebSocket(url, { proxy })`). A Claude Code cloud session reaches the
// internet ONLY via HTTPS_PROXY, so without this the supervisor can never open
// /ws/agent there. When no proxy var is set (the normal tray-app host) this
// returns undefined and the constructor call is byte-for-byte what it was.

function envVal(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const n of names) {
    const v = (env[n] ?? '').trim()
    if (v) return v
  }
  return ''
}

/** True when `host` matches a NO_PROXY entry (`*`, exact, or domain suffix). */
export function isNoProxyHost(host: string, noProxy: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of noProxy.split(',')) {
    let entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    entry = entry.replace(/:\d+$/, '')
    if (entry.startsWith('*.')) entry = entry.slice(1)
    if (entry.startsWith('.')) {
      if (h.endsWith(entry) || h === entry.slice(1)) return true
    } else if (h === entry || h.endsWith(`.${entry}`)) {
      return true
    }
  }
  return false
}

/**
 * The proxy URL to use for a WebSocket to `url`, or undefined for a direct
 * connection. wss:// uses HTTPS_PROXY/https_proxy; ws:// uses HTTP_PROXY/http_proxy.
 */
export function wsProxyFor(url: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  let u: URL
  try { u = new URL(url) } catch { return undefined }
  const secure = u.protocol === 'wss:' || u.protocol === 'https:'
  const proxy = secure
    ? envVal(env, 'HTTPS_PROXY', 'https_proxy')
    : envVal(env, 'HTTP_PROXY', 'http_proxy')
  if (!proxy) return undefined
  const noProxy = envVal(env, 'NO_PROXY', 'no_proxy')
  if (noProxy && isNoProxyHost(u.hostname, noProxy)) return undefined
  return proxy
}

/** Construct a WebSocket, going through the env proxy when one applies. */
export function openHubWebSocket(url: string, env: NodeJS.ProcessEnv = process.env): WebSocket {
  const proxy = wsProxyFor(url, env)
  return proxy ? new WebSocket(url, { proxy } as any) : new WebSocket(url)
}

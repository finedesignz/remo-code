/**
 * term-ws.ts — Phase-16 (R-PTY-09) raw-terminal WS client.
 *
 * A focused client for the `term.*` frames on the authenticated /ws/client
 * connection. It mirrors useWebSocket's URL/auth handshake (cookie-first,
 * bearer fallback) but speaks ONLY the raw-terminal channel — it does NOT touch
 * the structured chat protocol. Keys everything by session_id.
 *
 * Frames (web ↔ hub ↔ supervisor PTY host):
 *   out: term.attach / term.reattach / term.input / term.resize
 *   in : term.data (live PTY output) / term.reattach{scrollback} (replay)
 * Byte payloads are base64 (opaque; the hub never parses them).
 */
export interface TermWsHandlers {
  /** Live PTY output bytes (base64-decoded to a string). */
  onData: (bytes: string) => void
  /** Scrollback replay blob on (re)attach (base64-decoded), before live resumes. */
  onScrollback?: (bytes: string) => void
  onOpen?: () => void
  onClose?: () => void
}

function b64encode(s: string): string {
  // UTF-8 safe base64 encode for keystrokes.
  return btoa(unescape(encodeURIComponent(s)))
}
function b64decode(s: string): string {
  try {
    return decodeURIComponent(escape(atob(s)))
  } catch {
    return ''
  }
}

function resolveWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = import.meta.env.VITE_HUB_URL
    ? new URL(import.meta.env.VITE_HUB_URL).host
    : window.location.host
  return `${protocol}//${host}/ws/client`
}

export interface TermWs {
  attach(): void
  reattach(): void
  sendInput(data: string): void
  resize(cols: number, rows: number): void
  close(): void
  readonly connected: boolean
}

/**
 * Open a raw-terminal WS for `sessionId`. `token` is the optional bearer
 * (cookie-auth path sends an empty auth). `wsFactory` is an injectable seam for
 * tests (defaults to the global WebSocket).
 */
export function openTermWs(
  sessionId: string,
  token: string | null,
  handlers: TermWsHandlers,
  wsFactory: (url: string) => WebSocket = (url) => new WebSocket(url),
): TermWs {
  let ws: WebSocket | null = wsFactory(resolveWsUrl())
  let authed = false
  let connected = false
  let closedByCaller = false

  const send = (obj: unknown) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try { ws.send(JSON.stringify(obj)) } catch {}
    }
  }

  ws.onopen = () => {
    connected = true
    // Cookie-first auth: empty payload; bearer only when no cookie session.
    const authMsg: any = { type: 'auth' }
    if (token) authMsg.token = token
    send(authMsg)
  }

  ws.onmessage = (event: MessageEvent) => {
    let msg: any
    try { msg = JSON.parse(event.data) } catch { return }
    if (msg.type === 'auth_ok') {
      authed = true
      // On (re)connect, request attach so the host replays scrollback then
      // resumes live output.
      send({ type: 'term.attach', session_id: sessionId })
      handlers.onOpen?.()
      return
    }
    if (!authed) return
    if (msg.session_id && msg.session_id !== sessionId) return // not our session
    if (msg.type === 'term.data') {
      handlers.onData(b64decode(msg.bytes ?? ''))
    } else if (msg.type === 'term.reattach' && msg.scrollback) {
      handlers.onScrollback?.(b64decode(msg.scrollback))
    }
  }

  ws.onclose = () => {
    connected = false
    ws = null
    if (!closedByCaller) handlers.onClose?.()
  }
  ws.onerror = () => {}

  return {
    attach() { send({ type: 'term.attach', session_id: sessionId }) },
    reattach() { send({ type: 'term.reattach', session_id: sessionId }) },
    sendInput(data: string) { send({ type: 'term.input', session_id: sessionId, bytes: b64encode(data) }) },
    resize(cols: number, rows: number) { send({ type: 'term.resize', session_id: sessionId, cols, rows }) },
    close() { closedByCaller = true; try { ws?.close() } catch {} ; ws = null },
    get connected() { return connected },
  }
}

export const __testing = { b64encode, b64decode, resolveWsUrl }

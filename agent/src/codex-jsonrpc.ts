// JSON-RPC 2.0 client for `codex app-server` over child-process stdio.
//
// SPIKE STATUS (2026-05-25): Codex CLI not verified live on this host.
// Framing assumption A1: newline-delimited JSON. Implementation also
// supports LSP-style `Content-Length:` headers and auto-detects on the
// first non-whitespace byte from stdout. Verify on first live integration
// and trim the unused branch.

import type { Subprocess } from 'bun'

type PendingRequest = {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

export type NotificationHandler = (method: string, params: unknown) => void
export type ErrorHandler = (err: Error) => void

export type Framing = 'ndjson' | 'lsp' | 'unknown'

type FrameOut = {
  frames: string[]
  bufferRest: string
  framing: Framing
}

/** Pure framing parser — exported for tests. */
export function readFrames(buffer: string, framing: Framing): FrameOut {
  let detected = framing
  if (detected === 'unknown') {
    const trimmed = buffer.replace(/^\s+/, '')
    if (!trimmed) return { frames: [], bufferRest: buffer, framing: 'unknown' }
    detected = trimmed.startsWith('Content-Length:') ? 'lsp' : 'ndjson'
  }

  const frames: string[] = []

  if (detected === 'ndjson') {
    const lines = buffer.split('\n')
    const rest = lines.pop() ?? ''
    for (const line of lines) {
      const t = line.trim()
      if (t) frames.push(t)
    }
    return { frames, bufferRest: rest, framing: detected }
  }

  let rest = buffer
  while (true) {
    const headerEnd = rest.indexOf('\r\n\r\n')
    if (headerEnd < 0) break
    const header = rest.slice(0, headerEnd)
    const m = /Content-Length:\s*(\d+)/i.exec(header)
    if (!m) {
      rest = rest.slice(headerEnd + 4)
      continue
    }
    const len = parseInt(m[1]!, 10)
    const bodyStart = headerEnd + 4
    if (rest.length < bodyStart + len) break
    frames.push(rest.slice(bodyStart, bodyStart + len))
    rest = rest.slice(bodyStart + len)
  }
  return { frames, bufferRest: rest, framing: detected }
}

export class JsonRpcClient {
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private notifHandler: NotificationHandler | null = null
  private errorHandler: ErrorHandler | null = null
  private buffer = ''
  private framing: Framing = 'unknown'
  private closed = false

  constructor(private proc: Subprocess) {
    void this.readLoop()
    proc.exited.then((code) => {
      this.fail(new Error(`codex process exited (code ${code})`))
    })
  }

  onNotification(handler: NotificationHandler) { this.notifHandler = handler }
  onError(handler: ErrorHandler) { this.errorHandler = handler }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('client closed'))
    const id = this.nextId++
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write(payload)
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const payload = JSON.stringify({ jsonrpc: '2.0', method, params })
    this.write(payload)
  }

  close() {
    this.closed = true
    this.fail(new Error('client closed'))
  }

  private write(payload: string) {
    try {
      const f = this.framing === 'unknown' ? 'ndjson' : this.framing
      if (f === 'ndjson') {
        this.proc.stdin.write(payload + '\n')
      } else {
        const header = `Content-Length: ${Buffer.byteLength(payload, 'utf8')}\r\n\r\n`
        this.proc.stdin.write(header + payload)
      }
      this.proc.stdin.flush()
    } catch (err: any) {
      this.fail(err)
    }
  }

  private fail(err: Error) {
    if (this.errorHandler) {
      try { this.errorHandler(err) } catch {}
    }
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }

  private async readLoop() {
    const reader = this.proc.stdout.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        const out = readFrames(this.buffer, this.framing)
        this.buffer = out.bufferRest
        this.framing = out.framing
        for (const frame of out.frames) this.dispatch(frame)
      }
    } catch (err: any) {
      this.fail(err)
    }
  }

  private dispatch(frame: string) {
    let msg: any
    try {
      msg = JSON.parse(frame)
    } catch {
      console.error('[codex-jsonrpc] malformed frame:', frame.slice(0, 200))
      return
    }
    if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    if (typeof msg?.method === 'string') {
      this.notifHandler?.(msg.method, msg.params)
    }
  }
}

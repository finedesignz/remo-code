/**
 * claude-pty-bridge.ts — Phase-16 Option C: thin Bun↔Rust PTY byte relay.
 *
 * DECISION GATE (Task 0, 16-SPIKE-FINDINGS-rust-conpty.md): the Rust-ConPTY
 * spike PASSED, so the interactive `claude` PTY is hosted in the Tauri RUST
 * process (`pty_host.rs`), NOT in a Node helper. This module is the thin Bun-side
 * relay: it connects to the Rust host's loopback control socket and ferries RAW
 * TERMINAL BYTES to/from it. The Phase-15 Node `pty-host.mjs` detour is DROPPED on
 * Windows.
 *
 * HARD CONSTRAINTS (interactive-pty-runner-SPEC.md — the actual spawn lives in
 * pty_host.rs which removes ANTHROPIC_API_KEY and uses EMPTY argv; this bridge
 * NEVER adds programmatic flags, NEVER forwards an API key, and NEVER reads
 * ~/.claude/.credentials.json):
 *   1. No ANTHROPIC_API_KEY ever crosses this bridge (it carries opaque bytes).
 *   2. Official `claude` only — spawned by the Rust host; this bridge never spawns.
 *   5. Interactive only — no -p / --print / --input-format / --output-format /
 *      stream-json. Raw bytes only; this module does NOT import RunnerEvent,
 *      agent-protocol, or session-bridge.
 *
 * TRANSPORT: a loopback TCP socket to the Rust host. The host writes its
 * ephemeral port to a token file (REMO_PTY_HOST_PORT_FILE / LOCALAPPDATA default);
 * this bridge reads it. Wire protocol mirrors the Phase-15 framing for
 * continuity: 4-byte big-endian length prefix + UTF-8 JSON; payload bytes are
 * base64 under `d`.
 *
 * DETACH-vs-KILL (R-PTY-27): closing this bridge socket DETACHES — the Rust host
 * keeps the PTY + scrollback alive for a later reattach. `kill()` sends an
 * explicit kill frame; session-close / idle-reap / supervisor-shutdown route
 * through it (or the Rust host's process-ownership teardown on a crash).
 */
import { connect, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve the loopback-port token file the Rust pty_host wrote. */
export function resolvePtyHostPortFile(): string {
  const env = process.env.REMO_PTY_HOST_PORT_FILE
  if (env) return env
  const base =
    process.env.LOCALAPPDATA ||
    process.env.XDG_DATA_HOME ||
    join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.local', 'share')
  return join(base, 'remo-code-supervisor', 'pty-host.port')
}

/** Read the Rust host's loopback port from the token file. Throws if absent. */
export function readPtyHostPort(portFile = resolvePtyHostPortFile()): number {
  const raw = readFileSync(portFile, 'utf8').trim()
  const port = Number(raw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid pty-host port in ${portFile}: ${raw}`)
  }
  return port
}

export interface PtyBridgeOpts {
  /** Stable per-remo-session id — keys the PTY in the Rust host registry. */
  sessionId: string
  /** Which interactive client the Rust host should spawn. Backend-agnostic
   *  selector (Phase-17, R-PTY-12); default 'claude'. The host scrubs EVERY
   *  provider API key regardless of this value. */
  cli?: 'claude' | 'codex'
  cwd: string
  cols?: number
  rows?: number
  /** Live raw PTY output bytes (base64-decoded to a string). */
  onData: (bytes: string) => void
  /** Scrollback replay on (re)attach — emitted BEFORE live `onData` resumes. */
  onScrollback?: (bytes: string) => void
  onExit?: (code: number | null) => void
  /** Override the connect factory (test seam). */
  connectFactory?: (port: number) => Socket
}

/**
 * Thin Bun-side relay to the Rust-hosted interactive `claude` PTY. Raw bytes
 * only — no RunnerEvent translation.
 */
export class ClaudePtyBridge {
  private sock: Socket | null = null
  private acc: Buffer = Buffer.alloc(0)
  private opts: PtyBridgeOpts | null = null
  private killed = false

  /** Connect to the Rust host and (re)attach the PTY for this session. */
  start(opts: PtyBridgeOpts): void {
    this.opts = opts
    this.killed = false
    const port = readPtyHostPort()
    this.sock = opts.connectFactory ? opts.connectFactory(port) : connect({ host: '127.0.0.1', port })
    this.sock.on('data', (chunk: Buffer) => this.onSocketData(chunk))
    this.sock.on('close', () => {
      // Socket closed = DETACH (the Rust host keeps the PTY alive). Only signal
      // onExit if we explicitly killed; a plain disconnect is recoverable.
      if (this.killed) this.opts?.onExit?.(null)
      this.sock = null
    })
    this.sock.on('error', () => {})
    // `spawn` is idempotent in the Rust host: a fresh session spawns; an existing
    // one re-attaches and replays scrollback. So this single frame covers both
    // initial attach and reattach.
    this.sendFrame({
      t: 'spawn',
      session_id: opts.sessionId,
      cli: opts.cli ?? 'claude',
      cwd: opts.cwd,
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
    })
  }

  /** Raw keystrokes from the human terminal → the PTY. */
  write(data: string): void {
    this.sendFrame({ t: 'input', d: Buffer.from(data, 'utf8').toString('base64') })
  }

  resize(cols: number, rows: number): void {
    this.sendFrame({ t: 'resize', cols, rows })
  }

  /** KILL the PTY (session-close / idle-reap / shutdown). Idempotent. */
  kill(): void {
    if (this.killed) return
    this.killed = true
    try { this.sendFrame({ t: 'kill' }) } catch {}
    try { this.sock?.end() } catch {}
  }

  private sendFrame(obj: unknown): void {
    if (!this.sock) return
    const body = Buffer.from(JSON.stringify(obj), 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length, 0)
    try { this.sock.write(Buffer.concat([len, body])) } catch {}
  }

  private onSocketData(chunk: Buffer): void {
    this.acc = Buffer.concat([this.acc, chunk])
    while (this.acc.length >= 4) {
      const len = this.acc.readUInt32BE(0)
      if (this.acc.length < 4 + len) break
      let frame: any
      try {
        frame = JSON.parse(this.acc.subarray(4, 4 + len).toString('utf8'))
      } catch {
        this.acc = this.acc.subarray(4 + len)
        continue
      }
      this.acc = this.acc.subarray(4 + len)
      if (frame.t === 'data') {
        this.opts?.onData(Buffer.from(frame.d ?? '', 'base64').toString('utf8'))
      } else if (frame.t === 'scrollback') {
        const sb = Buffer.from(frame.d ?? '', 'base64').toString('utf8')
        if (this.opts?.onScrollback) this.opts.onScrollback(sb)
        else this.opts?.onData(sb)
      } else if (frame.t === 'exit') {
        this.opts?.onExit?.(frame.code ?? null)
      }
    }
  }
}

/**
 * Codex backend bridge — Phase-17 backend selector (R-PTY-12). Identical relay
 * to ClaudePtyBridge, but pins `cli: 'codex'` so the Rust host spawns the
 * interactive `codex` TUI. Raw bytes only; the host scrubs every provider key.
 */
export class CodexPtyBridge extends ClaudePtyBridge {
  start(opts: PtyBridgeOpts): void {
    super.start({ ...opts, cli: 'codex' })
  }
}

/**
 * Backend selector for the raw-terminal surface. (runner_type='pty-interactive',
 * cli_kind='codex') → CodexPtyBridge; cli_kind='claude' → ClaudePtyBridge. The
 * single seam Phase-17 routing keys off (mirrors the Option-A runner selector).
 */
export function selectPtyBridge(cliKind: 'claude' | 'codex'): ClaudePtyBridge {
  return cliKind === 'codex' ? new CodexPtyBridge() : new ClaudePtyBridge()
}

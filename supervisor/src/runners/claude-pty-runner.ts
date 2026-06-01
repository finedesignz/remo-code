/**
 * claude-pty-runner.ts — Phase-15 seed of the interactive PTY runner.
 *
 * Spawns the GENUINE interactive `claude` TUI inside a node-pty PTY and relays
 * RAW TERMINAL BYTES only. This module is the seed of the Phase-16 production
 * runner; it is NOT throwaway.
 *
 * HARD CONSTRAINTS (interactive-pty-runner-SPEC.md — do not regress; enforced
 * by supervisor/test/{no-api-key-no-streamjson-pty,pty-spawn-interception}.test.ts):
 *   1. NO ANTHROPIC_API_KEY ever reaches the spawned `claude`. Deleted both
 *      here (defense in depth) and in pty-host.mjs. No API-key fallback exists.
 *   2. Official `claude` binary only. We never read, store, or forward the
 *      OAuth token in ~/.claude/.credentials.json — auth is the client's job.
 *   5. Interactive `claude` ONLY: argv is EMPTY. NO -p / --print /
 *      --input-format / --output-format / stream-json. This module emits RAW
 *      BYTES and MUST NOT translate to the structured RunnerEvent union, import
 *      agent-protocol, or import session-bridge.
 *
 * ARCHITECTURE (Phase-15 derisk verdict — see 15-SPIKE-FINDINGS.md):
 *   node-pty cannot be driven from Bun on Windows (its node:net named-pipe
 *   Sockets throw ERR_SOCKET_CLOSED under Bun, though the prebuilt binary loads
 *   fine). So this runner — running in the Bun sidecar — spawns a small NODE
 *   helper process (pty-host.mjs) that hosts the PTY and speaks a length-
 *   prefixed JSON-frame protocol over stdio. The runner never touches node-pty
 *   directly; it speaks frames to the host.
 *
 * Reused by Phases 16 (productionize + tmux persistence), 17 (Codex PTY +
 * ChatSurface deletion), 19 (cutover). The ptySpawn factory seam below is the
 * mockable boundary the behavioral spawn-interception harness drives.
 */
import { spawn as nodeChildSpawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/** Resolved path to the Node PTY host script, relative to THIS module. */
const HOST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'pty-host.mjs')

/**
 * Injectable spawn factory — the seam the behavioral harness (R-PTY-26 / H6)
 * intercepts. It captures the REAL { file, argv, env } the runner spawns the
 * PTY host with. NOT re-exported from any runtime entrypoint; test-only
 * override via `__setHostSpawnForTest`.
 */
export type HostSpawn = (file: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => HostHandle

/** Minimal handle surface the runner needs from the spawned host process. */
export interface HostHandle {
  pid: number | undefined
  stdin: { write(chunk: Buffer | string): void } | null
  stdout: { on(ev: 'data', cb: (chunk: Buffer) => void): void } | null
  on(ev: 'exit', cb: (code: number | null) => void): void
  kill(): void
}

function realHostSpawn(file: string, argv: string[], opts: { env: NodeJS.ProcessEnv }): HostHandle {
  const cp: ChildProcess = nodeChildSpawn(file, argv, {
    env: opts.env,
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  })
  return {
    pid: cp.pid,
    stdin: cp.stdin ? { write: (c) => { cp.stdin!.write(c) } } : null,
    stdout: cp.stdout ? { on: (_e, cb) => cp.stdout!.on('data', cb) } : null,
    on: (_e, cb) => cp.on('exit', (code) => cb(code)),
    kill: () => { try { cp.kill() } catch {} },
  }
}

let hostSpawn: HostSpawn = realHostSpawn

/** TEST-ONLY. Override the host spawn factory; returns a restore fn. Never
 *  re-exported from the package entrypoint and never called by runtime code. */
export function __setHostSpawnForTest(fn: HostSpawn): () => void {
  const prev = hostSpawn
  hostSpawn = fn
  return () => { hostSpawn = prev }
}

export interface PtyRunnerOpts {
  cwd: string
  cols?: number
  rows?: number
  onData: (bytes: string) => void
  onExit?: (code: number | null) => void
}

/** Build the env handed to the PTY host. Exported pure helper so the env-strip
 *  (constraint 1) is unit-testable without spawning. */
export function buildPtyHostEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base }
  // CONSTRAINT 1 — never let an API key reach the client. Defense in depth:
  // pty-host.mjs deletes it again before the real `claude` spawn.
  delete (env as any).ANTHROPIC_API_KEY
  return env
}

/**
 * Interactive `claude` PTY runner. Raw bytes only — no RunnerEvent.
 */
export class ClaudePtyRunner {
  private host: HostHandle | null = null
  private acc: Buffer = Buffer.alloc(0)
  private opts: PtyRunnerOpts | null = null
  private killed = false

  /** Spawn the Node PTY host, then ask it to spawn interactive `claude`. */
  start(opts: PtyRunnerOpts): void {
    this.opts = opts
    this.killed = false
    const env = buildPtyHostEnv()
    // The host runs under Node (see module header). argv to the host = [HOST_PATH].
    this.host = hostSpawn('node', [HOST_PATH], { env })
    this.host.stdout?.on('data', (chunk) => this.onHostData(chunk))
    this.host.on('exit', (code) => { this.opts?.onExit?.(code); this.host = null })
    // CONSTRAINT 5 — file 'claude', argv EMPTY. No programmatic flags. EVER.
    this.sendFrame({ t: 'spawn', file: 'claude', args: [], cwd: opts.cwd, cols: opts.cols ?? 80, rows: opts.rows ?? 24 })
  }

  /** Raw keystrokes from the human terminal → the PTY. */
  write(data: string): void {
    this.sendFrame({ t: 'input', d: data })
  }

  resize(cols: number, rows: number): void {
    this.sendFrame({ t: 'resize', cols, rows })
  }

  /** Idempotent. Kills the PTY child and the host. Bound to teardown/disconnect/
   *  shutdown by the supervisor (R-PTY-27 / H7). */
  kill(): void {
    if (this.killed) return
    this.killed = true
    try { this.sendFrame({ t: 'kill' }) } catch {}
    try { this.host?.kill() } catch {}
    this.host = null
  }

  get pid(): number | undefined { return this.host?.pid }

  private sendFrame(obj: unknown): void {
    if (!this.host?.stdin) return
    const buf = Buffer.from(JSON.stringify(obj), 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(buf.length, 0)
    this.host.stdin.write(Buffer.concat([len, buf]))
  }

  private onHostData(chunk: Buffer): void {
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
      if (frame.t === 'data') this.opts?.onData(frame.d)
      else if (frame.t === 'exit') this.opts?.onExit?.(frame.code ?? null)
    }
  }
}

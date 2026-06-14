/**
 * codex-pty-runner.ts — Phase-17 Codex interactive PTY runner.
 *
 * Spawns the GENUINE interactive `codex` TUI inside a node-pty PTY and relays
 * RAW TERMINAL BYTES only. A near-verbatim mirror of claude-pty-runner.ts
 * (Phase-15/16) with the spawned binary swapped to the interactive Codex CLI.
 * It proves the raw-terminal surface is BACKEND-AGNOSTIC before the Phase-17
 * deletions.
 *
 * HARD CONSTRAINTS (interactive-pty-runner-SPEC.md — do not regress; enforced
 * by supervisor/test/{no-api-key-no-streamjson-pty,codex-pty-runner-env}.test.ts):
 *   1. NO provider API key ever reaches the spawned `codex`. We delete BOTH
 *      OPENAI_API_KEY (Codex's provider key) and ANTHROPIC_API_KEY on the spawn
 *      path. No API-key fallback exists — auth is the Codex client's job
 *      (`codex login`).
 *   2. Official `codex` binary only. We never read, store, or forward the OAuth
 *      token / credentials of either client.
 *   3. Human-only: this runner only ever sees genuine human keystrokes; it rides
 *      the Phase-16 human-only dispatch guard (runner_type='pty-interactive').
 *      Automation never touches the PTY.
 *   5. Interactive `codex` ONLY: argv is an ALLOWLIST OF ONE — empty, except for
 *      the optional operator-blessed `--dangerously-skip-permissions` permission
 *      flag (gated by config `allowDangerousSkipPermissions`). NO programmatic/
 *      headless flags (no `app-server`, `exec`, `-p`, `--print`, `--input-format`,
 *      `--output-format`, `stream-json` — those belong to the PRESERVED
 *      automation path, never the PTY). This module emits RAW BYTES and MUST NOT
 *      translate to the structured RunnerEvent union, import agent-protocol, or
 *      import session-bridge.
 *
 * ARCHITECTURE: identical to claude-pty-runner.ts — the runner runs in the Bun
 * sidecar and spawns a small NODE helper process (pty-host.mjs) that hosts the
 * PTY and speaks a length-prefixed JSON-frame protocol over stdio. On Windows
 * the production byte path is the Rust-ConPTY host (Option C, pty_host.rs) which
 * selects the binary by the spawn frame's `cli` field; this Node-host runner is
 * the portable Option-A mirror + the mockable seam the spawn-interception
 * harness drives.
 */
import { spawn as nodeChildSpawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { sanitizeSpawnEnv } from './env-sanitize'

/** Resolved path to the Node PTY host script, relative to THIS module. */
const HOST_PATH = join(dirname(fileURLToPath(import.meta.url)), 'pty-host.mjs')

/**
 * Injectable spawn factory — the seam the behavioral harness intercepts. It
 * captures the REAL { file, argv, env } the runner spawns the PTY host with.
 * NOT re-exported from any runtime entrypoint; test-only override via
 * `__setCodexHostSpawnForTest`.
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
export function __setCodexHostSpawnForTest(fn: HostSpawn): () => void {
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
  /** Operator-gated bypass (config `allowDangerousSkipPermissions`). When true,
   *  appends the SOLE permitted argv token `--dangerously-skip-permissions`. */
  dangerouslySkipPermissions?: boolean
}

/** Build the env handed to the PTY host for a Codex session. Exported pure
 *  helper so the env-strip (constraint 1) is unit-testable without spawning.
 *  CONSTRAINT 1 — never let a provider API key reach the client. We strip BOTH
 *  OPENAI_API_KEY (Codex's key) and ANTHROPIC_API_KEY (defense in depth so a
 *  mixed env can never leak a key onto the Codex spawn path). */
export function buildCodexPtyHostEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // The shared sanitizer scrubs the full provider-key denylist (incl.
  // OPENAI_API_KEY + ANTHROPIC_API_KEY) + credential-class patterns from the
  // RESOLVED env (incl. inherited process.env vars). Codex auth = `codex login`
  // (ChatGPT subscription sign-in), never an API key.
  return sanitizeSpawnEnv(base)
}

/**
 * Interactive `codex` PTY runner. Raw bytes only — no RunnerEvent.
 */
export class CodexPtyRunner {
  private host: HostHandle | null = null
  private acc: Buffer = Buffer.alloc(0)
  private opts: PtyRunnerOpts | null = null
  private killed = false

  /** Spawn the Node PTY host, then ask it to spawn interactive `codex`. */
  start(opts: PtyRunnerOpts): void {
    this.opts = opts
    this.killed = false
    const env = buildCodexPtyHostEnv()
    this.host = hostSpawn('node', [HOST_PATH], { env })
    this.host.stdout?.on('data', (chunk) => this.onHostData(chunk))
    this.host.on('exit', (code) => { this.opts?.onExit?.(code); this.host = null })
    // CONSTRAINT 5 — file 'codex'. argv is an allowlist-of-one: empty, plus the
    // optional operator-blessed --dangerously-skip-permissions. No programmatic/headless flags. EVER.
    const args = opts.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []
    this.sendFrame({ t: 'spawn', file: 'codex', args, cwd: opts.cwd, cols: opts.cols ?? 80, rows: opts.rows ?? 24 })
  }

  /** Raw keystrokes from the human terminal → the PTY. */
  write(data: string): void {
    this.sendFrame({ t: 'input', d: data })
  }

  resize(cols: number, rows: number): void {
    this.sendFrame({ t: 'resize', cols, rows })
  }

  /** Idempotent. Kills the PTY child and the host. Bound to teardown/disconnect/
   *  shutdown by the supervisor. */
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

#!/usr/bin/env bun
import { loadConfig, parseRoots, getConfigPath } from './config'
import { SupervisorClient } from './hub-client'
import { scanAll } from './repo-scanner'
import { existsSync, mkdirSync, renameSync, statSync, createWriteStream, type WriteStream } from 'fs'
import { join } from 'path'
import { homedir, hostname } from 'os'
import { startStatusServerSupervised, type SupervisedStatusServer } from './status-server'
import { VERSION } from './version'
import { isBrokenPipe, installStreamErrorGuards, makeSafeTee } from './safe-logging'
import { ClaudePtyRunner } from './runners/claude-pty-runner'
import { CodexPtyRunner } from './runners/codex-pty-runner'
// Phase-19 gated human-backend selection lives in runner-factory (no side-effects).
export { runnerForHumanBackend, selectHumanPtyRunner } from './runners/runner-factory'

/**
 * Backend selector for the interactive raw-terminal surface (Phase-17,
 * R-PTY-12). For runner_type='pty-interactive': cli_kind='codex' instantiates
 * the CodexPtyRunner, cli_kind='claude' the ClaudePtyRunner. Both are raw-bytes-
 * only and ride the Phase-16 human-only dispatch guard — automation never
 * reaches either. The runner_type='stream-json' automation path is untouched
 * (it uses ClaudeRunner + session-bridge, NOT these PTY runners).
 *
 * On Windows the live byte path is the Rust-ConPTY host (Option C); its mirror
 * selector is `selectPtyBridge` in runners/claude-pty-bridge.ts. This Option-A
 * selector is the portable mirror + the seam the spawn-interception harness
 * drives.
 */
export function selectPtyRunner(cliKind: 'claude' | 'codex'): ClaudePtyRunner | CodexPtyRunner {
  return cliKind === 'codex' ? new CodexPtyRunner() : new ClaudePtyRunner()
}

function logDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(base, 'remo-code-supervisor')
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'remo-code-supervisor')
}

/** B6: the active log stream so callers (beforeExit) can flush + close. */
let fileLogStream: WriteStream | null = null

/** Install 'error' listeners on the std streams so a broken pipe to a dead
 *  parent surfaces as a swallowed event instead of an uncaughtException.
 *  Installed as early as possible (before any heavy logging). Idempotent. */
let stdStreamGuardsInstalled = false
function installStdStreamErrorGuards(): void {
  if (stdStreamGuardsInstalled) return
  stdStreamGuardsInstalled = true
  installStreamErrorGuards([process.stdout, process.stderr])
}

function setupFileLogging(): WriteStream | null {
  // Guard the std streams FIRST — a broken pipe from the very first console
  // write below must not become an uncaughtException.
  installStdStreamErrorGuards()
  try {
    const dir = logDir()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const logPath = join(dir, 'supervisor.log')
    const prevPath = join(dir, 'supervisor.log.1')
    if (existsSync(logPath)) {
      try {
        const sz = statSync(logPath).size
        if (sz > 5 * 1024 * 1024) {
          if (existsSync(prevPath)) { try { require('fs').unlinkSync(prevPath) } catch {} }
          renameSync(logPath, prevPath)
        }
      } catch {}
    }
    const stream = createWriteStream(logPath, { flags: 'a' })
    // Guard the file stream too — a disk/rotation error must not crash either.
    try { stream.on('error', () => {}) } catch {}
    fileLogStream = stream
    const fileWrite = (line: string) => { stream.write(line) }
    const tee = (orig: (...a: any[]) => void, level: string) => makeSafeTee(orig, level, fileWrite)
    console.log = tee(console.log.bind(console), 'INFO')
    console.error = tee(console.error.bind(console), 'ERROR')
    console.warn = tee(console.warn.bind(console), 'WARN')
    console.log(`[log] writing to ${logPath} (rotates at 5MB → supervisor.log.1)`)
    return stream
  } catch (err: any) {
    console.error(`[log] file logging unavailable: ${err.message}`)
    return null
  }
}

/** B6: stream.end() on graceful exit so we don't lose up to 64KB of
 *  pending log lines (supervisor-audit). Registered via `beforeExit` plus
 *  the SIGINT/SIGTERM handlers in main(). Idempotent. */
function flushFileLogging(): void {
  const s = fileLogStream
  if (!s) return
  fileLogStream = null
  try { s.end() } catch {}
}

function parseArgs(argv: string[]): { cmd: string; flags: Record<string, string | boolean> } {
  const cmd = argv[0] || 'help'
  const flags: Record<string, string | boolean> = {}
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      if (a.includes('=')) {
        const [k, ...v] = a.split('=')
        flags[k.slice(2)] = v.join('=')
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[a.slice(2)] = argv[++i]
      } else {
        flags[a.slice(2)] = true
      }
    }
  }
  return { cmd, flags }
}

function printHelp() {
  console.log(`remo-code-supervisor v${VERSION}

This binary is the runtime spawned by the Remo Code tray app
(supervisor/tauri/). It is no longer distributed as a stand-alone CLI.

Subcommands (for diagnostics / sidecar use only):
  run                              # foreground supervisor (invoked by the Tauri sidecar)
  scan                             # one-shot: list discovered repos under configured roots
  help                             # this message

Distribution:
  Download the Remo Code tray app .msi from
  https://github.com/finedesignz/remo-code/releases/latest
  The tray app bundles this runtime as a managed sidecar.

Config file: ${getConfigPath()}
`)
}

async function main() {
  const { cmd } = parseArgs(process.argv.slice(2))

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp(); return
  }

  if (cmd === 'scan') {
    const cfg = loadConfig()
    const repos = scanAll(cfg.roots)
    console.log(JSON.stringify(repos, null, 2))
    return
  }

  if (cmd === 'run') {
    setupFileLogging()
    const cfg = loadConfig()
    console.log(`[run] remo-code-supervisor v${VERSION}`)
    console.log(`[run] hub=${cfg.hubUrl} roots=${cfg.roots.length}`)
    const client = new SupervisorClient(cfg)
    client.connect()

    // B6: loopback status server (also serves as the in-process mutex —
    // mutex_probe.rs TCP-connects to 127.0.0.1:9106 to detect duplicate
    // supervisors). Single GET /sup/status, no auth — loopback bind makes
    // it unreachable from off-host.
    //
    // fix/headless-autoupdate: this is SUPERVISED now. A failed bind used to log
    // one line and give up forever — with a zombie listener squatting on 9106
    // (a dead PID still holding the socket), the owner's supervisor ran
    // status-blind for >1 day and nothing ever surfaced it. It now retries on a
    // backoff until the port frees up, and its health rides the
    // `session_inventory` frame so the hub can show the supervisor as degraded.
    const statusServer: SupervisedStatusServer = startStatusServerSupervised({
      version: VERSION,
      getHubConnected: () => client.isHubConnected(),
      getHubState: () => client.getHubState(),
      getLastReconnectMsAgo: () => client.getLastReconnectMsAgo(),
      getLastError: () => client.getLastError(),
      getRunners: () => client.getRunnersSnapshot(),
      getQueueDepth: () => client.getRunnersSnapshot().length,
      getSupervisorId: () => client.getSupervisorId(),
      getHostname: () => hostname(),
    })
    client.setStatusServerHealthProvider(() => ({
      healthy: statusServer.isHealthy(),
      port: statusServer.getPort(),
      last_error: statusServer.getLastError(),
    }))

    // B6: crash capture. POST uncaughtException + unhandledRejection to the
    // hub's Sentry intake using the per-host sentry_key planted by
    // supervisor.hello_ack. Log-only on failure — we're already in a fatal
    // path and must never throw inside a fatal handler.
    process.on('uncaughtException', (err) => {
      // A broken stdout/stderr pipe (dead parent tray) must degrade logging to
      // file-only and NEVER crash/exit — and must not spam the crash intake.
      if (isBrokenPipe(err)) {
        try { fileLogStream?.write(`${new Date().toISOString()} WARN [pipe] swallowed broken-pipe uncaughtException: ${err.message}\n`) } catch {}
        return
      }
      console.error('uncaughtException:', err.stack || err.message)
      try {
        void client.postCrashEnvelope({ name: err.name, message: err.message, stack: err.stack })
      } catch {}
    })
    process.on('unhandledRejection', (reason: any) => {
      const msg = reason?.stack || reason?.message || String(reason)
      console.error('unhandledRejection:', msg)
      try {
        void client.postCrashEnvelope({
          name: reason?.name || 'UnhandledRejection',
          message: reason?.message || String(reason),
          stack: reason?.stack,
        })
      } catch {}
    })

    // B6: drain the file logger on shutdown so we don't lose buffered lines.
    process.on('beforeExit', () => { flushFileLogging() })
    process.on('SIGINT', () => {
      console.log('shutting down')
      statusServer?.stop()
      flushFileLogging()
      process.exit(0)
    })
    process.on('SIGTERM', () => {
      console.log('shutting down')
      statusServer?.stop()
      flushFileLogging()
      process.exit(0)
    })
    // Keep alive
    await new Promise(() => {})
    return
  }

  console.error(`unknown command: ${cmd}`)
  console.error(`(note: install/uninstall/status were removed in v0.3.1 — the tray app at`)
  console.error(`https://github.com/finedesignz/remo-code/releases/latest is now the sole installer)`)
  printHelp()
  process.exit(1)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})

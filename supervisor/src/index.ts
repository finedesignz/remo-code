#!/usr/bin/env bun
import { loadConfig, parseRoots, CONFIG_PATH } from './config'
import { SupervisorClient } from './hub-client'
import { scanAll } from './repo-scanner'
import { existsSync, mkdirSync, renameSync, statSync, createWriteStream, type WriteStream } from 'fs'
import { join } from 'path'
import { homedir, hostname } from 'os'
import { startStatusServer, type StatusServer } from './status-server'

// Keep in sync with supervisor/tauri/src-tauri/tauri.conf.json version
const VERSION = '0.5.8'

function logDir(): string {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(base, 'remo-code-supervisor')
  }
  return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'remo-code-supervisor')
}

/** B6: the active log stream so callers (beforeExit) can flush + close. */
let fileLogStream: WriteStream | null = null

function setupFileLogging(): WriteStream | null {
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
    fileLogStream = stream
    const tee = (orig: (...a: any[]) => void, level: string) => (...args: any[]) => {
      orig(...args)
      try {
        const line = args.map((a) => typeof a === 'string' ? a : (a instanceof Error ? (a.stack || a.message) : JSON.stringify(a))).join(' ')
        stream.write(`${new Date().toISOString()} ${level} ${line}\n`)
      } catch {}
    }
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

Config file: ${CONFIG_PATH}
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
    let statusServer: StatusServer | null = null
    try {
      statusServer = startStatusServer({
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
      console.log(`[status] listening on ${statusServer.url}/sup/status`)
    } catch (err: any) {
      console.error(`[status] failed to bind: ${err.message}`)
    }

    // B6: crash capture. POST uncaughtException + unhandledRejection to the
    // hub's Sentry intake using the per-host sentry_key planted by
    // supervisor.hello_ack. Log-only on failure — we're already in a fatal
    // path and must never throw inside a fatal handler.
    process.on('uncaughtException', (err) => {
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

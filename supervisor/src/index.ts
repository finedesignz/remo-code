#!/usr/bin/env bun
import { loadConfig, saveConfig, parseRoots, CONFIG_PATH } from './config'
import { SupervisorClient } from './hub-client'
import { installService, uninstallService, statusService, SERVICE_NAME } from './nssm-installer'
import { scanAll } from './repo-scanner'

const VERSION = '0.2.0'

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

Usage:
  npx remo-code-supervisor install --api-key <olx_...> [--roots <paths>] [--hub-url <url>] [--service-user <user> --service-password <pwd>]
  npx remo-code-supervisor uninstall
  npx remo-code-supervisor run                     # foreground (used by the Windows service)
  npx remo-code-supervisor status
  npx remo-code-supervisor scan                    # one-shot: list discovered repos

Notes:
  - --roots is comma- or semicolon-separated; e.g. "C:\\Users\\artic\\GitHub"
  - On Windows, install creates an NSSM-backed service that auto-starts at boot.
    Provide --service-user (e.g. .\\artic) and --service-password to run the
    service as your own Windows user so SSH keys, gh auth, and ~/.config remain reachable.
  - Config file: ${CONFIG_PATH}
`)
}

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2))

  if (cmd === 'help' || cmd === '-h' || cmd === '--help') {
    printHelp(); return
  }

  if (cmd === 'install') {
    const apiKey = (flags['api-key'] as string) || ''
    if (!apiKey) { console.error('error: --api-key required'); process.exit(1) }
    const hubUrl = (flags['hub-url'] as string) || undefined
    const roots = parseRoots(flags['roots'] as string | undefined)
    saveConfig({ apiKey, hubUrl, roots })
    console.log(`[install] config saved to ${CONFIG_PATH}`)
    const serviceUser = flags['service-user'] as string | undefined
    const servicePassword = flags['service-password'] as string | undefined
    try {
      await installService({ apiKey, hubUrl, roots, serviceUser, servicePassword })
    } catch (err: any) {
      console.error(`[install] ${err.message}`)
      console.error(`[install] You can still run the supervisor manually with: npx remo-code-supervisor run`)
      process.exit(2)
    }
    return
  }

  if (cmd === 'uninstall') {
    await uninstallService()
    return
  }

  if (cmd === 'status') {
    const s = await statusService().catch(() => 'unknown')
    console.log(`service: ${s}`)
    console.log(`config:  ${CONFIG_PATH}`)
    return
  }

  if (cmd === 'scan') {
    const cfg = loadConfig()
    const repos = scanAll(cfg.roots)
    console.log(JSON.stringify(repos, null, 2))
    return
  }

  if (cmd === 'run') {
    const cfg = loadConfig()
    console.log(`[run] remo-code-supervisor v${VERSION}`)
    console.log(`[run] hub=${cfg.hubUrl} roots=${cfg.roots.length}`)
    const client = new SupervisorClient(cfg)
    client.connect()
    process.on('SIGINT', () => { console.log('shutting down'); process.exit(0) })
    process.on('SIGTERM', () => { console.log('shutting down'); process.exit(0) })
    // Keep alive
    await new Promise(() => {})
    return
  }

  console.error(`unknown command: ${cmd}`)
  printHelp()
  process.exit(1)
}

main().catch((err) => {
  console.error('fatal:', err.message)
  process.exit(1)
})

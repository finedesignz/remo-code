import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface AgentConfig {
  hubUrl: string
  apiKey: string
  projectDir: string
}

const CONFIG_PATH = join(homedir(), '.config', 'remo-code', 'config.json')

export function loadConfig(): AgentConfig {
  const args = parseArgs(process.argv.slice(2))

  // CLI args take priority
  let hubUrl = args['--hub-url'] || process.env.REMO_HUB_URL || ''
  let apiKey = args['--api-key'] || process.env.REMO_API_KEY || ''

  // Fall back to config file
  if ((!hubUrl || !apiKey) && existsSync(CONFIG_PATH)) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
      hubUrl = hubUrl || file.hub_url || ''
      apiKey = apiKey || file.api_key || ''
    } catch {}
  }

  if (!hubUrl || !apiKey) {
    console.error('Missing hub_url or api_key. Provide via:')
    console.error('  --hub-url and --api-key flags')
    console.error('  REMO_HUB_URL and REMO_API_KEY env vars')
    console.error(`  ${CONFIG_PATH}`)
    process.exit(1)
  }

  const projectDir = args['--project-dir'] || process.cwd()

  return { hubUrl, apiKey, projectDir }
}

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i].includes('=')) {
      const [key, ...rest] = argv[i].split('=')
      result[key] = rest.join('=')
    } else if (argv[i].startsWith('--') && i + 1 < argv.length) {
      result[argv[i]] = argv[i + 1]
      i++
    }
  }
  return result
}

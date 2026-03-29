import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface AgentConfig {
  hubUrl: string
  apiKey: string
  projectDir: string
  localOutput: boolean
}

const CONFIG_PATH = join(homedir(), '.config', 'remo-code', 'config.json')

const DEFAULT_HUB_URL = 'https://app.remo-code.com'

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

  // Default hub URL if still not set
  hubUrl = hubUrl || DEFAULT_HUB_URL

  if (!apiKey) {
    console.error('')
    console.error('  Remo Code Agent - Missing API key')
    console.error('')
    console.error('  Provide your API key via one of:')
    console.error('    npx remo-code-agent --api-key remokey_xxx')
    console.error('    REMO_API_KEY=remokey_xxx npx remo-code-agent')
    console.error(`    ${CONFIG_PATH}  (JSON: { "api_key": "remokey_xxx" })`)
    console.error('')
    console.error('  Get your API key at https://app.remo-code.com/settings')
    console.error('')
    process.exit(1)
  }

  const projectDir = args['--project-dir'] || process.cwd()
  const localOutput = '--local-output' in args || process.env.REMO_LOCAL_OUTPUT === '1'

  return { hubUrl, apiKey, projectDir, localOutput }
}

function parseArgs(argv: string[]): Record<string, string> {
  const booleanFlags = new Set(['--local-output'])
  const result: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i].includes('=')) {
      const [key, ...rest] = argv[i].split('=')
      result[key] = rest.join('=')
    } else if (booleanFlags.has(argv[i])) {
      result[argv[i]] = 'true'
    } else if (argv[i].startsWith('--') && i + 1 < argv.length) {
      result[argv[i]] = argv[i + 1]
      i++
    }
  }
  return result
}

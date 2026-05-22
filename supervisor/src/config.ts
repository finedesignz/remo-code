import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, platform } from 'os'

export interface SupervisorConfig {
  hubUrl: string
  apiKey: string
  roots: string[]
  maxConcurrent: number
}

function defaultConfigDir(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'remo-code')
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdg, 'remo-code')
}

export const CONFIG_DIR = defaultConfigDir()
export const CONFIG_PATH = join(CONFIG_DIR, 'supervisor.json')
const DEFAULT_HUB_URL = 'https://app.remo-code.com'

export function loadConfig(): SupervisorConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Supervisor not configured. Run: npx remo-code-supervisor install --api-key <olx_...>`)
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  if (!raw.api_key) throw new Error('config missing api_key')
  return {
    hubUrl: raw.hub_url || DEFAULT_HUB_URL,
    apiKey: raw.api_key,
    roots: raw.roots || [],
    maxConcurrent: raw.max_concurrent || 1,
  }
}

export function saveConfig(cfg: Partial<SupervisorConfig> & { apiKey: string }) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const existing = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) : {}
  const merged = {
    ...existing,
    api_key: cfg.apiKey,
    hub_url: cfg.hubUrl || existing.hub_url || DEFAULT_HUB_URL,
    roots: cfg.roots || existing.roots || [],
    max_concurrent: cfg.maxConcurrent || existing.max_concurrent || 1,
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8')
}

export function parseRoots(input: string | undefined): string[] {
  if (!input) return []
  return input.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

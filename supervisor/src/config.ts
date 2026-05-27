import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, platform } from 'os'

/**
 * Phase 08 §15 — scan settings used by `repo-scanner.scanRoots`.
 * Defaults: max_depth=2, sensible ignore_globs, no symlink follow.
 */
export interface ScanSettings {
  max_depth: number
  ignore_globs: string[]
  follow_symlinks: boolean
}

export const DEFAULT_SCAN_SETTINGS: ScanSettings = {
  max_depth: 2,
  ignore_globs: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/target/**'],
  follow_symlinks: false,
}

export interface SupervisorConfig {
  hubUrl: string
  apiKey: string
  roots: string[]
  maxConcurrent: number
  /** HARD CAP — when false, `--dangerously-skip-permissions` is stripped from every spawn regardless of hub request. */
  allowDangerousSkipPermissions: boolean
  /** When true, `run.start` is rejected unless `<repoPath>/.git` exists. */
  requireGitRepo: boolean
  /** When true (default), every start decision is appended to `auditLogPath`. */
  auditLogEnabled: boolean
  /** Absolute path to the JSONL audit log. Default: `%LOCALAPPDATA%\remo-code-supervisor\audit.jsonl`. */
  auditLogPath: string
  /** Display-only kill-switch hotkey (Tauri shell binds it). */
  killSwitchHotkey: string
  /** Tauri autostart toggle (mirrored to plugin). */
  autostart: boolean
  /** Phase 08 §15 — scan settings for `repo-scanner`. */
  scan: ScanSettings
  /** Phase 08 §15 — ISO timestamp of the most recent scan; null when never scanned. */
  lastScanAt: string | null
}

function defaultConfigDir(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'remo-code')
  }
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdg, 'remo-code')
}

function defaultAuditLogPath(): string {
  if (platform() === 'win32') {
    const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return join(local, 'remo-code-supervisor', 'audit.jsonl')
  }
  return join(homedir(), '.local', 'share', 'remo-code-supervisor', 'audit.jsonl')
}

export const CONFIG_DIR = defaultConfigDir()
export const CONFIG_PATH = join(CONFIG_DIR, 'supervisor.json')
const DEFAULT_HUB_URL = 'https://app.remo-code.com'
const DEFAULT_KILL_SWITCH_HOTKEY = 'Ctrl+Shift+Alt+K'

/** Phase 08 §15 — explicit accessor for the resolved supervisor.json path. */
export function getConfigPath(): string {
  return CONFIG_PATH
}

function readScanFromRaw(raw: any): ScanSettings {
  const s = raw?.scan ?? {}
  return {
    max_depth: typeof s.max_depth === 'number' && s.max_depth > 0 ? s.max_depth : DEFAULT_SCAN_SETTINGS.max_depth,
    ignore_globs: Array.isArray(s.ignore_globs) ? s.ignore_globs.map(String) : DEFAULT_SCAN_SETTINGS.ignore_globs,
    follow_symlinks: s.follow_symlinks === true,
  }
}

export function loadConfig(): SupervisorConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`Supervisor not configured. Open the Remo Code tray app and complete the first-run setup (or write ${CONFIG_PATH} manually).`)
  }
  const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  if (!raw.api_key) throw new Error('config missing api_key')
  return {
    hubUrl: raw.hub_url || DEFAULT_HUB_URL,
    apiKey: raw.api_key,
    roots: raw.roots || [],
    maxConcurrent: raw.max_concurrent || 1,
    allowDangerousSkipPermissions: raw.allow_dangerous_skip_permissions === true,
    requireGitRepo: raw.require_git_repo === true,
    auditLogEnabled: raw.audit_log_enabled !== false, // default TRUE
    auditLogPath: raw.audit_log_path || defaultAuditLogPath(),
    killSwitchHotkey: raw.kill_switch_hotkey || DEFAULT_KILL_SWITCH_HOTKEY,
    autostart: raw.autostart !== false, // default TRUE
    scan: readScanFromRaw(raw),
    lastScanAt: typeof raw.last_scan_at === 'string' ? raw.last_scan_at : null,
  }
}

/**
 * Phase 08 §15 — defaults used when `supervisor.json` is absent. Callers that
 * need a config object before first-run (e.g. the welcome window backing
 * Tauri) can use this without throwing. The api_key/hub_url are intentionally
 * empty — `loadConfig()` still throws on a missing file in normal runtime.
 */
export function defaultConfig(): SupervisorConfig {
  return {
    hubUrl: DEFAULT_HUB_URL,
    apiKey: '',
    roots: [],
    maxConcurrent: 1,
    allowDangerousSkipPermissions: false,
    requireGitRepo: false,
    auditLogEnabled: true,
    auditLogPath: defaultAuditLogPath(),
    killSwitchHotkey: DEFAULT_KILL_SWITCH_HOTKEY,
    autostart: true,
    scan: { ...DEFAULT_SCAN_SETTINGS },
    lastScanAt: null,
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
    allow_dangerous_skip_permissions:
      cfg.allowDangerousSkipPermissions ?? existing.allow_dangerous_skip_permissions ?? false,
    require_git_repo: cfg.requireGitRepo ?? existing.require_git_repo ?? false,
    audit_log_enabled: cfg.auditLogEnabled ?? existing.audit_log_enabled ?? true,
    audit_log_path: cfg.auditLogPath || existing.audit_log_path || defaultAuditLogPath(),
    kill_switch_hotkey: cfg.killSwitchHotkey || existing.kill_switch_hotkey || DEFAULT_KILL_SWITCH_HOTKEY,
    autostart: cfg.autostart ?? existing.autostart ?? true,
    // Phase 08 §15
    scan: cfg.scan
      ? {
          max_depth: cfg.scan.max_depth ?? DEFAULT_SCAN_SETTINGS.max_depth,
          ignore_globs: cfg.scan.ignore_globs ?? DEFAULT_SCAN_SETTINGS.ignore_globs,
          follow_symlinks: cfg.scan.follow_symlinks ?? DEFAULT_SCAN_SETTINGS.follow_symlinks,
        }
      : existing.scan ?? { ...DEFAULT_SCAN_SETTINGS },
    last_scan_at: cfg.lastScanAt ?? existing.last_scan_at ?? null,
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8')
}

export function parseRoots(input: string | undefined): string[] {
  if (!input) return []
  return input.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

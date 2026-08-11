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
  /**
   * PTY-cutover Phase A — preferred interactive human backend. 'claude' is only
   * honored once the cutover gate confirms (see `claudeInteractiveConfirmed`);
   * until then the selector fails safe to 'codex-pty'. Env override:
   * `REMO_DEFAULT_HUMAN_BACKEND`.
   */
  defaultHumanBackend: 'claude' | 'codex'
  /**
   * PTY-cutover Phase A — operator-recorded cutover-gate flag. FALSE by default
   * (fail-safe): Claude-PTY is never the default until the operator confirms
   * interactive billing per docs/cutover-gate-june15.md. Prod flips this on via
   * `REMO_CLAUDE_INTERACTIVE_CONFIRMED=1`. No production code path writes it.
   */
  claudeInteractiveConfirmed: boolean
}

/**
 * fix/supervisor-config-write-isolation — explicit override for the
 * supervisor config directory. Tests/dev tooling set this to a sandbox dir
 * so a `SupervisorClient` never resolves to (and clobbers) the real
 * per-user `%APPDATA%\remo-code\supervisor.json`. Takes precedence over
 * every OS-default lookup below.
 */
function configDirOverride(): string | undefined {
  const v = process.env.REMO_CODE_CONFIG_DIR
  return v && v.trim() ? v : undefined
}

/**
 * fix/supervisor-config-write-isolation — fail loud instead of silently
 * writing/reading the real user config from an automated test run. `bun
 * test` sets `NODE_ENV=test` itself (verified: unset outside `bun test`),
 * so any test that forgets to set `REMO_CODE_CONFIG_DIR` hits this instead
 * of touching live `%APPDATA%\remo-code\supervisor.json`.
 */
function assertNotUnisolatedTestRun(): void {
  if (process.env.NODE_ENV === 'test' && !configDirOverride()) {
    throw new Error(
      'supervisor config: NODE_ENV=test but REMO_CODE_CONFIG_DIR is not set. ' +
        'Tests must set REMO_CODE_CONFIG_DIR to a sandbox directory before touching ' +
        'config.ts / hub-client.ts — refusing to resolve the real user config path.',
    )
  }
}

function defaultConfigDir(): string {
  const override = configDirOverride()
  if (override) return override
  assertNotUnisolatedTestRun()
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

const DEFAULT_HUB_URL = 'https://app.remo-code.com'
const DEFAULT_KILL_SWITCH_HOTKEY = 'Ctrl+Shift+Alt+K'

/**
 * fix/supervisor-config-write-isolation — resolved LIVE on every call (not
 * cached at module load) so `REMO_CODE_CONFIG_DIR` set by a test after this
 * module is imported still takes effect, and so the guard in
 * `defaultConfigDir()` runs on every access, not just the first.
 */
export function getConfigDir(): string {
  return defaultConfigDir()
}

/** Phase 08 §15 — explicit accessor for the resolved supervisor.json path. */
export function getConfigPath(): string {
  return join(getConfigDir(), 'supervisor.json')
}

function readScanFromRaw(raw: any): ScanSettings {
  const s = raw?.scan ?? {}
  return {
    max_depth: typeof s.max_depth === 'number' && s.max_depth > 0 ? s.max_depth : DEFAULT_SCAN_SETTINGS.max_depth,
    ignore_globs: Array.isArray(s.ignore_globs) ? s.ignore_globs.map(String) : DEFAULT_SCAN_SETTINGS.ignore_globs,
    follow_symlinks: s.follow_symlinks === true,
  }
}

/**
 * PTY-cutover Phase A — resolve the preferred interactive human backend.
 * Precedence: env `REMO_DEFAULT_HUMAN_BACKEND` > config `default_human_backend`
 * > 'claude' (default). Only 'claude' | 'codex' accepted; anything else → default.
 */
function readDefaultHumanBackend(raw: any): 'claude' | 'codex' {
  const env = process.env.REMO_DEFAULT_HUMAN_BACKEND
  const val = env || raw?.default_human_backend
  return val === 'codex' ? 'codex' : 'claude'
}

/**
 * PTY-cutover Phase A — resolve the cutover-gate confirm flag (fail-safe FALSE).
 * Precedence: env `REMO_CLAUDE_INTERACTIVE_CONFIRMED=1` > config
 * `claude_interactive_confirmed === true` > false.
 */
function readClaudeInteractiveConfirmed(raw: any): boolean {
  if (process.env.REMO_CLAUDE_INTERACTIVE_CONFIRMED === '1') return true
  return raw?.claude_interactive_confirmed === true
}

export function loadConfig(): SupervisorConfig {
  const configPath = getConfigPath()
  if (!existsSync(configPath)) {
    throw new Error(`Supervisor not configured. Open the Remo Code tray app and complete the first-run setup (or write ${configPath} manually).`)
  }
  const raw = JSON.parse(readFileSync(configPath, 'utf-8'))
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
    defaultHumanBackend: readDefaultHumanBackend(raw),
    claudeInteractiveConfirmed: readClaudeInteractiveConfirmed(raw),
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
    defaultHumanBackend: readDefaultHumanBackend({}),
    claudeInteractiveConfirmed: readClaudeInteractiveConfirmed({}),
  }
}

export function saveConfig(cfg: Partial<SupervisorConfig> & { apiKey: string }) {
  const configDir = getConfigDir()
  const configPath = getConfigPath()
  mkdirSync(configDir, { recursive: true })
  const existing = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : {}
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
    // PTY-cutover Phase A
    default_human_backend:
      cfg.defaultHumanBackend ?? existing.default_human_backend ?? 'claude',
    claude_interactive_confirmed:
      cfg.claudeInteractiveConfirmed ?? existing.claude_interactive_confirmed ?? false,
  }
  writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8')
}

/**
 * PTY-cutover Phase A — build the `BackendSelectorConfig` the human-session
 * runner factory consumes, from the resolved supervisor config (env-overridable
 * via REMO_DEFAULT_HUMAN_BACKEND / REMO_CLAUDE_INTERACTIVE_CONFIRMED=1).
 *
 * Fail-safe: `claude_interactive_confirmed` defaults to FALSE, so until prod
 * sets `REMO_CLAUDE_INTERACTIVE_CONFIRMED=1` the gate result is 'unknown' and
 * the selector resolves a Claude preference to 'codex-pty'. The code default is
 * deliberately NOT hardcoded to confirmed — the env/config flip is how prod
 * enables Claude-PTY (see docs/cutover-gate-june15.md).
 */
export function getBackendSelectorConfig(cfg?: SupervisorConfig): import('./runners/backend-selector').BackendSelectorConfig {
  const c = cfg ?? defaultConfig()
  const confirmed = c.claudeInteractiveConfirmed
  return {
    defaultHumanBackend: c.defaultHumanBackend,
    gate: {
      result: confirmed ? 'interactive' : 'unknown',
      claudeInteractiveConfirmed: confirmed,
    },
  }
}

export function parseRoots(input: string | undefined): string[] {
  if (!input) return []
  return input.split(/[,;]/).map((s) => s.trim()).filter(Boolean)
}

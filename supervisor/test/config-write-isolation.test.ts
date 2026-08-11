/**
 * fix/supervisor-config-write-isolation
 *
 * `config.ts` used to resolve CONFIG_PATH from the real `process.env.APPDATA`
 * with no test/dev isolation, and `hub-client.ts`'s `scanAndSendInventory()`
 * unconditionally persisted scan results there via `saveConfig({...this.cfg,
 * apiKey, lastScanAt})` — spreading whatever `roots` a test/dev
 * `SupervisorClient` happened to be constructed with into the live user
 * config at `%APPDATA%\remo-code\supervisor.json`.
 *
 * Covers:
 *   - `REMO_CODE_CONFIG_DIR` override is honored by `getConfigDir()` /
 *     `getConfigPath()` and by `saveConfig()`.
 *   - A `SupervisorClient` scan/save (`scanAndSendInventory` via
 *     `sendRepoInventory`) writes ONLY inside the sandbox dir — never to the
 *     real per-user config path — when the override is set.
 *   - The guard: under `NODE_ENV=test` (which `bun test` sets itself) with NO
 *     `REMO_CODE_CONFIG_DIR` override, config resolution throws loud instead
 *     of silently falling through to the real APPDATA path.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'remo-cfg-isolation-'))
const SCAN_ROOT = mkdtempSync(join(tmpdir(), 'remo-cfg-isolation-root-'))

let savedOverride: string | undefined

beforeEach(() => {
  savedOverride = process.env.REMO_CODE_CONFIG_DIR
})

afterEach(() => {
  if (savedOverride === undefined) delete process.env.REMO_CODE_CONFIG_DIR
  else process.env.REMO_CODE_CONFIG_DIR = savedOverride
})

describe('REMO_CODE_CONFIG_DIR override', () => {
  test('getConfigDir/getConfigPath resolve inside the sandbox, not APPDATA', async () => {
    process.env.REMO_CODE_CONFIG_DIR = SANDBOX
    // Re-import fresh so any module-level caching can't hide a regression —
    // Bun's ESM cache keys on specifier, so use a cache-busting query.
    const config = await import('../src/config.ts?isolation-test-1')
    expect(config.getConfigDir()).toBe(SANDBOX)
    expect(config.getConfigPath()).toBe(join(SANDBOX, 'supervisor.json'))
    const realAppData = process.env.APPDATA
    if (realAppData) {
      expect(config.getConfigPath().toLowerCase()).not.toContain(realAppData.toLowerCase())
    }
  })

  test('saveConfig() writes only under the sandbox dir', async () => {
    process.env.REMO_CODE_CONFIG_DIR = SANDBOX
    const config = await import('../src/config.ts?isolation-test-2')
    config.saveConfig({ apiKey: 'k', roots: [SCAN_ROOT], lastScanAt: '2026-08-11T00:00:00.000Z' })
    const path = config.getConfigPath()
    expect(path.startsWith(SANDBOX)).toBe(true)
    expect(existsSync(path)).toBe(true)
    const written = JSON.parse(readFileSync(path, 'utf-8'))
    expect(written.roots).toEqual([SCAN_ROOT])
  })
})

describe('SupervisorClient scan/save never touches the real APPDATA config', () => {
  test('scanAndSendInventory persists last_inventory.json + supervisor.json only inside the sandbox', async () => {
    process.env.REMO_CODE_CONFIG_DIR = SANDBOX
    const { SupervisorClient } = await import('../src/hub-client.ts?isolation-test-3')
    const client = new SupervisorClient({
      hubUrl: 'http://hub.local',
      apiKey: 'k',
      roots: [SCAN_ROOT],
      maxConcurrent: 4,
      requireGitRepo: false,
      allowDangerousSkipPermissions: false,
      auditLogEnabled: false,
      scan: { max_depth: 2, ignore_globs: [], follow_symlinks: false },
    } as any)
    ;(client as any).authenticated = true
    ;(client as any).send = () => {}

    await (client as any).sendRepoInventory()

    expect(existsSync(join(SANDBOX, 'last_inventory.json'))).toBe(true)
    expect(existsSync(join(SANDBOX, 'supervisor.json'))).toBe(true)
    const cfg = JSON.parse(readFileSync(join(SANDBOX, 'supervisor.json'), 'utf-8'))
    expect(cfg.roots).toEqual([SCAN_ROOT])

    // The real per-user path (if it exists on this machine) must be
    // untouched by this scan — best-effort check, skipped if absent.
    const realAppData = process.env.APPDATA
    if (realAppData) {
      const realPath = join(realAppData, 'remo-code', 'supervisor.json')
      if (existsSync(realPath)) {
        const real = JSON.parse(readFileSync(realPath, 'utf-8'))
        expect(real.roots).not.toEqual([SCAN_ROOT])
      }
    }
  })
})

describe('unisolated test-run guard', () => {
  test('NODE_ENV=test with no REMO_CODE_CONFIG_DIR override throws instead of resolving APPDATA', async () => {
    delete process.env.REMO_CODE_CONFIG_DIR
    expect(process.env.NODE_ENV).toBe('test')
    const config = await import('../src/config.ts?isolation-test-4')
    expect(() => config.getConfigDir()).toThrow(/REMO_CODE_CONFIG_DIR/)
    expect(() => config.getConfigPath()).toThrow(/REMO_CODE_CONFIG_DIR/)
  })
})

// Best-effort sandbox cleanup (not load-bearing for the assertions above).
process.on('exit', () => {
  try { rmSync(SANDBOX, { recursive: true, force: true }) } catch {}
  try { rmSync(SCAN_ROOT, { recursive: true, force: true }) } catch {}
})

/**
 * Per-session skip-permissions × host ceiling matrix.
 *
 * The hub sends a per-session REQUEST on session.start
 * (`dangerously_skip_permissions`); hub-client maps it onto
 * `spec.dangerouslySkipPermissions`; ProcessManager then ANDs it with the host
 * config `allowDangerousSkipPermissions`. A per-session opt-in can NEVER exceed
 * the host ceiling. This pins all four cells of the truth table via the audit
 * log's `dangerously_skip_permissions_applied` flag.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProcessManager, type RunSpec } from '../src/process-manager'
import type { SupervisorConfig } from '../src/config'
import type { SessionBridgeOptions, SessionBridgeCallbacks } from '../src/runners/session-bridge'

let TMP: string
let ROOT: string
let REPO: string
let AUDIT: string

const bridges: SessionBridgeOptions[] = []
class FakeBridge { start() {} async stop() {} }

function makeCfg(over: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    hubUrl: 'https://example.test', apiKey: 'olx_test', roots: [ROOT],
    maxConcurrent: 5, allowDangerousSkipPermissions: false, requireGitRepo: false,
    auditLogEnabled: true, auditLogPath: AUDIT, killSwitchHotkey: 'Ctrl+Shift+Alt+K',
    autostart: false, ...over,
  }
}
function makePM(cfg: SupervisorConfig) {
  const pm = new ProcessManager({ onStateChange: () => {}, onLog: () => {} }, cfg)
  pm.bridgeFactory = ((opts: SessionBridgeOptions, _cb: SessionBridgeCallbacks) => { bridges.push(opts); return new FakeBridge() }) as any
  return pm
}
function spec(over: Partial<RunSpec> = {}): RunSpec {
  return { runId: 'run_' + Math.random().toString(36).slice(2, 8), repoPath: REPO, branch: null, initialPrompt: null, apiKey: 'olx_test', hubUrl: 'https://example.test', ...over }
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-skip-'))
  ROOT = join(TMP, 'gh'); REPO = join(ROOT, 'repo'); AUDIT = join(TMP, 'audit.jsonl')
  mkdirSync(join(REPO, '.git'), { recursive: true })
})
afterAll(() => { try { rmSync(TMP, { recursive: true, force: true }) } catch {} })
beforeEach(() => { bridges.length = 0; if (existsSync(AUDIT)) { try { rmSync(AUDIT) } catch {} } })

function appliedFlag(): boolean {
  const line = readFileSync(AUDIT, 'utf-8').trim().split('\n').pop()!
  return JSON.parse(line).flags.dangerously_skip_permissions_applied
}

describe('per-session skip-permissions × host ceiling', () => {
  test('requested=OFF, ceiling=OFF → applied OFF (default)', async () => {
    const pm = makePM(makeCfg({ allowDangerousSkipPermissions: false }))
    await pm.start(spec({ dangerouslySkipPermissions: false }))
    expect(bridges[0].allowDangerousSkipPermissions).toBe(false)
    expect(appliedFlag()).toBe(false)
  })

  test('requested=undefined (default off) → applied OFF', async () => {
    const pm = makePM(makeCfg({ allowDangerousSkipPermissions: true }))
    await pm.start(spec({}))
    expect(bridges[0].allowDangerousSkipPermissions).toBe(false)
    expect(appliedFlag()).toBe(false)
  })

  test('requested=ON but ceiling=OFF → applied OFF (host wins)', async () => {
    const pm = makePM(makeCfg({ allowDangerousSkipPermissions: false }))
    await pm.start(spec({ dangerouslySkipPermissions: true }))
    expect(bridges[0].allowDangerousSkipPermissions).toBe(false)
    expect(appliedFlag()).toBe(false)
  })

  test('requested=ON and ceiling=ON → applied ON', async () => {
    const pm = makePM(makeCfg({ allowDangerousSkipPermissions: true }))
    await pm.start(spec({ dangerouslySkipPermissions: true }))
    expect(bridges[0].allowDangerousSkipPermissions).toBe(true)
    expect(appliedFlag()).toBe(true)
  })
})

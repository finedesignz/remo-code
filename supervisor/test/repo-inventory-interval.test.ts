/**
 * fix/supervisor-periodic-repo-rescan — periodic repo inventory re-emit.
 *
 * Covers:
 *   - REMO_REPO_INVENTORY_INTERVAL_MS defaulting (unset / non-positive /
 *     non-finite ⇒ 5-min default; valid override honored).
 *   - The periodic timer is registered on auth_ok and cleared on disconnect.
 *   - A slow scan does not overlap the next tick (repoInventoryInFlight guard).
 *   - The hub-initiated rescan (`supervisor.rescan_repos`) forces an emit and
 *     acks ok; a scan failure acks ok:false (no silent stale swap).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  SupervisorClient,
  resolveRepoInventoryIntervalMs,
  REPO_INVENTORY_INTERVAL_DEFAULT_MS,
} from '../src/hub-client'

const ROOT = mkdtempSync(join(tmpdir(), 'remo-repoinv-'))

// fix/test-config-isolation-contract — this file constructs a real
// `SupervisorClient` whose scan/save path resolves the supervisor config dir.
// Before #406 that resolution wrote through to the REAL
// `%APPDATA%\remo-code\supervisor.json`: THIS file's `remo-repoinv-*` temp dir
// is the one that ended up in the live `roots`, which then made the running
// supervisor reject genuine session launches as `sandbox_escape`. #406 added a
// guard that makes an unisolated run throw instead of writing, so the damage is
// already prevented — but the contract that guard's own error message states is
// "tests must set REMO_CODE_CONFIG_DIR before touching config.ts /
// hub-client.ts". Honor it here rather than leaning on the guard: if persistence
// assertions are ever added to this file, they need a real (sandboxed) config
// dir, not a swallowed throw.
const CONFIG_SANDBOX = mkdtempSync(join(tmpdir(), 'remo-repoinv-cfg-'))
let savedConfigDir: string | undefined

beforeAll(() => {
  savedConfigDir = process.env.REMO_CODE_CONFIG_DIR
  process.env.REMO_CODE_CONFIG_DIR = CONFIG_SANDBOX
})

afterAll(() => {
  // Restore rather than leave it set: a leaked override would silently isolate
  // whatever test file runs next in this process and mask a missing one there.
  if (savedConfigDir === undefined) delete process.env.REMO_CODE_CONFIG_DIR
  else process.env.REMO_CODE_CONFIG_DIR = savedConfigDir
})

const baseCfg: any = {
  hubUrl: 'http://hub.local',
  apiKey: 'k',
  roots: [ROOT],
  maxConcurrent: 4,
  requireGitRepo: false,
  allowDangerousSkipPermissions: false,
  auditLogEnabled: false,
  scan: { max_depth: 2, ignore_globs: [], follow_symlinks: false },
}

describe('resolveRepoInventoryIntervalMs', () => {
  test('unset / non-positive / non-finite ⇒ default', () => {
    expect(resolveRepoInventoryIntervalMs(undefined)).toBe(REPO_INVENTORY_INTERVAL_DEFAULT_MS)
    expect(resolveRepoInventoryIntervalMs(null)).toBe(REPO_INVENTORY_INTERVAL_DEFAULT_MS)
    expect(resolveRepoInventoryIntervalMs('')).toBe(REPO_INVENTORY_INTERVAL_DEFAULT_MS)
    expect(resolveRepoInventoryIntervalMs('0')).toBe(REPO_INVENTORY_INTERVAL_DEFAULT_MS)
    expect(resolveRepoInventoryIntervalMs('-5')).toBe(REPO_INVENTORY_INTERVAL_DEFAULT_MS)
    expect(resolveRepoInventoryIntervalMs('abc')).toBe(REPO_INVENTORY_INTERVAL_DEFAULT_MS)
  })
  test('valid positive override honored', () => {
    expect(resolveRepoInventoryIntervalMs('60000')).toBe(60000)
  })
})

describe('periodic repo inventory timer lifecycle', () => {
  let client: SupervisorClient

  beforeEach(() => {
    client = new SupervisorClient({ ...baseCfg })
    ;(client as any).authenticated = true
    // Neutralize the real socket send so no network is touched.
    ;(client as any).send = () => {}
  })

  test('startRepoInventoryPush registers a timer; stop clears it', () => {
    expect((client as any).repoInventoryTimer).toBeNull()
    ;(client as any).startRepoInventoryPush()
    expect((client as any).repoInventoryTimer).not.toBeNull()
    // Idempotent — a second start does not replace the handle.
    const handle = (client as any).repoInventoryTimer
    ;(client as any).startRepoInventoryPush()
    expect((client as any).repoInventoryTimer).toBe(handle)
    ;(client as any).stopRepoInventoryPush()
    expect((client as any).repoInventoryTimer).toBeNull()
  })

  test('a scan in flight is not overlapped by a concurrent call', async () => {
    let scans = 0
    // Stub the private scan so we can hold it open across two calls.
    let release!: () => void
    ;(client as any).scanAndSendInventory = () =>
      new Promise<void>((resolve) => {
        scans++
        release = resolve
      })
    const first = (client as any).sendRepoInventory()
    // Second call while the first is still pending must no-op.
    await (client as any).sendRepoInventory()
    expect(scans).toBe(1)
    release()
    await first
    // Now a fresh call proceeds.
    ;(client as any).scanAndSendInventory = async () => { scans++ }
    await (client as any).sendRepoInventory()
    expect(scans).toBe(2)
  })

  test('rescan_repos acks ok on success, ok:false on scan failure', async () => {
    const sent: any[] = []
    ;(client as any).send = (m: any) => sent.push(m)

    ;(client as any).scanAndSendInventory = async () => {}
    await (client as any).onRescanRepos({ req_id: 'r1' })
    expect(sent.find((m) => m.type === 'supervisor.rescan_ack' && m.req_id === 'r1')?.ok).toBe(true)

    sent.length = 0
    ;(client as any).scanAndSendInventory = async () => { throw new Error('scan boom') }
    await (client as any).onRescanRepos({ req_id: 'r2' })
    const nack = sent.find((m) => m.type === 'supervisor.rescan_ack' && m.req_id === 'r2')
    expect(nack.ok).toBe(false)
    expect(nack.error).toContain('scan boom')
  })
})

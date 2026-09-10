/**
 * milestone remote-update-trigger — the sidecar half of the hub→sidecar→tray
 * force-update chain: `supervisor.force_update` writes a marker file the Rust
 * tray watcher later consumes, and acks `supervisor.force_update_ack`.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeForceUpdateMarker, forceUpdateMarkerPath } from '../src/runners/force-update-marker'
import { SupervisorClient } from '../src/hub-client'

// fix/test-config-isolation-contract — two separate real-user directories are
// in play here, and this file used to write to both:
//
//   1. The CONFIG dir (`%APPDATA%\remo-code`) — reached because this file
//      constructs a real `SupervisorClient`. Covered by REMO_CODE_CONFIG_DIR,
//      the override #406 added.
//   2. The supervisor STATE dir (`%LOCALAPPDATA%\remo-code-supervisor`) —
//      `forceUpdateMarkerPath()` resolves through `supervisorStateDir()`, which
//      keys off LOCALAPPDATA and is NOT covered by REMO_CODE_CONFIG_DIR or by
//      #406's guard. So this file was writing `force-update.json` into the live
//      supervisor state dir, and its `afterEach` `rmSync` would delete a real
//      pending force-update marker if one happened to exist. Same class of
//      test/prod bleed as the config write-through, different directory.
//
// Both are redirected to per-run temp dirs below. Note the LOCALAPPDATA
// redirect is win32-only by construction: on Linux/macOS `supervisorStateDir()`
// resolves under `homedir()` instead, so the override is a no-op there (CI
// runners have ephemeral homes, so nothing real is at risk).
const CONFIG_SANDBOX = mkdtempSync(join(tmpdir(), 'remo-forceupd-cfg-'))
const STATE_SANDBOX = mkdtempSync(join(tmpdir(), 'remo-forceupd-state-'))
let savedConfigDir: string | undefined
let savedLocalAppData: string | undefined

beforeAll(() => {
  savedConfigDir = process.env.REMO_CODE_CONFIG_DIR
  savedLocalAppData = process.env.LOCALAPPDATA
  process.env.REMO_CODE_CONFIG_DIR = CONFIG_SANDBOX
  process.env.LOCALAPPDATA = STATE_SANDBOX
})

afterAll(() => {
  // Restore both: a leaked override would silently isolate whatever test file
  // runs next in this process and mask a missing one there.
  if (savedConfigDir === undefined) delete process.env.REMO_CODE_CONFIG_DIR
  else process.env.REMO_CODE_CONFIG_DIR = savedConfigDir
  if (savedLocalAppData === undefined) delete process.env.LOCALAPPDATA
  else process.env.LOCALAPPDATA = savedLocalAppData
})

const baseCfg: any = {
  hubUrl: 'http://hub.local',
  apiKey: 'k',
  roots: [],
  maxConcurrent: 4,
  requireGitRepo: false,
  allowDangerousSkipPermissions: false,
  auditLogEnabled: false,
  scan: { max_depth: 2, ignore_globs: [], follow_symlinks: false },
}

describe('writeForceUpdateMarker', () => {
  afterEach(() => {
    try { rmSync(forceUpdateMarkerPath()) } catch {}
  })

  test('writes a marker with requested_at and optional requested_by', () => {
    const path = writeForceUpdateMarker('user-123')
    expect(path).toBe(forceUpdateMarkerPath())
    expect(existsSync(path!)).toBe(true)
    const parsed = JSON.parse(readFileSync(path!, 'utf-8'))
    expect(typeof parsed.requested_at).toBe('string')
    expect(parsed.requested_by).toBe('user-123')
  })

  test('omits requested_by when not provided', () => {
    const path = writeForceUpdateMarker(undefined)
    const parsed = JSON.parse(readFileSync(path!, 'utf-8'))
    expect(parsed.requested_by).toBeUndefined()
  })
})

describe('SupervisorClient.onForceUpdate', () => {
  let client: SupervisorClient

  beforeEach(() => {
    client = new SupervisorClient({ ...baseCfg })
    ;(client as any).authenticated = true
  })

  afterEach(() => {
    try { rmSync(forceUpdateMarkerPath()) } catch {}
  })

  test('acks ok:true and writes the marker on success', () => {
    const sent: any[] = []
    ;(client as any).send = (m: any) => sent.push(m)

    ;(client as any).onForceUpdate({ req_id: 'req_1', requested_by: 'articulatedesigns@gmail.com' })

    const ack = sent.find((m) => m.type === 'supervisor.force_update_ack' && m.req_id === 'req_1')
    expect(ack?.ok).toBe(true)
    expect(existsSync(forceUpdateMarkerPath())).toBe(true)
  })

  test('acks ok:false when the marker write fails', () => {
    const sent: any[] = []
    ;(client as any).send = (m: any) => sent.push(m)

    // Force the marker writer's mkdirSync/writeFileSync path to fail by
    // pointing supervisorStateDir()'s base dir somewhere unwritable-shaped.
    // A null byte in a path string is rejected by Node's fs bindings
    // (ERR_INVALID_ARG_VALUE) synchronously on every platform — but
    // supervisorStateDir() only reads LOCALAPPDATA on win32; on posix it
    // reads homedir(), which Node's os.homedir() derives from HOME. So the
    // env var under test must match the platform supervisorStateDir()
    // actually consults, or this never forces a real failure on posix CI.
    const envVar = process.platform === 'win32' ? 'LOCALAPPDATA' : 'HOME'
    const prev = process.env[envVar]
    process.env[envVar] = '\0invalid'
    try {
      ;(client as any).onForceUpdate({ req_id: 'req_2' })
    } finally {
      if (prev === undefined) delete process.env[envVar]
      else process.env[envVar] = prev
    }

    const ack = sent.find((m) => m.type === 'supervisor.force_update_ack' && m.req_id === 'req_2')
    expect(ack?.ok).toBe(false)
    expect(ack?.error).toBe('marker_write_failed')
  })
})

/**
 * milestone remote-update-trigger — the sidecar half of the hub→sidecar→tray
 * force-update chain: `supervisor.force_update` writes a marker file the Rust
 * tray watcher later consumes, and acks `supervisor.force_update_ack`.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'fs'
import { writeForceUpdateMarker, forceUpdateMarkerPath } from '../src/runners/force-update-marker'
import { SupervisorClient } from '../src/hub-client'

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

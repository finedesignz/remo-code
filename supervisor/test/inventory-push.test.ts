/**
 * Bug A (2026-05-28) — ProcessManager.inventorySnapshot shape + filtering.
 *
 * Uses the BridgeFactory test hook to avoid spawning a real Claude subprocess
 * or opening a WS. The factory returns a stub SessionBridge that records the
 * onSessionId / onActivity callbacks the hub-client wires through and lets us
 * drive ProcessManager state transitions directly.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProcessManager, type RunSpec } from '../src/process-manager'
import type { SessionBridgeCallbacks, SessionBridgeOptions } from '../src/runners/session-bridge'

// Real existing dirs so the sandbox check passes on every OS.
const ROOT = mkdtempSync(join(tmpdir(), 'remo-inv-'))
const REPO = ROOT

type CapturedBridge = {
  cb: SessionBridgeCallbacks
  opts: SessionBridgeOptions
  start: () => void
  stop: () => Promise<void>
}

function makeStubFactory(captured: CapturedBridge[]) {
  return (opts: SessionBridgeOptions, cb: SessionBridgeCallbacks) => {
    const entry: CapturedBridge = {
      cb,
      opts,
      start: () => { /* no-op: ProcessManager just calls start() */ },
      stop: async () => { /* no-op */ },
    }
    captured.push(entry)
    return entry as any
  }
}

const baseCfg: any = {
  hubUrl: 'http://hub.local',
  apiKey: 'k',
  roots: [ROOT],
  maxConcurrent: 16,
  requireGitRepo: false,
  allowDangerousSkipPermissions: false,
  auditLogEnabled: false,
  scan: { max_depth: 4, ignore_globs: [], follow_symlinks: false },
}

function makeSpec(runId: string, repoPath = REPO): RunSpec {
  return {
    runId,
    repoPath,
    branch: null,
    initialPrompt: null,
    apiKey: 'k',
    hubUrl: 'http://hub.local',
  }
}

describe('ProcessManager.inventorySnapshot', () => {
  let captured: CapturedBridge[]
  let pm: ProcessManager

  beforeEach(() => {
    captured = []
    pm = new ProcessManager({
      onStateChange: () => {},
      onLog: () => {},
    }, baseCfg)
    pm.bridgeFactory = makeStubFactory(captured)
  })

  test('empty PM → empty snapshot', () => {
    expect(pm.inventorySnapshot()).toEqual([])
  })

  test('starting run appears with status=spawning and null sessionId', async () => {
    await pm.start(makeSpec('run_a'))
    const snap = pm.inventorySnapshot()
    expect(snap.length).toBe(1)
    expect(snap[0].runId).toBe('run_a')
    expect(snap[0].status).toBe('spawning')
    expect(snap[0].sessionId).toBeNull()
    expect(snap[0].cliKind).toBe('claude')
  })

  test('onSpawned transitions to running; onSessionId stamps id', async () => {
    await pm.start(makeSpec('run_b'))
    const bridge = captured[0]
    bridge.cb.onSpawned({ pid: 4242 })
    bridge.cb.onSessionId?.('sess_xyz')
    const snap = pm.inventorySnapshot()
    expect(snap[0].status).toBe('running')
    expect(snap[0].pid).toBe(4242)
    expect(snap[0].sessionId).toBe('sess_xyz')
  })

  test('onActivity bumps last_activity_at to a non-null ISO string', async () => {
    await pm.start(makeSpec('run_c'))
    const bridge = captured[0]
    bridge.cb.onSpawned({ pid: 5 })
    expect(pm.inventorySnapshot()[0].lastActivityAt).toBeNull()
    bridge.cb.onActivity?.()
    const after = pm.inventorySnapshot()[0].lastActivityAt
    expect(after).not.toBeNull()
    // ISO 8601 with Z (UTC).
    expect(after).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test('clean exit (code=0) removes the run from snapshot', async () => {
    await pm.start(makeSpec('run_d'))
    const bridge = captured[0]
    bridge.cb.onSpawned({ pid: 1 })
    expect(pm.inventorySnapshot().length).toBe(1)
    bridge.cb.onExit({ code: 0, reason: 'normal' })
    expect(pm.inventorySnapshot().length).toBe(0)
  })

  test('snapshot is payload-bounded (well under 10KB even with multiple entries)', async () => {
    // Distinct project_dir per run — same-project repeats are now deduped
    // (concurrency-leak fix), so 8 entries requires 8 distinct (real) projects.
    for (let i = 0; i < 8; i++) {
      const proj = join(REPO, `proj_${i}`)
      mkdirSync(proj, { recursive: true })
      await pm.start(makeSpec(`run_${i}`, proj))
    }
    captured.forEach((b, i) => {
      b.cb.onSpawned({ pid: 1000 + i })
      b.cb.onSessionId?.(`sess_${i}`)
    })
    const snap = pm.inventorySnapshot()
    expect(snap.length).toBe(8)
    const wire = snap
      .filter((r) => r.sessionId !== null)
      .map((r) => ({
        session_id: r.sessionId,
        cli_kind: r.cliKind,
        project_dir: r.projectDir,
        pid: r.pid,
        started_at: r.startedAt,
        last_activity_at: r.lastActivityAt,
        status: r.status,
      }))
    const json = JSON.stringify({ type: 'session_inventory', sessions: wire })
    expect(json.length).toBeLessThan(10_000)
  })
})

/**
 * Regression coverage for the 2026-05-31 prod outage chain:
 *   broken stdout pipe → console.* throws EPIPE → uncaughtException fired
 *   mid-`stop()` → `runs.delete()` (slot release) skipped → leaked slot →
 *   every launch denied `concurrency_cap`.
 *
 * Even with EPIPE-safe logging in place, `stop()` must NEVER depend on a
 * successful log/state write to release its slot. The slot release now lives in
 * a `finally`, so a throw anywhere in the stop body still frees the slot. This
 * test simulates that throw via an `onStateChange` callback that raises EPIPE
 * (the same shape the broken-pipe console write would take) and asserts the
 * slot is reclaimed (a subsequent start at maxConcurrent=1 succeeds).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProcessManager, type RunSpec } from '../src/process-manager'
import type { SupervisorConfig } from '../src/config'
import type { SessionBridgeCallbacks, SessionBridgeOptions } from '../src/runners/session-bridge'

let TMP: string
let ROOT: string
let REPO_A: string
let REPO_B: string
let AUDIT_PATH: string

const bridges: Array<{ cb: SessionBridgeCallbacks; fake: FakeBridge }> = []

class FakeBridge {
  alive = true
  start() {}
  async stop() {}
  isAlive() { return this.alive }
}

function bridgeFactorySpy(_opts: SessionBridgeOptions, cb: SessionBridgeCallbacks): any {
  const fake = new FakeBridge()
  bridges.push({ cb, fake })
  return fake
}

function makeCfg(): SupervisorConfig {
  return {
    hubUrl: 'https://example.test',
    apiKey: 'olx_test',
    roots: [ROOT],
    maxConcurrent: 1,
    allowDangerousSkipPermissions: false,
    requireGitRepo: false,
    auditLogEnabled: true,
    auditLogPath: AUDIT_PATH,
    killSwitchHotkey: 'Ctrl+Shift+Alt+K',
    autostart: false,
  }
}

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 'run_' + Math.random().toString(36).slice(2, 10),
    repoPath: REPO_A,
    branch: null,
    initialPrompt: null,
    apiKey: 'olx_test',
    hubUrl: 'https://example.test',
    ...over,
  }
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-pm-epipe-'))
  ROOT = join(TMP, 'gh')
  REPO_A = join(ROOT, 'repo-a')
  REPO_B = join(ROOT, 'repo-b')
  AUDIT_PATH = join(TMP, 'audit.jsonl')
  mkdirSync(join(REPO_A, '.git'), { recursive: true })
  mkdirSync(join(REPO_B, '.git'), { recursive: true })
})

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

describe('ProcessManager.stop — slot released even when a state/log write throws EPIPE', () => {
  test('a throwing onStateChange during stop() does NOT leak the slot', async () => {
    bridges.length = 0
    let throwOnState = false
    const pm = new ProcessManager(
      {
        onStateChange: () => {
          // Simulate the broken-pipe console write throwing EPIPE from inside
          // the state-change → onLog path while stop() is mid-flight.
          if (throwOnState) throw Object.assign(new Error('EPIPE: broken pipe, write'), { code: 'EPIPE' })
        },
        onLog: () => {},
      },
      makeCfg(),
    )
    pm.bridgeFactory = bridgeFactorySpy as any

    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 1234 })

    // Now stop() — and make the state write throw EPIPE mid-stop.
    throwOnState = true
    await expect(pm.stop('r1', 'user_stop')).resolves.toBeUndefined()
    throwOnState = false

    // The slot MUST be free despite the throw: a new run at maxConcurrent=1
    // (different repo) must succeed rather than hit concurrency_cap.
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_B }))
    expect(r2).toBeNull()
    expect(bridges.length).toBe(2)
  })
})

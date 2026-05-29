/**
 * Regression coverage for the 2026-05-29 supervisor wedge:
 *
 * `activeSlotCount()` previously counted `crashed` runs as occupying a slot.
 * A stale crashed entry sitting in its restart backoff window permanently
 * consumed the budget — every subsequent `pm.start()` rejected with
 * `concurrency_cap` even when no Claude CLI was actually running.
 *
 * Fix (Option A): `activeSlotCount` only counts `starting | running`.
 * The N+1 backoff-window race is closed by a same-repoPath duplicate guard.
 *
 * Prod evidence: supervisor 3ab82743 (TitaniumTower, v0.5.7),
 * `concurrency_budget=1`, sent `supervisor.state{stopped,
 * last_exit.reason='concurrency_cap'}` despite no live runner.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProcessManager, type RunSpec } from '../src/process-manager'
import type { SupervisorConfig } from '../src/config'
import type { SessionBridgeCallbacks, SessionBridgeOptions } from '../src/runners/session-bridge'

let TMP: string
let ROOT: string
let REPO_GIT: string
let REPO_GIT_2: string
let AUDIT_PATH: string

interface BridgeCall {
  opts: SessionBridgeOptions
  cb: SessionBridgeCallbacks
  fake: FakeBridge
}
const bridges: BridgeCall[] = []

class FakeBridge {
  startCalls = 0
  stopCalls = 0
  start() { this.startCalls++ }
  async stop() { this.stopCalls++ }
}

function bridgeFactorySpy(opts: SessionBridgeOptions, cb: SessionBridgeCallbacks): any {
  const fake = new FakeBridge()
  bridges.push({ opts, cb, fake })
  return fake
}

function makeCfg(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
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
    ...overrides,
  }
}

function makePM(cfg: SupervisorConfig) {
  const events: Array<{ state: string; info: any }> = []
  const logs: Array<{ level: string; msg: string }> = []
  const pm = new ProcessManager(
    {
      onStateChange: (state, info) => events.push({ state, info }),
      onLog: (level, msg) => logs.push({ level, msg }),
    },
    cfg,
  )
  pm.bridgeFactory = bridgeFactorySpy as any
  return { pm, events, logs }
}

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 'run_' + Math.random().toString(36).slice(2, 10),
    repoPath: REPO_GIT,
    branch: null,
    initialPrompt: null,
    apiKey: 'olx_test',
    hubUrl: 'https://example.test',
    ...over,
  }
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-pm-slot-'))
  ROOT = join(TMP, 'gh')
  REPO_GIT = join(ROOT, 'repo-a')
  REPO_GIT_2 = join(ROOT, 'repo-b')
  AUDIT_PATH = join(TMP, 'audit.jsonl')
  mkdirSync(REPO_GIT, { recursive: true })
  mkdirSync(REPO_GIT_2, { recursive: true })
  mkdirSync(join(REPO_GIT, '.git'), { recursive: true })
  mkdirSync(join(REPO_GIT_2, '.git'), { recursive: true })
})

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  bridges.length = 0
  if (existsSync(AUDIT_PATH)) {
    try { rmSync(AUDIT_PATH) } catch {}
  }
})

describe('ProcessManager.activeSlotCount — crashed excluded', () => {
  test('empty runs map → no slot occupied → start() succeeds', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r = await pm.start(spec())
    expect(r).toBeNull()
    expect(bridges.length).toBe(1)
  })

  test('one running run → slot occupied → second start (different repo) rejects with concurrency_cap', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_GIT }))
    expect(r1).toBeNull()
    // Transition the bridge to running.
    bridges[0].cb.onSpawned!({ pid: 1234 })
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_GIT_2 }))
    expect(r2?.reason).toBe('concurrency_cap')
  })

  test('crashed-pending entry does NOT occupy a slot (the wedge fix)', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_GIT }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 1234 })
    // Simulate crash — runner exits non-zero, entering backoff (state=crashed).
    bridges[0].cb.onExit!({ code: 1, reason: 'spawn_failed' })
    // Different repo MUST be allowed despite the crashed-pending entry.
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_GIT_2 }))
    expect(r2).toBeNull()
    expect(bridges.length).toBe(2)
  })

  test('same repo with crashed-pending → rejected as duplicate_run (closes N+1 window)', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 2 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_GIT }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 1234 })
    bridges[0].cb.onExit!({ code: 1, reason: 'spawn_failed' })
    // Same repoPath as the pending restart — must be refused so the backoff
    // can reclaim the slot without an N+1 spike.
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_GIT }))
    expect(r2?.reason).toBe('duplicate_run')
    expect((r2?.detail as any)?.pending_restart).toBe(true)
  })

  test('start() succeeds at maxConcurrent=1 even after a crash cycle leaves a pending entry on a different repo', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    // First run crashes immediately; backoff entry stays in map.
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_GIT }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 1234 })
    bridges[0].cb.onExit!({ code: 1, reason: 'spawn_failed' })
    // Pre-fix: this would have rejected with concurrency_cap. Now: allowed.
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_GIT_2 }))
    expect(r2).toBeNull()
  })

  test('concurrency cap still enforced when REAL runs are at budget', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 2 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_GIT }))
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_GIT_2 }))
    expect(r1).toBeNull()
    expect(r2).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 1 })
    bridges[1].cb.onSpawned!({ pid: 2 })
    const r3 = await pm.start(spec({ runId: 'r3', repoPath: REPO_GIT }))
    expect(r3?.reason).toBe('concurrency_cap')
  })

  test('starting (pre-onSpawned) counts toward slot', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_GIT }))
    expect(r1).toBeNull()
    // No onSpawned yet — run is in 'starting'.
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_GIT_2 }))
    expect(r2?.reason).toBe('concurrency_cap')
  })
})

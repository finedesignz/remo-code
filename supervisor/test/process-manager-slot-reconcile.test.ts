/**
 * Regression coverage for the 2026-05-30 production launch-lockout.
 *
 * Root cause: a concurrency slot is counted purely from a run's stored state
 * ('starting'/'running'). A run can be stranded in such a state with NO live
 * child process and NO code path that evicts it — the SessionBridge surfaces
 * termination only via `onExit`, but when the bridge instead spins forever in
 * its WS reconnect-backoff loop (hub down / auth bounce → never authenticates →
 * runner never spawns → never reaches 'running', and non-terminal WS close
 * codes never call `onExit`), the entry pins a slot indefinitely. After enough
 * churn every slot is pinned and `start()` rejects everything with
 * `concurrency_cap` while the hub DB shows zero live runs.
 *
 * Prod evidence: supervisor TitaniumTower v0.7.0, concurrency_budget=10, every
 * `session.start` (incl. orchestrator + scheduled tasks) rejected
 * `concurrency_cap` while hub showed 0 active session_runs and the supervisor
 * reported state=idle / current_run_id=null. A full restart cleared it.
 *
 * Fix: `reconcileSlots()` runs on every cap evaluation and evicts any counted
 * slot whose bridge is not alive (no open WS, no live runner) and that has been
 * stranded past SLOT_STALE_GRACE_MS. A pinned counter self-heals back to
 * reality without a supervisor restart.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'fs'
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

interface BridgeCall {
  opts: SessionBridgeOptions
  cb: SessionBridgeCallbacks
  fake: FakeBridge
}
const bridges: BridgeCall[] = []

class FakeBridge {
  startCalls = 0
  stopCalls = 0
  /** Liveness as the reconciler sees it. A bridge stuck in the reconnect loop
   *  with no runner reports false. */
  alive = true
  start() { this.startCalls++ }
  async stop() { this.stopCalls++; this.alive = false }
  isAlive() { return this.alive }
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
    repoPath: REPO_A,
    branch: null,
    initialPrompt: null,
    apiKey: 'olx_test',
    hubUrl: 'https://example.test',
    ...over,
  }
}

const realNow = Date.now
function advanceClock(ms: number) {
  const base = realNow()
  Date.now = () => base + ms
}
function resetClock() {
  Date.now = realNow
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-pm-reconcile-'))
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

beforeEach(() => {
  bridges.length = 0
  if (existsSync(AUDIT_PATH)) { try { rmSync(AUDIT_PATH) } catch {} }
})

afterEach(() => { resetClock() })

describe('ProcessManager.reconcileSlots — self-heal of stranded slots', () => {
  test('stranded "starting" slot (bridge never authenticated) is reclaimed; a new launch is allowed', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))

    // Run starts; bridge never reaches running (no onSpawned) and gets stuck in
    // the reconnect loop → reports not alive. This is the leak vector.
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    bridges[0].fake.alive = false

    // Within grace: slot still counted, cap still enforced (no premature reclaim
    // of a session that might just be mid-reconnect).
    const rEarly = await pm.start(spec({ runId: 'r-early', repoPath: REPO_B }))
    expect(rEarly?.reason).toBe('concurrency_cap')

    // Past grace: the stranded slot is reclaimed, a fresh launch is allowed.
    advanceClock(31_000)
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_B }))
    expect(r2).toBeNull()
  })

  test('abnormal exit without finalize then dead bridge: count returns to 0, relaunch allowed', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 4321 }) // → running

    // Simulate the leak: the child process dies / WS drops but `onExit` is never
    // delivered to the ProcessManager (e.g. runner killed by OS while the bridge
    // is detached mid-reconnect). The slot is stranded in 'running'.
    bridges[0].fake.alive = false

    advanceClock(31_000)
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_A }))
    expect(r2).toBeNull()
    // Bridge of the reclaimed run was torn down.
    expect(bridges[0].fake.stopCalls).toBeGreaterThanOrEqual(1)
  })

  test('pinned cap (every slot stranded) self-heals back down', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 3 }))
    for (const [id, repo] of [['r1', REPO_A], ['r2', REPO_B], ['r3', join(ROOT, 'repo-c')]] as const) {
      if (!existsSync(repo)) mkdirSync(join(repo, '.git'), { recursive: true })
      const r = await pm.start(spec({ runId: id, repoPath: repo }))
      expect(r).toBeNull()
    }
    const REPO_D = join(ROOT, 'repo-d')
    if (!existsSync(REPO_D)) mkdirSync(join(REPO_D, '.git'), { recursive: true })
    // All three strand (hub outage): every bridge stuck, none alive → cap pinned.
    for (const b of bridges) b.fake.alive = false
    const blocked = await pm.start(spec({ runId: 'rx', repoPath: REPO_D }))
    expect(blocked?.reason).toBe('concurrency_cap')

    advanceClock(31_000)
    const ok = await pm.start(spec({ runId: 'ry', repoPath: REPO_D }))
    expect(ok).toBeNull()
  })

  test('a LIVE session is never reclaimed even past the grace window', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 99 }) // running, bridge stays alive=true

    advanceClock(120_000) // long idle, but bridge reports alive (open WS)
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_B }))
    expect(r2?.reason).toBe('concurrency_cap')
  })
})

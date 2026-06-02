/**
 * Regression coverage for the v0.8.5 (#237) orchestrator "green then gray" reap.
 *
 * Root cause chain:
 *   1. SessionBridge reports spawn via `onSpawned({ pid: 0 })` — the stream-json
 *      ClaudeRunner never surfaces a real OS pid through the `ready` event, so it
 *      is hardcoded to 0 (best-effort placeholder, NOT a real pid).
 *   2. ProcessManager.spawn's onSpawned handler does `run.pid = info.pid || null`.
 *      `0 || null === null`, so a *successfully spawned* runner has pid === null.
 *   3. #237's reconcileSlots() added `const alive = bridgeAlive && (r.pid != null)`.
 *      With pid permanently null, "alive" collapses to "the bridge WS is open AND
 *      had activity within SLOT_STALE_GRACE_MS". An idle-but-healthy session
 *      (the auto-launched orchestrator, which sits waiting for work and streams
 *      no runner events) is reaped 30s after start → green→gray.
 *
 * Live evidence (2026-06-02): supervisor v0.8.5 /sup/status showed a healthy
 * `running` runner for C:/Users/artic/GitHub/remo-code with `pid:null`; the
 * orchestrator (repos-parent root) got `allowed:true` repeatedly in audit.jsonl
 * but never stayed up.
 *
 * The pre-existing slot-reconcile test masked the bug by feeding `onSpawned({
 * pid: 99 })` — a fake non-zero pid that the real bridge never produces.
 *
 * Fix contract: a run whose bridge has actually spawned a runner (spawnReported)
 * and whose bridge is alive must NEVER be reclaimed, regardless of pid value or
 * idle time. A bridge that authenticated (WS open) but never spawned a runner is
 * still reclaimable past the grace window (preserves the #237 leak fix).
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

/** Mirrors the real SessionBridge liveness contract:
 *  - isAlive(): true while the hub WS is open OR a runner is live.
 *  - hasSpawnedRunner(): true once onSpawned has fired (spawnReported).
 *  The real bridge reports spawn with pid:0, which the ProcessManager stores as
 *  null — so this fake also drives onSpawned with pid:0 to reproduce reality. */
class FakeBridge {
  startCalls = 0
  stopCalls = 0
  alive = true
  spawned = false
  start() { this.startCalls++ }
  async stop() { this.stopCalls++; this.alive = false }
  isAlive() { return this.alive }
  hasSpawnedRunner() { return this.spawned }
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
  TMP = mkdtempSync(join(tmpdir(), 'remo-pm-orch-'))
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

describe('ProcessManager.reconcileSlots — orchestrator green→gray regression (#237)', () => {
  test('an idle-but-spawned session reporting onSpawned({pid:0}) is NEVER reclaimed', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'orch', repoPath: REPO_A }))
    expect(r1).toBeNull()

    // Reproduce the REAL bridge: spawn reported with pid:0 (→ run.pid === null),
    // bridge WS stays open (alive), but the session is idle (no activity bumps).
    bridges[0].fake.spawned = true
    bridges[0].cb.onSpawned!({ pid: 0 })

    // Long idle past the stale grace — exactly when the orchestrator dies today.
    advanceClock(120_000)

    // The live, spawned session must still hold its slot. Pre-fix this returned
    // null (slot reclaimed → orchestrator reaped → a fresh launch admitted).
    const r2 = await pm.start(spec({ runId: 'other', repoPath: REPO_B }))
    expect(r2?.reason).toBe('concurrency_cap')
    expect(bridges[0].fake.stopCalls).toBe(0)
  })

  test('a bridge that authenticated but NEVER spawned a runner is still reclaimed (preserves #237 leak fix)', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()

    // WS open (alive) but runner never spawned — the stranded-slot leak vector.
    bridges[0].fake.alive = true
    bridges[0].fake.spawned = false

    advanceClock(31_000)
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_B }))
    expect(r2).toBeNull()
    expect(bridges[0].fake.stopCalls).toBeGreaterThanOrEqual(1)
  })
})

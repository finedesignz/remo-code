/**
 * Regression coverage for the 2026-06-01 production concurrency-cap lockout.
 *
 * Two defects, both observed live on supervisor v0.8.3 (fresh boot, then
 * accumulated to 8 stranded runners, queue_depth=8, every session.start denied
 * `concurrency_cap` for ~24h):
 *
 *   A. DUPLICATE-RUN ACCUMULATION KEYED ON run_id.
 *      `start()` dedup was `this.runs.has(spec.runId)` only. The scheduler /
 *      continue-dev rotation fires a fresh `session.start` for the same repo
 *      every ~15-30 min with a NEW run_id but the SAME project_dir. Each one
 *      minted a SECOND counted runner for an already-active project — the live
 *      evidence showed kh-hub x2, mcp-servers x2, ottolax x2 (same project_dir,
 *      different run_id). That is the primary leak: N identical-project runners
 *      pin N slots. Fix: dedup by project_dir for any non-crashed active run —
 *      a repeated start for an already-active project is `duplicate_run`.
 *
 *   B. RECONCILER CANNOT RECLAIM A pid:null / no-child STRANDED SLOT.
 *      The real SessionBridge.isAlive() returns true whenever its hub WS is
 *      OPEN, even if the `claude` child never spawned (pid:null). A bridge that
 *      authenticated but never spawned a runner pins its slot forever; the
 *      reconciler (which trusts isAlive()) never reclaims it. Fix: a run that
 *      never reported a pid (never reached 'running' with a live child) and is
 *      not alive-with-a-runner is reclaimable once stranded past the grace
 *      window — a never-spawned bridge counts as not-alive for reconciliation.
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

/** Models the real SessionBridge contract: a bridge with an OPEN hub WS but no
 *  spawned runner reports alive===true (wsOpen) even though pid is null. */
class FakeBridge {
  startCalls = 0
  stopCalls = 0
  wsOpen = true
  hasRunner = false
  start() { this.startCalls++ }
  async stop() { this.stopCalls++; this.wsOpen = false; this.hasRunner = false }
  isAlive() { return this.wsOpen || this.hasRunner }
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
    maxConcurrent: 10,
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
  TMP = mkdtempSync(join(tmpdir(), 'remo-pm-dedup-'))
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

describe('Defect A — dedup by project_dir (the duplicate-runner leak)', () => {
  test('repeated session.start for an already-RUNNING project (new run_id) is duplicate_run, no second slot', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 10 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 1234 }) // → running

    // Scheduler fires again for the SAME repo with a fresh run_id.
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_A }))
    expect(r2?.reason).toBe('duplicate_run')
    // No second bridge minted.
    expect(bridges.length).toBe(1)
  })

  test('repeated session.start while still STARTING (pre-onSpawned) is duplicate_run', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 10 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    // No onSpawned yet — state is 'starting'.
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_A }))
    expect(r2?.reason).toBe('duplicate_run')
    expect(bridges.length).toBe(1)
  })

  test('rotation across DIFFERENT repos does NOT collapse the cap (no false dedup)', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 10 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_B }))
    expect(r1).toBeNull()
    expect(r2).toBeNull()
    expect(bridges.length).toBe(2)
  })

  test('the live-prod accumulation pattern: N repeats of 3 repos never exceed 3 slots', async () => {
    const REPO_C = join(ROOT, 'repo-c')
    if (!existsSync(REPO_C)) mkdirSync(join(REPO_C, '.git'), { recursive: true })
    const { pm } = makePM(makeCfg({ maxConcurrent: 10 }))
    const repos = [REPO_A, REPO_B, REPO_C]
    // 5 rotation cycles, fresh run_id every time (the scheduler behavior).
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const repo of repos) {
        await pm.start(spec({ runId: `run_${cycle}_${repo}`, repoPath: repo }))
      }
    }
    // First-cycle starts spawned; transition them running.
    for (const b of bridges) b.cb.onSpawned!({ pid: 1 })
    // Exactly one runner per distinct repo — the cap is NOT pinned.
    expect(bridges.length).toBe(3)
    expect(pm.activeRuns.length).toBe(3)
  })
})

describe('Defect B — reconciler reclaims a pid:null / no-child stranded slot', () => {
  test('bridge authenticated (wsOpen) but child never spawned (pid:null) is reclaimed past grace', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    // Bridge connected to hub (wsOpen=true) but the claude child never spawned:
    // no onSpawned → pid stays null, state stuck at 'starting'. Real isAlive()
    // returns TRUE here (wsOpen) — the leak. Keep the fake faithful to that.
    expect(bridges[0].fake.isAlive()).toBe(true)

    // Within grace: not reclaimed (could be legitimately mid-spawn).
    const rEarly = await pm.start(spec({ runId: 'r-early', repoPath: REPO_B }))
    expect(rEarly?.reason).toBe('concurrency_cap')

    // Past grace: a run that never reported a pid is reclaimable even though the
    // bridge's WS is open. The fresh launch must be allowed.
    advanceClock(31_000)
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_B }))
    expect(r2).toBeNull()
    expect(bridges[0].fake.stopCalls).toBeGreaterThanOrEqual(1)
  })

  test('a run that DID spawn a pid and is still alive is never reclaimed', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'r1', repoPath: REPO_A }))
    expect(r1).toBeNull()
    bridges[0].cb.onSpawned!({ pid: 777 }) // pid reported, running
    bridges[0].fake.hasRunner = true

    advanceClock(120_000)
    const r2 = await pm.start(spec({ runId: 'r2', repoPath: REPO_B }))
    expect(r2?.reason).toBe('concurrency_cap')
  })
})

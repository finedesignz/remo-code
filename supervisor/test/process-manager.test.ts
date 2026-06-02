import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProcessManager, type RunSpec } from '../src/process-manager'
import type { SupervisorConfig } from '../src/config'
import type { SessionBridgeCallbacks, SessionBridgeOptions } from '../src/runners/session-bridge'

let TMP: string
let ROOT: string
let REPO_GIT: string
let REPO_GIT_2: string
let REPO_NOGIT: string
let AUDIT_PATH: string

// ---------- bridge factory spy ----------
interface BridgeCall {
  opts: SessionBridgeOptions
  cb: SessionBridgeCallbacks
  fake: FakeBridge
}
const bridges: BridgeCall[] = []

/** Minimal fake SessionBridge — counts start/stop calls, lets the test fire
 *  `onSpawned` / `onExit` callbacks manually to simulate runner lifecycle. */
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
    runId: 'run_' + Math.random().toString(36).slice(2, 8),
    repoPath: REPO_GIT,
    branch: null,
    initialPrompt: null,
    apiKey: 'olx_test',
    hubUrl: 'https://example.test',
    ...over,
  }
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-pm-'))
  ROOT = join(TMP, 'gh')
  REPO_GIT = join(ROOT, 'repo-with-git')
  REPO_GIT_2 = join(ROOT, 'repo-with-git-2')
  REPO_NOGIT = join(ROOT, 'repo-no-git')
  AUDIT_PATH = join(TMP, 'audit.jsonl')
  mkdirSync(REPO_GIT, { recursive: true })
  mkdirSync(REPO_GIT_2, { recursive: true })
  mkdirSync(REPO_NOGIT, { recursive: true })
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

describe('ProcessManager security gates', () => {
  test('sandbox_escape: rejects path outside configured roots', async () => {
    const { pm, events } = makePM(makeCfg())
    const outsidePath = TMP // outside ROOT
    const r = await pm.start(spec({ repoPath: outsidePath }))
    expect(r?.reason).toBe('sandbox_escape')
    expect(bridges.length).toBe(0)
    expect(events.find((e) => e.state === 'stopped')).toBeTruthy()
  })

  test('sandbox_escape: rejects C:\\Windows\\System32', async () => {
    const { pm } = makePM(makeCfg())
    const r = await pm.start(spec({ repoPath: 'C:\\Windows\\System32' }))
    expect(r?.reason).toBe('sandbox_escape')
    expect(bridges.length).toBe(0)
  })

  test('session.start spawns SessionBridge via in-process claude-runner (NOT legacy npx agent)', async () => {
    // Post-2026-05-27 fix: gates pass → bridge is constructed via the factory.
    // Once `onSpawned` fires, the run transitions to 'running' and stays
    // there until the bridge reports exit.
    const { pm, events } = makePM(makeCfg())
    const r = await pm.start(spec({ repoPath: REPO_GIT, runId: 'rspawn' }))
    expect(r).toBeNull()
    expect(bridges.length).toBe(1)
    expect(bridges[0].opts.repoPath).toBe(REPO_GIT)
    expect(bridges[0].opts.runId).toBe('rspawn')
    expect(bridges[0].fake.startCalls).toBe(1)
    expect(bridges[0].opts.allowDangerousSkipPermissions).toBe(false)
    // Bridge reports spawn; PM should transition to running.
    bridges[0].cb.onSpawned({ pid: 4242 })
    expect(events.some((e) => e.state === 'running')).toBe(true)
  })

  test('not_git_repo: rejects when restrictToGit=true and no .git', async () => {
    const { pm } = makePM(makeCfg({ requireGitRepo: true }))
    const r = await pm.start(spec({ repoPath: REPO_NOGIT }))
    expect(r?.reason).toBe('not_git_repo')
    expect(bridges.length).toBe(0)
  })

  test('git gate is opt-in: with restrictToGit=false a non-git dir passes gates + spawns bridge', async () => {
    const { pm } = makePM(makeCfg({ requireGitRepo: false }))
    const r = await pm.start(spec({ repoPath: REPO_NOGIT }))
    expect(r).toBeNull()
    expect(bridges.length).toBe(1)
  })

  test('concurrency_cap: second start refused while first is active', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    const r1 = await pm.start(spec({ runId: 'a', repoPath: REPO_GIT }))
    expect(r1).toBeNull()
    expect(bridges.length).toBe(1)
    // First run is in 'starting' state (no onSpawned yet) — still occupies a slot.
    // Second start is for a DIFFERENT repo so it is not deduped — it must hit the cap.
    const r2 = await pm.start(spec({ runId: 'b', repoPath: REPO_GIT_2 }))
    expect(r2?.reason).toBe('concurrency_cap')
    expect(bridges.length).toBe(1) // no second bridge constructed
  })

  test('dangerous-skip flag stripped when cap OFF; bridge still receives allowDangerous=false', async () => {
    const { pm, logs } = makePM(makeCfg({ allowDangerousSkipPermissions: false }))
    await pm.start(spec({ dangerouslySkipPermissions: true }))
    expect(bridges.length).toBe(1)
    expect(bridges[0].opts.allowDangerousSkipPermissions).toBe(false)
    expect(logs.some((l) => l.msg.includes('flag stripped'))).toBe(true)
  })

  test('dangerous-skip honored when cap ON: bridge receives allowDangerous=true', async () => {
    const { pm } = makePM(makeCfg({ allowDangerousSkipPermissions: true }))
    await pm.start(spec({ dangerouslySkipPermissions: true }))
    expect(bridges.length).toBe(1)
    expect(bridges[0].opts.allowDangerousSkipPermissions).toBe(true)
  })

  test('audit log appends one JSONL entry per decision (allow + reject)', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    await pm.start(spec({ runId: 'a', repoPath: REPO_GIT }))      // allowed
    await pm.start(spec({ runId: 'b', repoPath: REPO_GIT_2 }))    // concurrency_cap (distinct repo, at budget)
    await pm.start(spec({ runId: 'c', repoPath: TMP }))           // sandbox escape
    const lines = readFileSync(AUDIT_PATH, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(3)
    const parsed = lines.map((l) => JSON.parse(l))
    expect(parsed[0].allowed).toBe(true)
    expect(parsed[1].allowed).toBe(false)
    expect(parsed[1].reason).toBe('concurrency_cap')
    expect(parsed[2].allowed).toBe(false)
    expect(parsed[2].reason).toBe('sandbox_escape')
  })

  test('audit log: prompt is hashed, never raw', async () => {
    const { pm } = makePM(makeCfg())
    await pm.start(spec({ initialPrompt: 'secret prompt 123' }))
    const line = readFileSync(AUDIT_PATH, 'utf-8').trim()
    expect(line).not.toContain('secret prompt 123')
    const entry = JSON.parse(line)
    expect(entry.prompt_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('audit log is skipped when auditLogEnabled=false', async () => {
    const { pm } = makePM(makeCfg({ auditLogEnabled: false }))
    await pm.start(spec())
    expect(existsSync(AUDIT_PATH)).toBe(false)
  })

  test('updateConfig() takes effect on next start', async () => {
    const { pm } = makePM(makeCfg({ allowDangerousSkipPermissions: false, maxConcurrent: 5 }))
    await pm.start(spec({ runId: 'a', dangerouslySkipPermissions: true }))
    pm.updateConfig(makeCfg({ allowDangerousSkipPermissions: true, maxConcurrent: 5 }))
    await pm.start(spec({ runId: 'b', dangerouslySkipPermissions: true }))
    const lines = readFileSync(AUDIT_PATH, 'utf-8').trim().split('\n')
    const entries = lines.map((l) => JSON.parse(l))
    expect(entries[0].flags.dangerously_skip_permissions_applied).toBe(false)
    expect(entries[1].flags.dangerously_skip_permissions_applied).toBe(true)
  })

  test('bridge onExit with non-zero code triggers scheduleRestart (crash path)', async () => {
    const { pm, events } = makePM(makeCfg({ maxConcurrent: 5 }))
    await pm.start(spec({ runId: 'crashy' }))
    expect(bridges.length).toBe(1)
    bridges[0].cb.onSpawned({ pid: 1 })
    // Simulate a crash.
    bridges[0].cb.onExit({ code: 137, reason: 'runner_exit' })
    // Should transition to 'crashed' and schedule a restart (we don't await the timer).
    expect(events.some((e) => e.state === 'crashed')).toBe(true)
  })
})

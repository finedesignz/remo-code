/**
 * Circuit-breaker self-heal (fix/stop-the-bleed).
 *
 * REGRESSION: prod 2026-07-07 → 07-11 the TitaniumTower supervisor's spawn
 * breaker tripped and LATCHED OPEN — no cooldown, no half-open probe, no
 * hub-visible signal. Zero CLI spawns for four days while the hub reported
 * perfectly healthy; scheduled tasks / orchestrator / Telegram all silently
 * no-opped and a human had to notice and restart the supervisor by hand.
 *
 * Proven here:
 *   1. opens on repeated crashes (and refuses further starts for that repo)
 *   2. transitions to HALF-OPEN after the cooldown and fires one probe spawn
 *   3. CLOSES on a successful probe (spawn reaches `running`)
 *   4. RE-OPENS if the probe crashes
 *   5. is VISIBLE — circuitBreakerSnapshot() is what rides the hub inventory push
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProcessManager, type RunSpec } from '../src/process-manager'
import type { SupervisorConfig } from '../src/config'
import type { SessionBridgeCallbacks, SessionBridgeOptions } from '../src/runners/session-bridge'

let TMP: string
let ROOT: string
let REPO: string
let AUDIT_PATH: string

interface BridgeCall {
  opts: SessionBridgeOptions
  cb: SessionBridgeCallbacks
}
const bridges: BridgeCall[] = []

class FakeBridge {
  start() {}
  async stop() {}
  isAlive() { return true }
}

function bridgeFactorySpy(opts: SessionBridgeOptions, cb: SessionBridgeCallbacks): any {
  bridges.push({ opts, cb })
  return new FakeBridge()
}

function makeCfg(): SupervisorConfig {
  return {
    hubUrl: 'https://example.test',
    apiKey: 'olx_test',
    roots: [ROOT],
    maxConcurrent: 5,
    allowDangerousSkipPermissions: false,
    requireGitRepo: false,
    auditLogEnabled: false,
    auditLogPath: AUDIT_PATH,
    killSwitchHotkey: 'Ctrl+Shift+Alt+K',
    autostart: false,
  }
}

function makePM() {
  const logs: Array<{ level: string; msg: string }> = []
  const events: Array<{ state: string; info: any }> = []
  const pm = new ProcessManager(
    {
      onStateChange: (state, info) => events.push({ state, info }),
      onLog: (level, msg) => logs.push({ level, msg }),
    },
    makeCfg(),
  )
  pm.bridgeFactory = bridgeFactorySpy as any
  pm.circuitCooldownMs = 25 // keep the test fast
  return { pm, logs, events }
}

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: 'run_' + Math.random().toString(36).slice(2, 8),
    repoPath: REPO,
    branch: null,
    initialPrompt: null,
    apiKey: 'olx_test',
    hubUrl: 'https://example.test',
    ...over,
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Bridges spawned for one test's run (probe runIds are `<runId>-probeN`).
 *  Scoped by runId prefix because a prior test's cooldown timer may still fire
 *  into the shared `bridges` array. */
const bridgesFor = (prefix: string) => bridges.filter((b) => b.opts.runId.startsWith(prefix))

/** Crash the newest bridge enough times to trip the breaker (threshold = 5). */
function crashUntilOpen(cb: SessionBridgeCallbacks) {
  for (let i = 0; i < 5; i++) cb.onExit({ code: 137, reason: 'runner_exit' })
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-cb-'))
  ROOT = join(TMP, 'gh')
  REPO = join(ROOT, 'repo')
  AUDIT_PATH = join(TMP, 'audit.jsonl')
  mkdirSync(join(REPO, '.git'), { recursive: true })
})

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  bridges.length = 0
})

describe('ProcessManager circuit breaker', () => {
  test('opens on repeated crashes, is reported, and refuses further starts', async () => {
    const { pm, events } = makePM()
    await pm.start(spec({ runId: 'c1' }))
    bridges[0].cb.onSpawned({ pid: 1 })
    crashUntilOpen(bridges[0].cb)

    // Run stopped with circuit_open (unchanged from the old behaviour)...
    expect(events.some((e) => e.state === 'stopped' && e.info?.lastExit?.reason === 'circuit_open')).toBe(true)

    // ...but it is now VISIBLE (this snapshot rides the session_inventory push).
    const snap = pm.circuitBreakerSnapshot()
    expect(snap.length).toBe(1)
    expect(snap[0].repo_path).toBe(REPO)
    expect(snap[0].state).toBe('open')
    expect(snap[0].exhausted).toBe(false)

    // While open, a fresh start for that repo is refused (no spawn).
    const before = bridgesFor('c').length
    const rejected = await pm.start(spec({ runId: 'c2' }))
    expect(rejected?.reason).toBe('circuit_open')
    expect(bridgesFor('c').length).toBe(before)
  })

  test('transitions to half-open after the cooldown and fires ONE probe spawn', async () => {
    const { pm } = makePM()
    await pm.start(spec({ runId: 'h1' }))
    bridgesFor('h1')[0].cb.onSpawned({ pid: 1 })
    crashUntilOpen(bridgesFor('h1')[0].cb)
    expect(pm.circuitBreakerSnapshot()[0].state).toBe('open')

    expect(bridgesFor('h1').length).toBe(1)
    await sleep(60) // > cooldown (25ms)

    // Exactly one probe spawn (runId `h1-probe1`).
    expect(bridgesFor('h1').length).toBe(2)
    expect(bridgesFor('h1-probe').length).toBe(1)
    expect(pm.circuitBreakerSnapshot()[0].state).toBe('half_open')
  })

  test('CLOSES on a successful probe — the supervisor self-heals with no human restart', async () => {
    const { pm } = makePM()
    await pm.start(spec({ runId: 's1' }))
    bridgesFor('s1')[0].cb.onSpawned({ pid: 1 })
    crashUntilOpen(bridgesFor('s1')[0].cb)
    await sleep(60)

    // Probe spawns successfully → breaker closes.
    const probe = bridgesFor('s1-probe')[0]
    probe.cb.onSpawned({ pid: 2 })

    expect(pm.circuitBreakerSnapshot()).toEqual([])
    // And a normal start for the repo is admitted again (not circuit_open).
    const r = await pm.start(spec({ runId: 's2' }))
    expect(r?.reason).not.toBe('circuit_open')
  })

  test('RE-OPENS if the probe crashes, with a longer cooldown and a failed-probe count', async () => {
    const { pm } = makePM()
    await pm.start(spec({ runId: 'r1' }))
    bridgesFor('r1')[0].cb.onSpawned({ pid: 1 })
    crashUntilOpen(bridgesFor('r1')[0].cb)
    await sleep(60)
    expect(pm.circuitBreakerSnapshot()[0].state).toBe('half_open')

    // ONE crash while half-open re-opens immediately (no re-earning the threshold).
    const probe = bridgesFor('r1-probe')[0]
    probe.cb.onExit({ code: 1, reason: 'runner_exit' })

    const snap = pm.circuitBreakerSnapshot()
    expect(snap[0].state).toBe('open')
    expect(snap[0].failed_probes).toBe(1)
    expect(snap[0].exhausted).toBe(false)
    expect((await pm.start(spec({ runId: 'r2' })))?.reason).toBe('circuit_open')
  })
})

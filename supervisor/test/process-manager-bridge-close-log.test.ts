/**
 * A failed `bridge.stop()` during teardown must be LOGGED, not silently
 * swallowed (`void run.bridge.stop().catch(() => {})`). A silent failure here
 * reproduces the "hub never learns the session died" bug: the bridge's
 * `/ws/agent` connection may stay open, so `sessions.status` never flips to
 * 'offline' and `ensureSessionOnline` never respawns it — and nothing tells
 * an operator that the close itself failed. See process-manager.ts's
 * `closeBridge()` and the circuit-breaker / max-restarts teardown call sites.
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
  fake: FakeBridge
}
const bridges: BridgeCall[] = []

/** stop() always rejects — simulates a bridge that fails to close cleanly. */
class FailingStopBridge {
  start() {}
  async stop() {
    throw new Error('ECONNRESET during ws close')
  }
  isAlive() { return true }
}

function bridgeFactorySpy(opts: SessionBridgeOptions, cb: SessionBridgeCallbacks): any {
  const fake = new FailingStopBridge()
  bridges.push({ opts, cb, fake: fake as any })
  return fake
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
  pm.circuitCooldownMs = 25
  pm.circuitProbeHealthyMs = 25
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

/** Crash the newest bridge enough times to trip the breaker (threshold = 5). */
function crashUntilOpen(cb: SessionBridgeCallbacks) {
  for (let i = 0; i < 5; i++) cb.onExit({ code: 137, reason: 'runner_exit' })
}

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-bridge-close-log-'))
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

describe('ProcessManager bridge-close failure logging', () => {
  test('a failed bridge.stop() during circuit-breaker teardown is logged, not swallowed', async () => {
    const { pm, logs } = makePM()
    await pm.start(spec({ runId: 'bc1' }))
    bridges[0].cb.onSpawned({ pid: 1 })
    crashUntilOpen(bridges[0].cb)

    // Let the rejected promise's .catch() microtask run.
    await new Promise((r) => setTimeout(r, 10))

    const failureLog = logs.find(
      (l) => l.level === 'warn' && /bridge\.stop\(\) failed/.test(l.msg) && /ECONNRESET during ws close/.test(l.msg),
    )
    expect(failureLog).toBeDefined()
  })
})

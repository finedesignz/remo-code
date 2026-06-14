/**
 * Phase 19 / 19-02 — default-backend selector fail-safe + gated-flip tests.
 * Threats T-19-02 / 02b / 02c / 02d (R-PTY-22 / 22b / 22c).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveHumanBackend,
  isClaudePtyDisabled,
  __setSelectorAlertForTest,
  type BackendSelectorConfig,
  type HumanSessionContext,
} from '../src/runners/backend-selector'
import {
  runnerForHumanBackend,
  selectHumanPtyRunner,
} from '../src/runners/runner-factory'
import {
  __setHostSpawnForTest,
  type HostHandle,
} from '../src/runners/claude-pty-runner'
import { __setCodexHostSpawnForTest } from '../src/runners/codex-pty-runner'
import { ClaudePtyBridge, CodexPtyBridge } from '../src/runners/claude-pty-bridge'

const human: HumanSessionContext = { isHuman: true }

function cfg(over: Partial<BackendSelectorConfig> = {}): BackendSelectorConfig {
  return {
    defaultHumanBackend: 'claude',
    gate: { result: 'unknown', claudeInteractiveConfirmed: false },
    ...over,
  }
}

describe('19-02 fail-safe default (T-19-02)', () => {
  test('gate flag unset => codex-pty even when config says claude', () => {
    expect(resolveHumanBackend(human, cfg({ defaultHumanBackend: 'claude' }))).toBe('codex-pty')
  })

  test('never returns claude-pty when unconfirmed, for any config', () => {
    for (const d of ['claude', 'codex'] as const) {
      expect(resolveHumanBackend(human, cfg({ defaultHumanBackend: d }))).toBe('codex-pty')
    }
  })
})

describe('19-02 gated flip (R-PTY-22)', () => {
  test('confirmed + config claude => claude-pty', () => {
    expect(
      resolveHumanBackend(
        human,
        cfg({ defaultHumanBackend: 'claude', gate: { result: 'interactive', claudeInteractiveConfirmed: true } }),
      ),
    ).toBe('claude-pty')
  })

  test('confirmed + config codex => codex-pty', () => {
    expect(
      resolveHumanBackend(
        human,
        cfg({ defaultHumanBackend: 'codex', gate: { result: 'interactive', claudeInteractiveConfirmed: true } }),
      ),
    ).toBe('codex-pty')
  })
})

describe('19-02 hard-reject legacy/non-PTY ids (T-19-02b)', () => {
  test('polluted config id throws (no silent downgrade)', () => {
    for (const bad of ['stream-json', 'claude-runner', 'legacy', 'claude-stream-json']) {
      expect(() =>
        resolveHumanBackend(human, cfg({ defaultHumanBackend: bad as any })),
      ).toThrow()
    }
  })

  test('legacy stream-json id is NEVER a return value for any input', () => {
    const inputs: BackendSelectorConfig[] = [
      cfg(),
      cfg({ defaultHumanBackend: 'codex' }),
      cfg({ gate: { result: 'interactive', claudeInteractiveConfirmed: true } }),
      cfg({ defaultHumanBackend: 'codex', gate: { result: 'programmatic', claudeInteractiveConfirmed: false } }),
    ]
    for (const c of inputs) {
      const out = resolveHumanBackend(human, c)
      expect(['claude-pty', 'codex-pty']).toContain(out)
      expect(out).not.toBe('stream-json')
      expect(out).not.toBe('claude')
      expect(out).not.toBe('codex')
    }
  })
})

describe('19-02 defense-in-depth human-only (T-19-02c)', () => {
  test('isHuman:false => throws (automation never gets a PTY backend)', () => {
    expect(() => resolveHumanBackend({ isHuman: false }, cfg())).toThrow()
    expect(() => resolveHumanBackend({} as any, cfg())).toThrow()
  })
})

describe('19-02 post-failed-gate disable (T-19-02d)', () => {
  test('programmatic result => claude-pty never returned, even when config requests it', () => {
    const restore = __setSelectorAlertForTest(() => {})
    try {
      const c = cfg({
        defaultHumanBackend: 'claude',
        gate: { result: 'programmatic', claudeInteractiveConfirmed: true },
      })
      expect(isClaudePtyDisabled(c.gate)).toBe(true)
      expect(resolveHumanBackend(human, c)).toBe('codex-pty')
    } finally {
      restore()
    }
  })

  test('programmatic disable emits an alert when claude requested', () => {
    let alerted = ''
    const restore = __setSelectorAlertForTest((m) => (alerted = m))
    try {
      resolveHumanBackend(
        human,
        cfg({ defaultHumanBackend: 'claude', gate: { result: 'programmatic', claudeInteractiveConfirmed: true } }),
      )
      expect(alerted.toLowerCase()).toContain('disabled')
    } finally {
      restore()
    }
  })

  test('operator override re-enables claude-pty after programmatic (with confirm)', () => {
    expect(
      resolveHumanBackend(
        human,
        cfg({
          defaultHumanBackend: 'claude',
          gate: { result: 'programmatic', claudeInteractiveConfirmed: true, operatorOverrideClaudePty: true },
        }),
      ),
    ).toBe('claude-pty')
  })
})

describe('19-02 gate flag is operator-set, not auto-flipped', () => {
  test('no production code writes claudeInteractiveConfirmed', () => {
    const srcDir = join(import.meta.dir, '..', 'src')
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith('.ts') && !e.name.endsWith('backend-selector.ts')) {
          const txt = readFileSync(p, 'utf8')
          // an assignment TO the flag (not a read/destructure) in runtime code
          if (/claudeInteractiveConfirmed\s*=/.test(txt)) offenders.push(p)
        }
      }
    }
    walk(srcDir)
    expect(offenders).toEqual([])
  })
})

// ---- SELECTOR -> SPAWN-ARGV negative test (PARTIAL-binding, H8) ----
// For EACH backend the selector can return, drive the resolved id through the
// runner's REAL spawn path (intercept node-pty host spawn) and assert the
// spawned argv + spawn frame carry NO programmatic flag.
const FORBIDDEN = ['-p', '--print', '--input-format', '--output-format', 'stream-json']

function makeCapture(): { file: string; argv: string[]; frames: any[]; fake: any } {
  const cap: any = { file: '', argv: [], frames: [] }
  cap.fake = (file: string, argv: string[]): HostHandle => {
    cap.file = file
    cap.argv = argv
    let acc = Buffer.alloc(0)
    return {
      pid: 1,
      stdin: {
        write(chunk: Buffer | string) {
          acc = Buffer.concat([acc, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)])
          while (acc.length >= 4) {
            const len = acc.readUInt32BE(0)
            if (acc.length < 4 + len) break
            try { cap.frames.push(JSON.parse(acc.subarray(4, 4 + len).toString('utf8'))) } catch {}
            acc = acc.subarray(4 + len)
          }
        },
      },
      stdout: { on() {} },
      on() {},
      kill() {},
    }
  }
  return cap
}

describe('19-02 selector->spawn-argv carries no programmatic flag (H8)', () => {
  let restores: Array<() => void> = []
  // PTY-cutover Phase A: the H8 negative tests drive the NODE PtyRunner spawn
  // path (intercepted via __setHostSpawnForTest). The factory only returns the
  // Node runner when the Rust ConPTY host port file is ABSENT, so pin
  // REMO_PTY_HOST_PORT_FILE at a guaranteed-missing path for this block —
  // independent of whether the dev/CI machine has a live Tauri host.
  let prevPortFile: string | undefined
  beforeEach(() => {
    prevPortFile = process.env.REMO_PTY_HOST_PORT_FILE
    process.env.REMO_PTY_HOST_PORT_FILE = join(import.meta.dir, '__no_such_pty_host_port__')
  })
  afterEach(() => {
    restores.forEach((r) => r()); restores = []
    if (prevPortFile === undefined) delete process.env.REMO_PTY_HOST_PORT_FILE
    else process.env.REMO_PTY_HOST_PORT_FILE = prevPortFile
  })

  test('claude-pty resolved runner spawns no programmatic flag', () => {
    const cap = makeCapture()
    restores.push(__setHostSpawnForTest(cap.fake))
    const runner = selectHumanPtyRunner(human, cfg({
      defaultHumanBackend: 'claude',
      gate: { result: 'interactive', claudeInteractiveConfirmed: true },
    }))
    ;(runner as any).start({ cwd: '/tmp', onData() {} })
    const spawnFrame = cap.frames.find((f) => f.t === 'spawn')
    expect(spawnFrame).toBeTruthy()
    expect(spawnFrame.file).toBe('claude')
    expect(spawnFrame.args).toEqual([])
    // The spawn frame's args are the CLI argv handed to the real binary.
    // Assert no forbidden token appears as a discrete argv element, and the
    // host argv contains exactly the pty-host script (no programmatic flags).
    const cliArgs: string[] = cap.frames.flatMap((f: any) => (f.t === 'spawn' ? f.args ?? [] : []))
    for (const f of FORBIDDEN) {
      expect(cliArgs).not.toContain(f)
      // distinctive multi-char flags must not appear even as a substring of an arg
      if (f !== '-p') for (const a of cliArgs) expect(a).not.toContain(f)
    }
    // Host argv = [pty-host.mjs] only; no programmatic flag passed to the host.
    expect(cap.argv.every((a: string) => !FORBIDDEN.filter((x) => x !== '-p').some((x) => a.includes(x)))).toBe(true)
    expect(cap.argv).not.toContain('-p')
  })

  test('codex-pty resolved runner spawns no programmatic flag', () => {
    const cap = makeCapture()
    restores.push(__setCodexHostSpawnForTest(cap.fake))
    const runner = selectHumanPtyRunner(human, cfg({ defaultHumanBackend: 'codex' }))
    ;(runner as any).start({ cwd: '/tmp', onData() {} })
    const spawnFrame = cap.frames.find((f) => f.t === 'spawn')
    expect(spawnFrame).toBeTruthy()
    expect(spawnFrame.file).toBe('codex')
    expect(spawnFrame.args).toEqual([])
    // The spawn frame's args are the CLI argv handed to the real binary.
    // Assert no forbidden token appears as a discrete argv element, and the
    // host argv contains exactly the pty-host script (no programmatic flags).
    const cliArgs: string[] = cap.frames.flatMap((f: any) => (f.t === 'spawn' ? f.args ?? [] : []))
    for (const f of FORBIDDEN) {
      expect(cliArgs).not.toContain(f)
      // distinctive multi-char flags must not appear even as a substring of an arg
      if (f !== '-p') for (const a of cliArgs) expect(a).not.toContain(f)
    }
    // Host argv = [pty-host.mjs] only; no programmatic flag passed to the host.
    expect(cap.argv.every((a: string) => !FORBIDDEN.filter((x) => x !== '-p').some((x) => a.includes(x)))).toBe(true)
    expect(cap.argv).not.toContain('-p')
  })

  test('runnerForHumanBackend maps ids to the Node fallback when no Rust host', () => {
    // port file pinned absent by this describe's beforeEach.
    expect(runnerForHumanBackend('claude-pty').constructor.name).toBe('ClaudePtyRunner')
    expect(runnerForHumanBackend('codex-pty').constructor.name).toBe('CodexPtyRunner')
  })
})

// ---- Operator-gated --dangerously-skip-permissions on the PTY path ----
// The bypass is the SOLE permitted argv token; gated by the start-opt
// `dangerouslySkipPermissions` (threaded from config allowDangerousSkipPermissions).
describe('PTY bypass: dangerouslySkipPermissions threads --dangerously-skip-permissions', () => {
  let restores: Array<() => void> = []
  let prevPortFile: string | undefined
  beforeEach(() => {
    prevPortFile = process.env.REMO_PTY_HOST_PORT_FILE
    // Pin Rust host ABSENT so the Node runner (with captured spawn frame) is used.
    process.env.REMO_PTY_HOST_PORT_FILE = join(import.meta.dir, '__no_such_pty_host_port__')
  })
  afterEach(() => {
    restores.forEach((r) => r()); restores = []
    if (prevPortFile === undefined) delete process.env.REMO_PTY_HOST_PORT_FILE
    else process.env.REMO_PTY_HOST_PORT_FILE = prevPortFile
  })

  const FLAG = '--dangerously-skip-permissions'

  function spawnFrameFor(
    setSpawn: (fn: any) => () => void,
    runner: any,
    startOpts: Record<string, unknown>,
  ): any {
    const cap = makeCapture()
    restores.push(setSpawn(cap.fake))
    runner.start({ cwd: '/tmp', onData() {}, ...startOpts })
    return cap.frames.find((f) => f.t === 'spawn')
  }

  test('claude Node runner: bypass true => args include the flag', () => {
    const r = runnerForHumanBackend('claude-pty')
    const f = spawnFrameFor(__setHostSpawnForTest, r, { dangerouslySkipPermissions: true })
    expect(f.file).toBe('claude')
    expect(f.args).toEqual([FLAG])
  })

  test('claude Node runner: bypass false/absent => empty args', () => {
    const r1 = runnerForHumanBackend('claude-pty')
    const f1 = spawnFrameFor(__setHostSpawnForTest, r1, { dangerouslySkipPermissions: false })
    expect(f1.args).toEqual([])
    const r2 = runnerForHumanBackend('claude-pty')
    const f2 = spawnFrameFor(__setHostSpawnForTest, r2, {})
    expect(f2.args).toEqual([])
  })

  test('codex Node runner: bypass true => args include the flag; false => empty', () => {
    const rOn = runnerForHumanBackend('codex-pty')
    const fOn = spawnFrameFor(__setCodexHostSpawnForTest, rOn, { dangerouslySkipPermissions: true })
    expect(fOn.file).toBe('codex')
    expect(fOn.args).toEqual([FLAG])
    const rOff = runnerForHumanBackend('codex-pty')
    const fOff = spawnFrameFor(__setCodexHostSpawnForTest, rOff, { dangerouslySkipPermissions: false })
    expect(fOff.args).toEqual([])
  })
})

// ---- Rust bridge spawn frame carries the dangerously_skip_permissions field ----
describe('PTY bypass: Rust bridge spawn frame carries dangerously_skip_permissions', () => {
  function bridgeSpawnFrame(BridgeCtor: any, startOpts: Record<string, unknown>): any {
    const frames: any[] = []
    let acc = Buffer.alloc(0)
    const fakeSock: any = {
      on() { return fakeSock },
      end() {},
      write(chunk: Buffer) {
        acc = Buffer.concat([acc, chunk])
        while (acc.length >= 4) {
          const len = acc.readUInt32BE(0)
          if (acc.length < 4 + len) break
          try { frames.push(JSON.parse(acc.subarray(4, 4 + len).toString('utf8'))) } catch {}
          acc = acc.subarray(4 + len)
        }
      },
    }
    const bridge = new BridgeCtor()
    bridge.start({
      sessionId: 's1', cwd: '/tmp', onData() {},
      connectFactory: () => fakeSock,
      ...startOpts,
    })
    return frames.find((f) => f.t === 'spawn')
  }

  test('ClaudePtyBridge: bypass true => field true', () => {
    const f = bridgeSpawnFrame(ClaudePtyBridge, { dangerouslySkipPermissions: true })
    expect(f.cli).toBe('claude')
    expect(f.dangerously_skip_permissions).toBe(true)
  })

  test('ClaudePtyBridge: bypass false/absent => field false', () => {
    expect(bridgeSpawnFrame(ClaudePtyBridge, { dangerouslySkipPermissions: false }).dangerously_skip_permissions).toBe(false)
    expect(bridgeSpawnFrame(ClaudePtyBridge, {}).dangerously_skip_permissions).toBe(false)
  })

  test('CodexPtyBridge: bypass true => field true, cli codex', () => {
    const f = bridgeSpawnFrame(CodexPtyBridge, { dangerouslySkipPermissions: true })
    expect(f.cli).toBe('codex')
    expect(f.dangerously_skip_permissions).toBe(true)
  })
})

// ---- PTY-cutover Phase A: Rust ConPTY bridge is the PRODUCTION runner ----
// When the Rust host has published its loopback-port token file
// (REMO_PTY_HOST_PORT_FILE points at an existing file), runnerForHumanBackend
// MUST return the Rust ClaudePtyBridge/CodexPtyBridge — NOT the Node helpers.
describe('PTY-cutover Phase A: runnerForHumanBackend returns Rust bridge when host present', () => {
  let prevPortFile: string | undefined
  let portFilePath = ''
  beforeEach(() => {
    prevPortFile = process.env.REMO_PTY_HOST_PORT_FILE
    portFilePath = join(import.meta.dir, `pty-host-port-${process.pid}.tmp`)
    writeFileSync(portFilePath, '54321', 'utf8')
    process.env.REMO_PTY_HOST_PORT_FILE = portFilePath
  })
  afterEach(() => {
    if (prevPortFile === undefined) delete process.env.REMO_PTY_HOST_PORT_FILE
    else process.env.REMO_PTY_HOST_PORT_FILE = prevPortFile
    try { rmSync(portFilePath) } catch {}
  })

  test('claude-pty => ClaudePtyBridge (Rust), not the Node ClaudePtyRunner', () => {
    expect(runnerForHumanBackend('claude-pty').constructor.name).toBe('ClaudePtyBridge')
  })

  test('codex-pty => CodexPtyBridge (Rust), not the Node CodexPtyRunner', () => {
    expect(runnerForHumanBackend('codex-pty').constructor.name).toBe('CodexPtyBridge')
  })
})

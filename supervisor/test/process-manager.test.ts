import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProcessManager, type RunSpec } from '../src/process-manager'
import type { SupervisorConfig } from '../src/config'

let TMP: string
let ROOT: string
let REPO_GIT: string
let REPO_NOGIT: string
let AUDIT_PATH: string

// ---------- spawn spy ----------
interface SpawnCall { cmd: string[]; opts: any }
const calls: SpawnCall[] = []

/** Minimal fake Subprocess. exit code resolves only when `.kill()` is invoked. */
function makeFakeProc(): any {
  let resolveExit!: (code: number) => void
  const exited = new Promise<number>((r) => { resolveExit = r })
  return {
    pid: 12345 + calls.length,
    stdin: { write: () => {}, end: () => {} },
    stdout: null,
    stderr: null,
    exited,
    kill: (_sig?: string) => { resolveExit(0) },
    _resolveExit: (c: number) => resolveExit(c),
  }
}

const spawnSpy = (cmd: string[], opts: any) => {
  calls.push({ cmd: [...cmd], opts })
  return makeFakeProc()
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
  pm.spawnImpl = spawnSpy
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
  REPO_NOGIT = join(ROOT, 'repo-no-git')
  AUDIT_PATH = join(TMP, 'audit.jsonl')
  mkdirSync(REPO_GIT, { recursive: true })
  mkdirSync(REPO_NOGIT, { recursive: true })
  mkdirSync(join(REPO_GIT, '.git'), { recursive: true })
})

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

beforeEach(() => {
  calls.length = 0
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
    expect(calls.length).toBe(0)
    expect(events.find((e) => e.state === 'stopped')).toBeTruthy()
  })

  test('sandbox_escape: rejects C:\\Windows\\System32', async () => {
    const { pm } = makePM(makeCfg())
    const r = await pm.start(spec({ repoPath: 'C:\\Windows\\System32' }))
    expect(r?.reason).toBe('sandbox_escape')
    expect(calls.length).toBe(0)
  })

  test('legacy spawn path is disabled — gates pass but no subprocess is spawned', async () => {
    // Phase 09 follow-up: the npx -y remo-code-agent path was retired and the
    // in-process claude-runner has not yet landed. start() still passes the
    // security gates (returns null) and writes a positive audit row, but the
    // run is immediately finalized as stopped + legacy_agent_spawn_disabled
    // and no child process is ever spawned.
    const { pm, events } = makePM(makeCfg())
    const r = await pm.start(spec({ repoPath: REPO_GIT }))
    expect(r).toBeNull()
    expect(calls.length).toBe(0)
    const stoppedEvt = events.find((e) => e.state === 'stopped')
    expect(stoppedEvt?.info?.lastExit?.reason).toBe('legacy_agent_spawn_disabled')
  })

  test('not_git_repo: rejects when restrictToGit=true and no .git', async () => {
    const { pm } = makePM(makeCfg({ requireGitRepo: true }))
    const r = await pm.start(spec({ repoPath: REPO_NOGIT }))
    expect(r?.reason).toBe('not_git_repo')
    expect(calls.length).toBe(0)
  })

  test('git gate is opt-in: with restrictToGit=false a non-git dir passes gates', async () => {
    const { pm } = makePM(makeCfg({ requireGitRepo: false }))
    const r = await pm.start(spec({ repoPath: REPO_NOGIT }))
    expect(r).toBeNull()
    expect(calls.length).toBe(0) // legacy spawn disabled
  })

  test('concurrency_cap: enforced before the spawn gate fires', async () => {
    // With the legacy spawn disabled, the first start finalizes immediately
    // and releases its slot before the second start is attempted — so a
    // sequential second start no longer hits the cap. To exercise the
    // concurrency_cap gate itself, we monkey-patch the spawn() method to
    // hold the run in 'starting' state instead of finalizing. This simulates
    // the future inline-runner state where spawn() keeps the slot occupied.
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    // Replace spawn with a no-op so runs stay in the map after start().
    ;(pm as any).spawn = (run: any) => { run.state = 'starting' /* hold the slot */ }
    const r1 = await pm.start(spec({ runId: 'a' }))
    expect(r1).toBeNull()
    const r2 = await pm.start(spec({ runId: 'b' }))
    expect(r2?.reason).toBe('concurrency_cap')
    expect(calls.length).toBe(0)
  })

  test('--dangerously-skip-permissions stripped when cap OFF (gate still logs, but no spawn)', async () => {
    const { pm, logs } = makePM(makeCfg({ allowDangerousSkipPermissions: false }))
    await pm.start(spec({ dangerouslySkipPermissions: true }))
    expect(calls.length).toBe(0)
    expect(logs.some((l) => l.msg.includes('flag stripped'))).toBe(true)
  })

  test('--dangerously-skip-permissions is NEVER spawned, even with cap ON (legacy path is disabled)', async () => {
    const { pm } = makePM(makeCfg({ allowDangerousSkipPermissions: true }))
    await pm.start(spec({ dangerouslySkipPermissions: true }))
    // Legacy spawn refused → nothing in calls[]; the flag never reaches a real argv.
    expect(calls.length).toBe(0)
  })

  test('audit log appends one JSONL entry per decision (allow + reject)', async () => {
    const { pm } = makePM(makeCfg({ maxConcurrent: 1 }))
    // Hold the slot so the second start hits concurrency_cap (without the
    // monkey-patch, spawn() finalizes immediately and releases the slot).
    ;(pm as any).spawn = (run: any) => { run.state = 'starting' /* hold the slot */ }
    await pm.start(spec({ runId: 'a', repoPath: REPO_GIT }))      // allowed
    await pm.start(spec({ runId: 'b', repoPath: REPO_GIT }))      // concurrency_cap
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

  test('updateConfig() takes effect on next start (config swap reaches the audit decision path)', async () => {
    const { pm } = makePM(makeCfg({ allowDangerousSkipPermissions: false }))
    await pm.start(spec({ runId: 'a', dangerouslySkipPermissions: true }))
    pm.updateConfig(makeCfg({ allowDangerousSkipPermissions: true, maxConcurrent: 5 }))
    await pm.start(spec({ runId: 'b', dangerouslySkipPermissions: true }))
    const lines = readFileSync(AUDIT_PATH, 'utf-8').trim().split('\n')
    const entries = lines.map((l) => JSON.parse(l))
    expect(entries[0].flags.dangerously_skip_permissions_applied).toBe(false)
    expect(entries[1].flags.dangerously_skip_permissions_applied).toBe(true)
  })
})

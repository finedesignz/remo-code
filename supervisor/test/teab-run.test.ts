import { describe, test, expect, beforeEach } from 'bun:test'
import { EventEmitter } from 'events'
import {
  buildTeabSpawnArgs,
  resolveTeabBinName,
  preflightTeab,
  runTeabRun,
  runTeabStatus,
  getRun,
  _resetRuns,
  type TeabRunDeps,
} from '../src/commands/teab-run'

const REPO = '/repo' // path.isAbsolute('/repo') is true on win32 + posix

/** Minimal fake ChildProcess with controllable stdout/stderr/exit. */
function makeFakeChild(pid = 4242) {
  const child: any = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.unref = () => {}
  return child
}

/** Deps where every prereq passes; spawn returns a fake child we control. */
function passingDeps(child: any, runId = 'run-fixed'): TeabRunDeps {
  return {
    resolveTeabBin: () => '/usr/bin/teab',
    resolveClaudeBin: () => '/usr/bin/claude',
    pathExists: () => true,
    spawnFn: (() => child) as any,
    genRunId: () => runId,
    sanitizeEnv: () => ({ PATH: '/usr/bin' }),
  }
}

beforeEach(() => {
  _resetRuns()
  delete process.env.TEAB_BIN
})

describe('buildTeabSpawnArgs', () => {
  test('constructs `teab run --repo <repo>`', () => {
    const { bin, args } = buildTeabSpawnArgs(REPO)
    expect(bin).toBe('teab')
    expect(args).toEqual(['run', '--repo', REPO])
  })

  test('honors TEAB_BIN override for the binary name', () => {
    process.env.TEAB_BIN = '/opt/teab/bin/teab'
    expect(resolveTeabBinName()).toBe('/opt/teab/bin/teab')
    const { bin, args } = buildTeabSpawnArgs(REPO)
    expect(bin).toBe('/opt/teab/bin/teab')
    expect(args).toEqual(['run', '--repo', REPO])
  })
})

describe('preflight — fail closed', () => {
  const base = {
    resolveTeabBin: () => '/usr/bin/teab',
    resolveClaudeBin: () => '/usr/bin/claude',
    pathExists: () => true,
  }

  test('repo_not_found when repo path not absolute / missing', () => {
    expect(preflightTeab(undefined, base).error).toBe('repo_not_found')
    expect(preflightTeab('relative/path', base).error).toBe('repo_not_found')
    expect(preflightTeab(REPO, { ...base, pathExists: (p) => p !== REPO }).error).toBe('repo_not_found')
  })

  test('teab_not_found when teab missing', () => {
    expect(preflightTeab(REPO, { ...base, resolveTeabBin: () => null }).error).toBe('teab_not_found')
  })

  test('claude_not_found when claude missing', () => {
    expect(preflightTeab(REPO, { ...base, resolveClaudeBin: () => null }).error).toBe('claude_not_found')
  })

  test('missing_planning when .planning absent', () => {
    const r = preflightTeab(REPO, { ...base, pathExists: (p) => !p.includes('.planning') })
    expect(r.error).toBe('missing_planning')
  })

  test('missing_guard_hook when irreversible-action-guard.mjs absent', () => {
    const r = preflightTeab(REPO, {
      ...base,
      pathExists: (p) => !p.includes('irreversible-action-guard.mjs'),
    })
    expect(r.error).toBe('missing_guard_hook')
  })

  test('ok when all prereqs present', () => {
    expect(preflightTeab(REPO, base)).toEqual({ ok: true })
  })
})

describe('runTeabRun — does NOT spawn on preflight failure', () => {
  test.each([
    ['teab_not_found', { resolveTeabBin: () => null }],
    ['claude_not_found', { resolveClaudeBin: () => null }],
    ['repo_not_found', { pathExists: (p: string) => p !== REPO }],
    ['missing_planning', { pathExists: (p: string) => !p.includes('.planning') }],
    ['missing_guard_hook', { pathExists: (p: string) => !p.includes('irreversible-action-guard.mjs') }],
  ] as const)('%s returns the specific error and never spawns', async (expected, override) => {
    let spawned = false
    const deps: TeabRunDeps = {
      resolveTeabBin: () => '/usr/bin/teab',
      resolveClaudeBin: () => '/usr/bin/claude',
      pathExists: () => true,
      spawnFn: (() => {
        spawned = true
        return makeFakeChild()
      }) as any,
      ...(override as object),
    }
    const r = await runTeabRun([REPO], deps)
    expect(r.exit_code).toBe(1)
    expect(r.error).toBe(expected)
    expect(spawned).toBe(false)
  })
})

describe('runTeabRun / runTeabStatus — lifecycle', () => {
  test('returns started ack immediately and tracks running → exited', async () => {
    const child = makeFakeChild(9001)
    const r = await runTeabRun([REPO], passingDeps(child, 'run-1'))
    expect(r.exit_code).toBe(0)
    const snippet = JSON.parse(r.snippet!)
    expect(snippet).toEqual({ run_id: 'run-1', started: true, pid: 9001 })

    // running
    let st = JSON.parse((await runTeabStatus(['run-1'])).snippet!)
    expect(st.state).toBe('running')
    expect(st.exit_code).toBeNull()

    // capture stdout into events tail
    child.stdout.emit('data', Buffer.from('building roadmap\nphase 1 done\n'))
    // exit transition
    child.emit('exit', 0)

    st = JSON.parse((await runTeabStatus(['run-1'])).snippet!)
    expect(st.state).toBe('exited')
    expect(st.exit_code).toBe(0)
    expect(st.events_tail).toContain('building roadmap')
    expect(st.events_tail).toContain('phase 1 done')

    expect(getRun('run-1')?.state).toBe('exited')
  })

  test('non-zero exit code is recorded', async () => {
    const child = makeFakeChild()
    await runTeabRun([REPO], passingDeps(child, 'run-2'))
    child.emit('exit', 17)
    const st = JSON.parse((await runTeabStatus(['run-2'])).snippet!)
    expect(st.state).toBe('exited')
    expect(st.exit_code).toBe(17)
  })

  test('unknown_run for unknown id', async () => {
    const r = await runTeabStatus(['nope'])
    expect(r.exit_code).toBe(1)
    expect(r.error).toBe('unknown_run')
  })
})

describe('forbidden-token canary', () => {
  const FORBIDDEN = [
    '-p',
    '--print',
    '--input-format',
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    'bypassPermissions',
  ]

  test('built argv contains none of the forbidden programmatic tokens', () => {
    const { bin, args } = buildTeabSpawnArgs(REPO)
    const argv = [bin, ...args]
    for (const tok of FORBIDDEN) {
      expect(argv).not.toContain(tok)
    }
    // also no api-key-shaped token
    for (const a of argv) {
      expect(a.toUpperCase()).not.toContain('API_KEY')
      expect(a.toUpperCase()).not.toContain('AUTH_TOKEN')
    }
  })

  test('argv is exactly the allowlisted shape', () => {
    const { bin, args } = buildTeabSpawnArgs(REPO)
    expect([bin, ...args]).toEqual(['teab', 'run', '--repo', REPO])
  })
})

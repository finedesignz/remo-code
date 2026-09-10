/**
 * TEAB-02 — run lifecycle: concurrent registry, child reaping, and fail-open
 * start/stop breadcrumb wiring. Breadcrumb writers are INJECTED so no real FS is
 * touched (the default writers fail-open to %LOCALAPPDATA%).
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { EventEmitter } from 'events'
import {
  runTeabRun,
  runTeabStatus,
  getRun,
  listRuns,
  reapFinished,
  evictOldTerminalRuns,
  _resetRuns,
  type TeabRunDeps,
  type TeabRunRecord,
} from '../src/commands/teab-run'

const REPO = '/repo'

/** Fake ChildProcess that tracks listener removal so reaping is observable. */
function makeFakeChild(pid = 4242) {
  const child: any = new EventEmitter()
  child.pid = pid
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.unref = () => {}
  return child
}

function passingDeps(child: any, runId: string, extra: Partial<TeabRunDeps> = {}): TeabRunDeps {
  return {
    resolveTeabBin: () => '/usr/bin/teab',
    resolveClaudeBin: () => '/usr/bin/claude',
    pathExists: () => true,
    spawnFn: (() => child) as any,
    genRunId: () => runId,
    sanitizeEnv: () => ({ PATH: '/usr/bin' }),
    ...extra,
  }
}

beforeEach(() => {
  _resetRuns()
  delete process.env.TEAB_BIN
})

describe('concurrent runs tracked independently', () => {
  test('two runs keyed by run id, exit one without affecting the other', async () => {
    const childA = makeFakeChild(1001)
    const childB = makeFakeChild(1002)
    await runTeabRun([REPO], passingDeps(childA, 'run-A'))
    await runTeabRun([REPO], passingDeps(childB, 'run-B'))

    expect(listRuns().length).toBe(2)
    expect(getRun('run-A')?.state).toBe('running')
    expect(getRun('run-B')?.state).toBe('running')

    childA.stdout.emit('data', Buffer.from('A building\n'))
    childB.stdout.emit('data', Buffer.from('B building\n'))
    childA.emit('exit', 0)

    const stA = JSON.parse((await runTeabStatus(['run-A'])).snippet!)
    const stB = JSON.parse((await runTeabStatus(['run-B'])).snippet!)
    expect(stA.state).toBe('exited')
    expect(stA.exit_code).toBe(0)
    expect(stA.events_tail).toContain('A building')
    // B is independent — still running with its own tail
    expect(stB.state).toBe('running')
    expect(stB.events_tail).toContain('B building')
  })
})

describe('reaping finished children', () => {
  test('exit releases the child handle but keeps the terminal record', async () => {
    const child = makeFakeChild(2001)
    await runTeabRun([REPO], passingDeps(child, 'run-reap'))
    expect(getRun('run-reap')?.child).toBeDefined()

    child.emit('exit', 3)

    const rec = getRun('run-reap')!
    expect(rec.state).toBe('exited')
    expect(rec.exitCode).toBe(3)
    // handle released by reapFinished
    expect(rec.child).toBeUndefined()
    // listeners detached
    expect(child.listenerCount('exit')).toBe(0)
    expect(child.stdout.listenerCount('data')).toBe(0)
    // status still reports the terminal record
    const st = JSON.parse((await runTeabStatus(['run-reap'])).snippet!)
    expect(st.state).toBe('exited')
    expect(st.exit_code).toBe(3)
  })

  test('reapFinished is idempotent / safe with no child', () => {
    const rec: TeabRunRecord = {
      runId: 'x',
      eventsTail: [],
      state: 'exited',
      exitCode: 0,
      startedAt: Date.now(),
    }
    expect(() => reapFinished(rec)).not.toThrow()
  })
})

describe('eviction bounds registry memory', () => {
  test('evictOldTerminalRuns drops oldest exited records, keeps running', async () => {
    // 3 exited (old) + 1 running
    for (let i = 0; i < 3; i++) {
      const c = makeFakeChild(3000 + i)
      await runTeabRun([REPO], passingDeps(c, `done-${i}`))
      c.emit('exit', 0)
    }
    const live = makeFakeChild(3999)
    await runTeabRun([REPO], passingDeps(live, 'live'))

    const evicted = evictOldTerminalRuns(1) // keep only 1 terminal
    expect(evicted).toBe(2)
    expect(getRun('live')?.state).toBe('running') // running preserved
    const remainingTerminal = listRuns().filter((r) => r.state === 'exited')
    expect(remainingTerminal.length).toBe(1)
  })
})

describe('breadcrumb start/stop wiring', () => {
  test('injected writers receive start then stop', async () => {
    const starts: any[] = []
    const stops: any[] = []
    const child = makeFakeChild(5001)
    await runTeabRun(
      [REPO],
      passingDeps(child, 'run-crumb', {
        onRunStart: (i) => starts.push(i),
        onRunStop: (i) => stops.push(i),
      }),
    )
    expect(starts).toEqual([{ runId: 'run-crumb', repoPath: REPO, pid: 5001 }])
    expect(stops.length).toBe(0)

    child.emit('exit', 0)
    expect(stops).toEqual([{ runId: 'run-crumb', exitCode: 0 }])
  })

  test('a throwing breadcrumb writer is fail-open — the run is unaffected', async () => {
    const child = makeFakeChild(6001)
    const r = await runTeabRun(
      [REPO],
      passingDeps(child, 'run-failopen', {
        onRunStart: () => {
          throw new Error('disk full')
        },
        onRunStop: () => {
          throw new Error('disk full')
        },
      }),
    )
    // started ack still returned despite the throwing START writer
    expect(r.exit_code).toBe(0)
    expect(getRun('run-failopen')?.state).toBe('running')

    // throwing STOP writer must not break the exit transition / reaping
    expect(() => child.emit('exit', 0)).not.toThrow()
    const rec = getRun('run-failopen')!
    expect(rec.state).toBe('exited')
    expect(rec.exitCode).toBe(0)
    expect(rec.child).toBeUndefined()
  })
})

/**
 * PTYCAP-04-03 Task 2: every orchestrator run-log row that records a dispatched
 * inject carries the SAME token the inject used (the rate-union dedupe key shared
 * with automation_inject_ledger.token, panel F-6). DB-free.
 *
 * mock.module is process-global; this file is isolated per process by check-baseline
 * and restores in afterAll.
 */
import { describe, test, expect, afterAll, mock } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ── DAL: capture the INSERT's tagged-template values ─────────────────────────
const sqlCalls: Array<{ text: string; values: unknown[] }> = []
function fakeSql(strings: TemplateStringsArray, ...values: unknown[]) {
  sqlCalls.push({ text: strings.join('?'), values })
  return Promise.resolve([{ id: 'row-1' }])
}
mock.module('../src/db/postgres.ts', () => ({ sql: fakeSql }))

// ── run-log spy for wave-runner (it imports appendRunLog from ./run-log.ts) ───
const waveLog: any[] = []
mock.module('../src/orchestrator/run-log.ts', () => ({
  appendRunLog: async (entry: any) => {
    waveLog.push(entry)
    return { id: 'fake', created_at: '', ...entry }
  },
  recentRunLog: async () => [],
}))

const { insertRoutineRunLog } = await import('../src/db/orchestrator-rows-dal.ts')
const { runMacroCycle } = await import('../src/orchestrator/macro-cycle.ts')
const { runMergeToMain, prContentSha, MERGE_COMMAND } = await import(
  '../src/orchestrator/merge-command.ts'
)
const { runWavePlan, makeLiveSeams } = await import('../src/orchestrator/wave-runner.ts')

afterAll(() => {
  mock.restore()
})

const SRC = join(import.meta.dir, '..', 'src')

describe('routine_run_log DAL', () => {
  test('insertRoutineRunLog writes inject_token when given', async () => {
    sqlCalls.length = 0
    await insertRoutineRunLog({ session_id: 's1', command: 'c', outcome: 'dispatched', inject_token: 'tok-1' })
    expect(sqlCalls).toHaveLength(1)
    expect(sqlCalls[0].text).toContain('inject_token')
    expect(sqlCalls[0].values).toContain('tok-1')
  })

  test('omitted inject_token is written as NULL', async () => {
    sqlCalls.length = 0
    await insertRoutineRunLog({ session_id: 's1', command: 'c' })
    expect(sqlCalls[0].values[sqlCalls[0].values.length - 1]).toBeNull()
  })
})

describe('macro-cycle rows', () => {
  function macroDeps(outcomeKind: string, log: any[], injectedToken: { v?: string }) {
    return {
      getLatestAssistantReply: async () => null,
      appendRunLog: (async (e: any) => {
        log.push(e)
        return { id: 'rl', ...e, created_at: '' }
      }) as any,
      inject: (async (i: any) => {
        injectedToken.v = i.token
        return { kind: outcomeKind } as any
      }) as any,
      fanOut: (async () => ({ delivered: [] })) as any,
      isRunLive: () => false,
      refreshCapGauges: (async () => {}) as any,
      getCapStatuses: (async () => ({ costStatus: null, tokenStatus: null })) as any,
    } as any
  }
  const input = {
    userId: 'u1',
    sessionId: 's1',
    taskId: 't1',
    macroTaskType: 'dev',
    stage: 'development',
    repoPath: '/r',
    repoIdent: 'github://a/b',
    repoKey: 'github://a/b',
  } as any

  for (const kind of ['dispatched', 'queued', 'autospawn_launched', 'autospawn_parked']) {
    test(`inject outcome ${kind}: row carries exactly the inject's token`, async () => {
      const log: any[] = []
      const tok: { v?: string } = {}
      await runMacroCycle(input, macroDeps(kind, log, tok))
      const row = log.find((e) => e.command === 'macro:dev')
      expect(tok.v).toBeTruthy()
      expect(row.outcome).toBe(kind)
      expect(row.inject_token).toBe(tok.v)
    })
  }

  for (const [kind, extra] of [
    ['no_session', {}],
    ['refused', { reason: 'automation_halted:global' }],
    ['failed', { reason: 'x' }],
  ] as const) {
    test(`non-inject outcome ${kind}: no token on the row`, async () => {
      const log: any[] = []
      const tok: { v?: string } = {}
      const deps = macroDeps(kind, log, tok)
      deps.inject = (async (i: any) => {
        tok.v = i.token
        return { kind, ...extra }
      }) as any
      await runMacroCycle(input, deps)
      const row = log.find((e) => e.command === 'macro:dev')
      expect(row.inject_token ?? null).toBeNull()
    })
  }
})

describe('merge-command rows', () => {
  async function run(injectKind: string) {
    const runLog: any[] = []
    const injected: any[] = []
    const deps: any = {
      now: () => new Date('2026-06-06T02:00:00Z'),
      recentRunLog: async () => [
        { session_id: 's1', command: 'execute', pr_url: 'https://gh/pr/1', reviewer_verdict: 'PASS', repo_key: 'o/r' },
      ],
      listUnconsumedApprovals: async () => [],
      markApprovalConsumed: async () => null,
      injectOrchestratorPrompt: async (i: any) => {
        injected.push(i)
        return { kind: injectKind }
      },
      notifyChatSurface: async () => {},
      appendRunLog: async (e: any) => {
        runLog.push(e)
        return e
      },
    }
    await runMergeToMain({ sessionId: 's1', userId: 'u1', repoKey: 'o/r', scheduleRule: null, tz: 'UTC' }, deps)
    return { runLog, injected }
  }
  void prContentSha

  test('dispatched merge inject: the merge row carries the inject token', async () => {
    const { runLog, injected } = await run('dispatched')
    const row = runLog.find((e) => e.command === MERGE_COMMAND)
    expect(injected).toHaveLength(1)
    expect(row.inject_token).toBe(injected[0].token)
  })

  test('refused merge inject: no token', async () => {
    const { runLog } = await run('refused')
    const row = runLog.find((e) => e.command === MERGE_COMMAND)
    expect(row.inject_token ?? null).toBeNull()
  })
})

describe('wave-runner rows', () => {
  function plan() {
    return { waves: [[{ command: 'gsd-plan-phase', propose: false, priority: 0, microPrompt: null }]], dropped: [] } as any
  }
  function injectDeps(kind: string, seen: any[]) {
    return {
      getChannel: () => ({ ws: { send() {} } }) as any,
      isSessionLive: async () => true,
      resolveCounterKey: async () => 'task:T1',
      dispatch: (async (req: any) => {
        seen.push(req)
        return kind === 'dispatched' ? { kind: 'dispatched' } : { kind: 'skipped', reason: 'automation_halted:global' }
      }) as any,
    } as any
  }

  test('dispatched unit: run-log row carries the inject token', async () => {
    waveLog.length = 0
    const seen: any[] = []
    await runWavePlan(plan(), { sessionId: 's1', repoKey: 'o/r', userId: 'u1' } as any, makeLiveSeams(injectDeps('dispatched', seen)))
    expect(seen).toHaveLength(1)
    expect(waveLog).toHaveLength(1)
    expect(waveLog[0].outcome).toBe('dispatched')
    expect(waveLog[0].inject_token).toBe(seen[0].token)
  })

  test('refused unit: no token on the row', async () => {
    waveLog.length = 0
    const seen: any[] = []
    await runWavePlan(plan(), { sessionId: 's1', repoKey: 'o/r', userId: 'u1' } as any, makeLiveSeams(injectDeps('skipped', seen)))
    expect(waveLog[0].outcome).toBe('refused:automation_halted:global')
    expect(waveLog[0].inject_token ?? null).toBeNull()
  })
})

// ── static scan: an append whose outcome derives from an inject result carries the token ──
function appendBodies(src: string): string[] {
  const out: string[] = []
  const re = /appendRunLog\(\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 1
    let i = m.index + m[0].length
    const start = i
    while (i < src.length && depth > 0) {
      const c = src[i]
      if (c === '{') depth++
      else if (c === '}') depth--
      i++
    }
    out.push(src.slice(start, i - 1))
  }
  return out
}

describe('static scan: inject-derived appends carry inject_token', () => {
  // an append is inject-derived when its outcome field comes from an InjectOutcome
  const INJECT_DERIVED = /\b(?:inj|outcome)\.kind\b|^\s*outcome,\s*$/m
  const FILES = ['macro-cycle.ts', 'merge-command.ts', 'wave-runner.ts', 'verify-tail.ts', 'controller.ts']

  test('every inject-derived append includes inject_token (and the scanner finds the known sites)', () => {
    const derived: Array<{ file: string; ok: boolean }> = []
    for (const f of FILES) {
      const src = readFileSync(join(SRC, 'orchestrator', f), 'utf8').split(/\r?\n/).join('\n')
      for (const body of appendBodies(src)) {
        if (INJECT_DERIVED.test(body)) derived.push({ file: f, ok: body.includes('inject_token') })
      }
    }
    // self-check: the scanner must find the three known inject-derived sites
    expect(derived.map((d) => d.file).sort()).toEqual(['macro-cycle.ts', 'merge-command.ts', 'wave-runner.ts'])
    expect(derived.filter((d) => !d.ok)).toEqual([])
  })
})

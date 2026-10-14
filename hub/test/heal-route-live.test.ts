/**
 * PTYCAP-07-05 Task 2 -- routeHeal tracer: coolify_deploy event -> dispatched_live through the
 * shared pipeline (SH-01, SH-03, SH-06, D-02, D-07). DB-free: collaborators are injected; the
 * capped-user test runs the REAL dispatch() with the real gate objects' check() patched in place
 * (restored in afterAll), so no process-global mock.module is needed.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { routeHeal, type HealDeps } from '../src/heal/route.ts'
import { buildHealKey } from '../src/heal/counter-key.ts'
import { parseHealEvent } from '../src/heal/types.ts'
import type { HealSink, HealTerminalOutcome } from '../src/heal/sinks/types.ts'
import { withScopeContract, asciiPunctuation } from '../src/heal/prompt.ts'
import { SCOPE_CONTRACT } from '../src/dispatch/untrusted.ts'
import * as pipeline from '../src/dispatch/pipeline.ts'
import * as gates from '../src/dispatch/gates.ts'
import * as controls from '../src/dispatch/automation-controls.ts'

const REPO = 'github://acme/web'
const GATE_ORDER = [
  'automation_kill_switch',
  'threshold',
  'daily_cost_cap',
  'daily_token_cap',
  'governed_automation_pty',
  'session_inject_rate',
  'lifetime_counter',
]

const prevFlag = process.env.REMO_HEAL_UNIFIED
beforeEach(() => {
  process.env.REMO_HEAL_UNIFIED = '1'
})

function event(over: Record<string, unknown> = {}) {
  return parseHealEvent({
    source: 'coolify_deploy',
    user_id: 'u1',
    repo_ident: REPO,
    prompt: 'deploy failed',
    metadata_run_id: 'meta1',
    trigger_run_id: 'trig1',
    dedupe_key: 'coolify:d1',
    ctx: { application_uuid: 'a1', deployment_uuid: 'd1', log_snippet: 'x' },
    ...over,
  })
}

function fakeSink(rec: {
  sends: any[]
  skipped: Array<[string, string]>
  terminal: HealTerminalOutcome[]
}): HealSink {
  let done = false
  return {
    open: async () => null,
    markSkipped: async (t, r) => {
      rec.skipped.push([t, r])
    },
    markDispatched: async () => {},
    onFinalize: async () => {},
    markFailed: async () => {},
    send: async (req) => {
      rec.sends.push(req)
    },
    finalizeTerminal: async (o) => {
      if (done) return // idempotent: first writer wins
      done = true
      rec.terminal.push(o)
    },
    onParkExpire: async () => {},
  }
}

function mkDeps(over: Partial<HealDeps> = {}) {
  const rec = {
    sends: [] as any[],
    skipped: [] as Array<[string, string]>,
    terminal: [] as HealTerminalOutcome[],
    outcomes: [] as Array<[string, string, any]>,
    dispatchCalls: [] as Array<{ req: any; pdeps: any }>,
    claims: 0,
  }
  const deps: HealDeps = {
    now: () => 1_700_000_000_000,
    resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
    claim: async () => {
      rec.claims++
      return { ok: true, id: 'ev1' }
    },
    setOutcome: async (id, outcome, extra) => {
      rec.outcomes.push([id, outcome, extra])
    },
    isHealGenerated: async () => false,
    countRepoDispatches: async () => 0,
    makeSink: () => fakeSink(rec),
    dispatch: async (req, pdeps) => {
      rec.dispatchCalls.push({ req, pdeps })
      return { kind: 'dispatched', runId: 'run1' }
    },
    runnerTypeOf: async () => 'stream-json',
    isChannelOnline: () => true,
    // hermetic: never reach the real claim / email seam (07-06)
    notify: { claim: async () => false, resolveOwnerEmail: async () => null, send: async () => false },
    ...over,
  }
  return { deps, rec }
}

describe('routeHeal tracer: live dispatch', () => {
  test('coolify event -> dispatched_live; request, gate order, key and ledger row all as specified', async () => {
    const { deps, rec } = mkDeps()
    const out = await routeHeal(event(), deps)
    expect(out).toEqual({ kind: 'dispatched_live' })

    expect(rec.dispatchCalls.length).toBe(1)
    const { req, pdeps } = rec.dispatchCalls[0]!
    expect(req.sessionId).toBe('s1')
    expect(req.userId).toBe('u1')
    expect(req.token).toBe('heal:ev1')
    expect(req.counterKey).toBe(buildHealKey('u1', REPO))
    expect(pdeps.gates.map((g: any) => g.name)).toEqual(GATE_ORDER)
    expect(await pdeps.isOnline(req)).toBe(true)

    const last = rec.outcomes[rec.outcomes.length - 1]!
    expect(last[0]).toBe('ev1')
    expect(last[1]).toBe('dispatched_live')
    expect(last[2]).toMatchObject({ sessionId: 's1', repoIdent: REPO })
    expect(rec.terminal).toEqual([]) // a live dispatch is not terminalized by the router
  })

  test('the prompt carries the scope contract exactly once and is idempotent', async () => {
    const { deps, rec } = mkDeps()
    await routeHeal(event(), deps)
    const prompt: string = rec.dispatchCalls[0]!.req.prompt
    expect(prompt.split(SCOPE_CONTRACT).length - 1).toBe(1)
    const again = withScopeContract(withScopeContract('hello'))
    expect(again.split(SCOPE_CONTRACT).length - 1).toBe(1)
    expect(asciiPunctuation('a — b “q” … –')).toBe('a -- b "q" ... -')
  })

  test('offline_candidate and none resolutions terminalize once as no_routable_session, no dispatch', async () => {
    for (const target of [
      { kind: 'offline_candidate', sessionId: 's1', repoIdent: REPO } as const,
      { kind: 'none', reason: 'no_session_for_repo' } as const,
    ]) {
      const { deps, rec } = mkDeps({ resolve: async () => target })
      const out = await routeHeal(event(), deps)
      expect(out.kind).toBe('no_routable_session')
      expect(rec.dispatchCalls.length).toBe(0)
      expect(rec.terminal.length).toBe(1)
      expect(rec.terminal[0]!.kind).toBe('no_routable_session')
      expect(rec.outcomes[rec.outcomes.length - 1]![1]).toBe('no_routable_session')
    }
  })

  test('a ghost bound session (resolver says offline_candidate) is not dispatched live', async () => {
    const { deps, rec } = mkDeps({ resolve: async () => ({ kind: 'offline_candidate', sessionId: 'ghost', repoIdent: REPO }) })
    const out = await routeHeal(event(), deps)
    expect(out.kind).toBe('no_routable_session')
    expect(rec.sends.length).toBe(0)
  })

  test('dispatch outcomes map: dropped_busy/skipped -> refused, failed -> failed, parked -> no_routable_session', async () => {
    const cases: Array<[any, string]> = [
      [{ kind: 'dropped_busy' }, 'refused:session_busy'],
      [{ kind: 'skipped', reason: 'quota_threshold_reached' }, 'refused:quota_threshold_reached'],
      [{ kind: 'failed', reason: 'boom' }, 'failed:boom'],
      [{ kind: 'parked_offline' }, 'no_routable_session'],
      [{ kind: 'queued' }, 'dispatched_live'],
    ]
    for (const [dout, persisted] of cases) {
      const { deps, rec } = mkDeps({ dispatch: async () => dout })
      await routeHeal(event(), deps)
      expect(rec.outcomes[rec.outcomes.length - 1]![1]).toBe(persisted)
      if (persisted !== 'dispatched_live') expect(rec.terminal.length).toBe(1)
    }
  })
})

describe('capped user never reaches send (SH-06, real dispatch + real gate objects)', () => {
  const all = [
    controls.automationKillSwitchGate,
    gates.thresholdGate,
    gates.dailyCostCapGate,
    gates.dailyTokenCapGate,
    gates.sessionInjectRateGate,
    controls.automationLifetimeCounterGate,
  ]
  const originals = all.map((g) => g.check)
  afterAll(() => {
    all.forEach((g, i) => {
      g.check = originals[i]!
    })
    if (prevFlag === undefined) delete process.env.REMO_HEAL_UNIFIED
    else process.env.REMO_HEAL_UNIFIED = prevFlag
  })

  for (const [gate, reason] of [
    [gates.dailyTokenCapGate, 'over_daily_token_cap:100>=50'],
    [gates.dailyCostCapGate, 'over_daily_cost_cap:9>=5'],
  ] as const) {
    test(`${gate.name} blocks: refused with the cap reason, zero sends, metadata skipped via the sink`, async () => {
      pipeline._reset()
      all.forEach((g) => {
        g.check = async () => ({ ok: true as const })
      })
      gate.check = async () => ({ ok: false as const, reason })
      const { deps, rec } = mkDeps({ dispatch: pipeline.dispatch })
      const out = await routeHeal(event(), deps)
      expect(out).toEqual({ kind: 'refused', reason, notifyClaimed: false })
      expect(rec.sends.length).toBe(0)
      expect(rec.skipped).toEqual([['heal:ev1', reason]])
      expect(rec.terminal.length).toBe(1) // idempotent sink: still one terminal write
      expect(rec.outcomes[rec.outcomes.length - 1]![1]).toBe(`refused:${reason}`)
    })
  }
})

describe('PTY denial is in the heal gate list (PTYCAP-07 QC adversary MINOR)', () => {
  const all = [
    controls.automationKillSwitchGate,
    gates.thresholdGate,
    gates.dailyCostCapGate,
    gates.dailyTokenCapGate,
    gates.sessionInjectRateGate,
    controls.automationLifetimeCounterGate,
  ]
  const originals = all.map((g) => g.check)
  afterAll(() => {
    all.forEach((g, i) => {
      g.check = originals[i]!
    })
  })

  test('a session flipped to pty-interactive at dispatch time is refused for actor self-heal, zero sends', async () => {
    pipeline._reset()
    all.forEach((g) => {
      g.check = async () => ({ ok: true as const })
    })
    const { deps, rec } = mkDeps({ dispatch: pipeline.dispatch, runnerTypeOf: async () => 'pty-interactive' })
    const out = await routeHeal(event(), deps)
    expect(out).toMatchObject({ kind: 'refused', reason: 'automation_blocked_on_pty:self-heal' })
    expect(rec.sends.length).toBe(0)
  })

  test('a stream-json session passes the PTY gate', async () => {
    pipeline._reset()
    all.forEach((g) => {
      g.check = async () => ({ ok: true as const })
    })
    const { deps } = mkDeps({ dispatch: pipeline.dispatch, runnerTypeOf: async () => 'stream-json' })
    const out = await routeHeal(event(), deps)
    // The PTY gate admits it; anything later (the DB-backed final halt check) is not under test.
    expect(JSON.stringify(out)).not.toContain('automation_blocked_on_pty')
  })
})

describe('structure', () => {
  test('runGates is exported from the pipeline', () => {
    expect(typeof pipeline.runGates).toBe('function')
  })

  test('hub/src/heal has exactly one gates literal (route.ts) and never touches capacity/launch/lister APIs', () => {
    const root = join(import.meta.dir, '..', 'src', 'heal')
    const files: string[] = []
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n)
        statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && files.push(p)
      }
    }
    walk(root)
    let literals = 0
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      literals += (src.match(/gates:/g) ?? []).length
      // autospawn-deps.ts (07-06) holds the one launch pass-through handed to governedLaunch
      const launchName = f.endsWith("autospawn-deps.ts") ? "" : "launchSessionForUser|"
      expect(src).not.toMatch(new RegExp(`pickSessionTarget|sendToSupervisor|${launchName}listOnlineAgentSessionsForUser|isOrchestratorEnabled|resolveRepoKeyedAgentSession`))
    }
    expect(literals).toBe(1)
    expect(readFileSync(join(root, 'route.ts'), 'utf8')).toContain('gates:')
  })
})

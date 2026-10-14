/**
 * PTYCAP-07-06 Task 2 -- the governed autospawn branch of routeHeal (SH-04, D-04, AM-F1-1,
 * AM-F1-2, AM-F1-3, AM-F2-3): pre-launch gates + atomic reservation + ledger BEFORE the spawn,
 * one deadline timer, reservation release on every failure. DB-free: every collaborator (launch,
 * supervisor, caps, reservation, timers) is injected, so there is no process-global mock.module.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { routeHeal, REAL_AUTOSPAWN, type HealDeps, type AutospawnDeps } from '../src/heal/route.ts'
import { buildHealKey } from '../src/heal/counter-key.ts'
import { healAutospawnArmed } from '../src/heal/config.ts'
import { parseHealEvent } from '../src/heal/types.ts'
import type { HealSink, HealTerminalOutcome } from '../src/heal/sinks/types.ts'

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

const saved = {
  heal: process.env.REMO_HEAL_UNIFIED,
  spawn: process.env.REMO_ORCHESTRATOR_AUTOSPAWN,
  orch: process.env.REMO_ORCHESTRATOR_ENABLED,
  timeout: process.env.REMO_HEAL_SPAWN_TIMEOUT_MS,
}
beforeEach(() => {
  process.env.REMO_HEAL_UNIFIED = '1'
  delete process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
})
afterAll(() => {
  for (const [k, v] of [
    ['REMO_HEAL_UNIFIED', saved.heal],
    ['REMO_ORCHESTRATOR_AUTOSPAWN', saved.spawn],
    ['REMO_ORCHESTRATOR_ENABLED', saved.orch],
    ['REMO_HEAL_SPAWN_TIMEOUT_MS', saved.timeout],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
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

function mk(over: { heal?: Partial<HealDeps>; auto?: Partial<AutospawnDeps> } = {}) {
  const rec = {
    order: [] as string[],
    launches: [] as any[],
    reserves: [] as any[],
    releases: [] as any[],
    gateChecks: [] as string[][],
    ledger: [] as any[],
    dispatches: [] as Array<{ req: any; pdeps: any }>,
    terminal: [] as HealTerminalOutcome[],
    outcomes: [] as string[],
    sends: [] as any[],
    timers: [] as Array<{ fn: () => void; ms: number; cleared: boolean }>,
  }
  const seen = new Set<string>()
  const auto: AutospawnDeps = {
    armed: () => true,
    tzForUser: async () => 'UTC',
    checkGates: async (_req, gates) => {
      rec.order.push('gates')
      rec.gateChecks.push(gates.map((g) => g.name))
      return null
    },
    reserve: async (a) => {
      rec.order.push('reserve')
      rec.reserves.push(a)
      return { ok: true }
    },
    release: async (a) => {
      rec.order.push('release')
      rec.releases.push(a)
    },
    isRepoAutospawnAllowed: async () => true,
    supervisorOnlineForUser: async () => true,
    getTokenCapStatus: async () => ({ over: false }),
    countAutospawnLaunchesToday: async () => 0,
    isOverAutospawnDailyLaunchCap: () => false,
    graceParkPending: () => false,
    launchSessionForUser: async (a) => {
      rec.order.push('launch')
      rec.launches.push(a)
      return { ok: true, runId: 'run-l1', supervisorId: 'sup1' } as any
    },
    appendRunLog: async (row) => {
      rec.order.push('ledger')
      rec.ledger.push(row)
    },
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false }
      rec.timers.push(t)
      return t
    },
    clearTimer: (h: any) => {
      h.cleared = true
    },
    ...over.auto,
  }
  const deps: HealDeps = {
    now: () => 1_700_000_000_000,
    resolve: async () => ({ kind: 'offline_candidate', sessionId: 's1', repoIdent: REPO }),
    claim: async (a) => {
      const k = `${a.source}|${a.dedupeKey}`
      if (seen.has(k)) return { ok: false, reason: 'duplicate' }
      seen.add(k)
      return { ok: true, id: `ev${seen.size}` }
    },
    setOutcome: async (_id, o) => {
      rec.outcomes.push(o)
    },
    isHealGenerated: async () => false,
    countRepoDispatches: async () => 0,
    makeSink: () => {
      let done = false
      const sink: HealSink = {
        open: async () => null,
        markSkipped: async () => {},
        markDispatched: async () => {},
        onFinalize: async () => {},
        markFailed: async () => {},
        send: async () => {},
        finalizeTerminal: async (o) => {
          if (done) return
          done = true
          rec.terminal.push(o)
        },
        onParkExpire: async () => {},
      }
      return sink
    },
    dispatch: async (req, pdeps) => {
      rec.dispatches.push({ req, pdeps })
      return { kind: 'parked_offline' }
    },
    runnerTypeOf: async () => 'stream-json',
    isChannelOnline: () => false,
    notify: {
      claim: async () => true,
      resolveOwnerEmail: async () => 'o@x.com',
      send: async (m) => {
        rec.sends.push(m)
        return true
      },
    },
    autospawn: auto,
    ...over.heal,
  }
  return { deps, rec }
}

// PTYCAP-07 QC r1 (codex #3, correctness MAJOR 1): ONE owner notification per heal event.
describe('single notification owner across the autospawn lifecycle', () => {
  /** A real once-per-event claim, the way the conditional UPDATE behaves. */
  function onceNotify(rec: { sends: any[] }) {
    const claimed = new Set<string>()
    const claims: string[] = []
    return {
      claims,
      notify: {
        claim: async (id: string) => {
          claims.push(id)
          if (claimed.has(id)) return false
          claimed.add(id)
          return true
        },
        resolveOwnerEmail: async () => 'o@x.com',
        send: async (m: any) => {
          rec.sends.push(m)
          return true
        },
      },
    }
  }
  const taskEvent = () =>
    event({
      source: 'scheduled_task',
      dedupe_key: 'task:t1:sig',
      bound_session_id: 's1',
      ctx: { task_id: 't1', task_name: 'nightly', error_signature: 'boom' },
      metadata_run_id: null,
    })

  test('scheduled_task launched: the heal takes the claim for the scheduler default email, so the spawn_timeout notice sends nothing', async () => {
    const rec0 = { sends: [] as any[] }
    const n = onceNotify(rec0)
    const { deps, rec } = mk({ heal: { notify: n.notify } })
    rec.sends = rec0.sends
    const out = await routeHeal(taskEvent(), deps)
    expect(out).toEqual({ kind: 'autospawn_launched' }) // not claimed in the outcome: the default email goes out
    expect(n.claims).toEqual(['ev1'])
    expect(rec.sends.length).toBe(0)
    // the deadline fires: the failed finalization loses the claim -> no second notification
    rec.timers[0]!.fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(rec.outcomes[rec.outcomes.length - 1]).toBe('failed:spawn_timeout')
    expect(rec.sends.length).toBe(0)
  })

  test('coolify launched then spawn_timeout: the heal notice is the one notification (exactly one send)', async () => {
    const rec0 = { sends: [] as any[] }
    const n = onceNotify(rec0)
    const { deps, rec } = mk({ heal: { notify: n.notify } })
    rec.sends = rec0.sends
    expect(await routeHeal(event(), deps)).toEqual({ kind: 'autospawn_launched' })
    expect(n.claims).toEqual([]) // nothing claimed at launch for non-scheduler sources
    rec.timers[0]!.fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(rec.sends.length).toBe(1)
  })

  test('scheduled_task refused / failed report ownership even when the one send fails', async () => {
    const rec0 = { sends: [] as any[] }
    const n = onceNotify(rec0)
    n.notify.send = async () => false
    const { deps } = mk({ heal: { notify: n.notify }, auto: { launchSessionForUser: async () => ({ ok: false, reason: 'at_capacity' }) as any } })
    const out = await routeHeal(taskEvent(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'autospawn_launch_at_capacity', notifyClaimed: true })
  })
})

describe('governed autospawn: happy path', () => {
  test('exactly one launch (machine true); gates, reserve, ledger all BEFORE launch; park with the same token and seven gates', async () => {
    const { deps, rec } = mk()
    const out = await routeHeal(event(), deps)
    expect(out).toEqual({ kind: 'autospawn_launched' })
    expect(rec.order).toEqual(['gates', 'reserve', 'ledger', 'launch'])
    expect(rec.launches).toEqual([{ userId: 'u1', sessionId: 's1', machine: true, skipPermissions: false }])
    expect(rec.gateChecks[0]).toEqual(GATE_ORDER)
    expect(rec.reserves[0]).toMatchObject({
      userId: 'u1',
      sessionId: 's1',
      token: 'heal:ev1',
      counterKey: buildHealKey('u1', REPO),
      enforceRate: true,
    })
    expect(rec.releases.length).toBe(0)
    expect(rec.ledger[0]).toMatchObject({ session_id: 's1', repo_key: REPO, outcome: 'launched' })
    expect(rec.ledger[0].decision_rationale).toContain('ev1')
    expect(rec.dispatches.length).toBe(1)
    expect(rec.dispatches[0]!.req.token).toBe('heal:ev1')
    expect(rec.dispatches[0]!.pdeps.gates.map((g: any) => g.name)).toEqual(GATE_ORDER)
    expect(rec.outcomes[rec.outcomes.length - 1]).toBe('autospawn_launched')
    expect(rec.terminal).toEqual([])
    expect(rec.sends.length).toBe(0)
    expect(rec.timers.length).toBe(1)
    expect(rec.timers[0]!.ms).toBe(25_000)
  })

  test('the spawn deadline follows REMO_HEAL_SPAWN_TIMEOUT_MS', async () => {
    process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = '1234'
    const { deps, rec } = mk()
    await routeHeal(event(), deps)
    expect(rec.timers[0]!.ms).toBe(1234)
  })

  test('arming is the heal flag AND the autospawn flag only: orchestrator-enabled unset still proceeds', async () => {
    delete process.env.REMO_ORCHESTRATOR_ENABLED
    process.env.REMO_ORCHESTRATOR_AUTOSPAWN = '1'
    expect(healAutospawnArmed()).toBe(true)
    expect(REAL_AUTOSPAWN.armed()).toBe(true)
    const { deps, rec } = mk({ auto: { armed: REAL_AUTOSPAWN.armed } })
    expect((await routeHeal(event(), deps)).kind).toBe('autospawn_launched')
    expect(rec.launches.length).toBe(1)
    delete process.env.REMO_ORCHESTRATOR_AUTOSPAWN
    expect(REAL_AUTOSPAWN.armed()).toBe(false)
  })

  test('two events with one dedupe_key produce exactly one launch in total', async () => {
    const { deps, rec } = mk()
    const a = await routeHeal(event(), deps)
    const b = await routeHeal(event({ metadata_run_id: 'meta2', trigger_run_id: 'trig2' }), deps)
    expect(a.kind).toBe('autospawn_launched')
    expect(b).toEqual({ kind: 'deduped' })
    expect(rec.launches.length).toBe(1)
  })
})

describe('governed autospawn: refusals launch nothing', () => {
  test('not armed (heal ON, autospawn flag OFF): zero launches, zero reservations, no_routable_session, notified once', async () => {
    const { deps, rec } = mk({ auto: { armed: () => false } })
    const out = await routeHeal(event(), deps)
    expect(out).toEqual({ kind: 'no_routable_session', reason: 'autospawn_not_armed', notified: true, notifyClaimed: true })
    expect(rec.launches.length).toBe(0)
    expect(rec.reserves.length).toBe(0)
    expect(rec.sends.length).toBe(1)
    expect(rec.terminal.map((t) => t.kind)).toEqual(['no_routable_session'])
  })

  test('not allowlisted (offline BOUND session): zero gate checks, zero launches', async () => {
    const { deps, rec } = mk({ auto: { isRepoAutospawnAllowed: async () => false } })
    const out = await routeHeal(event(), deps)
    expect(out).toMatchObject({ kind: 'no_routable_session', reason: 'not_allowlisted' })
    expect(rec.gateChecks.length).toBe(0)
    expect(rec.reserves.length).toBe(0)
    expect(rec.launches.length).toBe(0)
    expect(rec.sends.length).toBe(1)
  })

  test('supervisor offline: no_routable_session supervisor_offline', async () => {
    const { deps, rec } = mk({ auto: { supervisorOnlineForUser: async () => false } })
    expect(await routeHeal(event(), deps)).toMatchObject({ kind: 'no_routable_session', reason: 'supervisor_offline' })
    expect(rec.launches.length).toBe(0)
  })

  test('over the token cap: refused over_token_cap, zero launches', async () => {
    const { deps, rec } = mk({ auto: { getTokenCapStatus: async () => ({ over: true }) } })
    expect(await routeHeal(event(), deps)).toEqual({ kind: 'refused', reason: 'over_token_cap', notifyClaimed: true })
    expect(rec.launches.length).toBe(0)
    expect(rec.reserves.length).toBe(0)
  })

  test('launch-count cap: refused launch_cap, zero launches', async () => {
    const { deps, rec } = mk({ auto: { isOverAutospawnDailyLaunchCap: () => true } })
    expect(await routeHeal(event(), deps)).toEqual({ kind: 'refused', reason: 'launch_cap', notifyClaimed: true })
    expect(rec.launches.length).toBe(0)
  })

  test('a gate refusal (cost cap / kill switch): zero reservation, zero launch, refused with that reason', async () => {
    for (const reason of ['over_daily_cost_cap:5', 'automation_halted']) {
      const { deps, rec } = mk({ auto: { checkGates: async () => reason } })
      expect(await routeHeal(event(), deps)).toEqual({ kind: 'refused', reason, notifyClaimed: true })
      expect(rec.reserves.length).toBe(0)
      expect(rec.launches.length).toBe(0)
      expect(rec.terminal.map((t) => t.kind)).toEqual(['refused'])
      expect(rec.sends.length).toBe(1)
    }
  })

  test('lifetime reservation exhausted: refused with the lifetime reason, zero launches', async () => {
    const { deps, rec } = mk({ auto: { reserve: async () => ({ ok: false, reason: 'lifetime_inject_exhausted:20>=20' }) } })
    expect(await routeHeal(event(), deps)).toEqual({ kind: 'refused', reason: 'lifetime_inject_exhausted:20>=20', notifyClaimed: true })
    expect(rec.launches.length).toBe(0)
  })

  test('ledger append throws: refused ledger_unavailable, reservation released, zero launches (fail closed)', async () => {
    const { deps, rec } = mk({
      auto: {
        appendRunLog: async () => {
          throw new Error('db down')
        },
      },
    })
    expect(await routeHeal(event(), deps)).toEqual({ kind: 'refused', reason: 'ledger_unavailable', notifyClaimed: true })
    expect(rec.launches.length).toBe(0)
    expect(rec.releases.length).toBe(1)
  })
})

describe('governed autospawn: launch failure and in-flight', () => {
  test('launch not ok: reservation released, refused autospawn_launch_{reason}, terminalized, notified once', async () => {
    const { deps, rec } = mk({ auto: { launchSessionForUser: async () => ({ ok: false, reason: 'at_capacity' }) as any } })
    expect(await routeHeal(event(), deps)).toEqual({ kind: 'refused', reason: 'autospawn_launch_at_capacity', notifyClaimed: true })
    expect(rec.releases.length).toBe(1)
    expect(rec.releases[0]).toEqual({ counterKey: buildHealKey('u1', REPO), token: 'heal:ev1' })
    expect(rec.terminal.map((t) => t.kind)).toEqual(['refused'])
    expect(rec.sends.length).toBe(1)
    expect(rec.timers.length).toBe(0)
  })

  test('launch throwing: reservation released, failed, terminalized, notified once', async () => {
    const { deps, rec } = mk({
      auto: {
        launchSessionForUser: async () => {
          throw new Error('spawn exploded')
        },
      },
    })
    const out = await routeHeal(event(), deps)
    expect(out.kind).toBe('failed')
    expect(rec.releases.length).toBe(1)
    expect(rec.terminal.map((t) => t.kind)).toEqual(['failed'])
    expect(rec.sends.length).toBe(1)
  })

  test('in-flight launch for the session: autospawn_parked, ZERO second launch, still parked and watched', async () => {
    const { deps, rec } = mk({ auto: { graceParkPending: () => true } })
    const out = await routeHeal(event(), deps)
    expect(out).toEqual({ kind: 'autospawn_parked' })
    expect(rec.launches.length).toBe(0)
    expect(rec.reserves.length).toBe(0)
    expect(rec.dispatches.length).toBe(1)
    expect(rec.timers.length).toBe(1)
    expect(rec.outcomes[rec.outcomes.length - 1]).toBe('autospawn_parked')
  })
})

describe('governed autospawn: deadline, replay and release', () => {
  test('no reconnect: at the deadline the run fails heal_spawn_timeout, reservation released, notified once; a late replay does not dispatch', async () => {
    const { deps, rec } = mk()
    await routeHeal(event(), deps)
    const { req, pdeps } = rec.dispatches[0]!
    rec.timers[0]!.fn()
    await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(rec.terminal).toEqual([{ kind: 'failed', reason: 'heal_spawn_timeout' }])
    expect(rec.releases).toEqual([{ counterKey: buildHealKey('u1', REPO), token: 'heal:ev1' }])
    expect(rec.outcomes[rec.outcomes.length - 1]).toBe('failed:spawn_timeout')
    expect(rec.sends.length).toBe(1)

    await pdeps.replay(req) // the runner finally reconnects, too late
    expect(rec.dispatches.length).toBe(1)
    rec.timers[0]!.fn() // firing again is a no-op
    await new Promise((r) => setTimeout(r, 0))
    expect(rec.terminal.length).toBe(1)
    expect(rec.sends.length).toBe(1)
  })

  test('reconnect before the deadline: replay re-enters dispatch with the same token and the full gate list; timer cleared; outcome dispatched_after_spawn', async () => {
    const { deps, rec } = mk()
    await routeHeal(event(), deps)
    const { req, pdeps } = rec.dispatches[0]!
    deps.dispatch = async (r, p) => {
      rec.dispatches.push({ req: r, pdeps: p })
      return { kind: 'dispatched', runId: 'run-9' }
    }
    await pdeps.replay(req)
    expect(rec.dispatches.length).toBe(2)
    expect(rec.dispatches[1]!.req.token).toBe('heal:ev1')
    expect(rec.dispatches[1]!.pdeps.gates.map((g: any) => g.name)).toEqual(GATE_ORDER)
    expect(rec.timers[0]!.cleared).toBe(true)
    expect(rec.outcomes[rec.outcomes.length - 1]).toBe('dispatched_after_spawn')
    expect(rec.releases.length).toBe(0)
    rec.timers[0]!.fn() // a stale timer firing after delivery must not fail the run
    await new Promise((r) => setTimeout(r, 0))
    expect(rec.terminal.length).toBe(0)
  })

  test('a gate refusal on the re-gated replay releases the reservation and terminalizes once', async () => {
    const { deps, rec } = mk()
    await routeHeal(event(), deps)
    const { req, pdeps } = rec.dispatches[0]!
    deps.dispatch = async () => ({ kind: 'skipped', reason: 'over_daily_cost_cap:9' })
    await pdeps.replay(req)
    expect(rec.releases.length).toBe(1)
    expect(rec.terminal).toEqual([{ kind: 'refused', reason: 'over_daily_cost_cap:9' }])
    expect(rec.outcomes[rec.outcomes.length - 1]).toBe('refused:over_daily_cost_cap:9')
    expect(rec.sends.length).toBe(1)
  })

  test('grace expiry releases the reservation and terminalizes exactly once', async () => {
    const { deps, rec } = mk()
    await routeHeal(event(), deps)
    const { req, pdeps } = rec.dispatches[0]!
    await pdeps.onParkExpire(req)
    await pdeps.onParkExpire(req)
    expect(rec.releases.length).toBe(1)
    expect(rec.terminal.map((t) => t.kind)).toEqual(['failed'])
    expect(rec.timers[0]!.cleared).toBe(true)
    expect(rec.sends.length).toBe(1)
  })

  test('a dispatch that lands immediately (runner already connected) is delivered, no timer left armed', async () => {
    const { deps, rec } = mk({ heal: { dispatch: async () => ({ kind: 'dispatched', runId: 'r1' }) } })
    const out = await routeHeal(event(), deps)
    expect(out).toEqual({ kind: 'autospawn_launched' })
    expect(rec.outcomes[rec.outcomes.length - 1]).toBe('dispatched_after_spawn')
    expect(rec.timers.every((t) => t.cleared) || rec.timers.length === 0).toBe(true)
  })
})

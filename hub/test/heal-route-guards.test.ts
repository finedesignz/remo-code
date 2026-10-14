/**
 * PTYCAP-07-05 Task 3 -- routeHeal guards: recursion guard before the claim (fail closed),
 * dedupe finalization, per-user claim cap, per-repo hourly bound, and the never-silent wrapper
 * (D-05, D-06, AM-F4-4, AM-F5-3). DB-free, fully injected; no module mocks.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { routeHeal, type HealDeps } from '../src/heal/route.ts'
import { buildHealKey } from '../src/heal/counter-key.ts'
import { parseHealEvent } from '../src/heal/types.ts'
import type { HealSink, HealTerminalOutcome } from '../src/heal/sinks/types.ts'
import { SCOPE_CONTRACT } from '../src/dispatch/untrusted.ts'

const REPO = 'github://acme/web'
const prevFlag = process.env.REMO_HEAL_UNIFIED
beforeEach(() => {
  process.env.REMO_HEAL_UNIFIED = '1'
})
afterAll(() => {
  if (prevFlag === undefined) delete process.env.REMO_HEAL_UNIFIED
  else process.env.REMO_HEAL_UNIFIED = prevFlag
})

function coolify(over: Record<string, unknown> = {}) {
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

function mkDeps(over: Partial<HealDeps> = {}) {
  const rec = {
    terminal: [] as HealTerminalOutcome[],
    sinkCtx: [] as Array<string | null>,
    outcomes: [] as string[],
    claims: [] as any[],
    dispatches: 0,
    dispatchReq: null as any,
    provenanceChecks: [] as string[],
  }
  const deps: HealDeps = {
    now: () => 1_700_000_000_000,
    resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
    claim: async (args) => {
      rec.claims.push(args)
      return { ok: true, id: 'ev1' }
    },
    setOutcome: async (_id, outcome) => {
      rec.outcomes.push(outcome)
    },
    isHealGenerated: async (runId) => {
      rec.provenanceChecks.push(runId)
      return false
    },
    countRepoDispatches: async () => 0,
    makeSink: (_e, ctx) => {
      rec.sinkCtx.push(ctx.eventId)
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
    dispatch: async (req) => {
      rec.dispatches++
      rec.dispatchReq = req
      return { kind: 'dispatched', runId: 'run1' }
    },
    isChannelOnline: () => true,
    // hermetic: never reach the real claim / email seam (07-06)
    notify: { claim: async () => false, resolveOwnerEmail: async () => null, send: async () => false },
    ...over,
  }
  return { deps, rec }
}

describe('recursion guard (AM-F5-3)', () => {
  test('heal-generated metadata run => refused heal_provenance; claim called ZERO times; no dispatch', async () => {
    const { deps, rec } = mkDeps({ isHealGenerated: async (r) => r === 'meta1' })
    const out = await routeHeal(coolify(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'heal_provenance' })
    expect(rec.claims.length).toBe(0)
    expect(rec.dispatches).toBe(0)
    expect(rec.terminal).toEqual([{ kind: 'refused', reason: 'heal_provenance' }])
  })

  test('heal-generated trigger run is also refused before the claim', async () => {
    const { deps, rec } = mkDeps({ isHealGenerated: async (r) => r === 'trig1' })
    const out = await routeHeal(coolify(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'heal_provenance' })
    expect(rec.claims.length).toBe(0)
  })

  test('provenance check THROWS => refused heal_guard_error (fail closed); claim zero; metadata terminalized failed', async () => {
    const { deps, rec } = mkDeps({
      isHealGenerated: async () => {
        throw new Error('db down')
      },
    })
    const out = await routeHeal(coolify(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'heal_guard_error' })
    expect(rec.claims.length).toBe(0)
    expect(rec.dispatches).toBe(0)
    expect(rec.terminal).toEqual([{ kind: 'failed', reason: 'heal_guard_error' }])
  })

  test('events with no run ids skip the provenance check and still route', async () => {
    const { deps, rec } = mkDeps()
    const out = await routeHeal(coolify({ metadata_run_id: null, trigger_run_id: null }), deps)
    expect(out.kind).toBe('dispatched_live')
    expect(rec.provenanceChecks).toEqual([])
  })
})

describe('dedupe and caps', () => {
  test('duplicate claim => deduped; metadata finalized through the sink; no dispatch', async () => {
    const { deps, rec } = mkDeps({ claim: async () => ({ ok: false, reason: 'duplicate' }) })
    const out = await routeHeal(coolify(), deps)
    expect(out).toEqual({ kind: 'deduped' })
    expect(rec.dispatches).toBe(0)
    expect(rec.terminal).toEqual([{ kind: 'deduped' }])
  })

  test('user_claim_cap => refused user_claim_cap; terminalized; no dispatch', async () => {
    const { deps, rec } = mkDeps({ claim: async () => ({ ok: false, reason: 'user_claim_cap' }) })
    const out = await routeHeal(coolify(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'user_claim_cap' })
    expect(rec.dispatches).toBe(0)
    expect(rec.terminal).toEqual([{ kind: 'refused', reason: 'user_claim_cap' }])
  })

  test('per-repo hourly bound: at the limit => refused repo_rate_bound, row set, no dispatch', async () => {
    const { deps, rec } = mkDeps({ countRepoDispatches: async () => 4 })
    const out = await routeHeal(coolify(), deps)
    expect(out).toEqual({ kind: 'refused', reason: 'repo_rate_bound', notifyClaimed: false })
    expect(rec.dispatches).toBe(0)
    expect(rec.outcomes).toEqual(['refused:repo_rate_bound'])
    expect(rec.terminal.length).toBe(1)
  })

  test('per-repo bound: below the limit dispatches', async () => {
    const { deps, rec } = mkDeps({ countRepoDispatches: async () => 3 })
    expect((await routeHeal(coolify(), deps)).kind).toBe('dispatched_live')
    expect(rec.dispatches).toBe(1)
  })
})

describe('never-silent wrapper (D-06)', () => {
  test('a throwing claim => failed heal_route_error; dispatch NEVER called (no fail-open); sink tolerates no ledger id', async () => {
    const { deps, rec } = mkDeps({
      claim: async () => {
        throw new Error('pg exploded')
      },
    })
    const out = await routeHeal(coolify(), deps)
    expect(out.kind).toBe('failed')
    expect((out as any).reason.startsWith('heal_route_error')).toBe(true)
    expect(rec.dispatches).toBe(0)
    expect(rec.terminal.length).toBe(1)
    expect(rec.terminal[0]!.kind).toBe('failed')
    expect(rec.sinkCtx).toContain(null)
  })

  test('a throwing dispatch => failed, persisted, terminalized, not rethrown', async () => {
    const { deps, rec } = mkDeps({
      dispatch: async () => {
        throw new Error('open() blew up')
      },
    })
    const out = await routeHeal(coolify(), deps)
    expect(out.kind).toBe('failed')
    expect(rec.outcomes[rec.outcomes.length - 1]!.startsWith('failed:heal_route_error')).toBe(true)
    expect(rec.terminal[0]!.kind).toBe('failed')
  })

  test('a throwing resolver => failed heal_route_error, nothing dispatched', async () => {
    const { deps, rec } = mkDeps({
      resolve: async () => {
        throw new Error('resolver')
      },
    })
    const out = await routeHeal(coolify(), deps)
    expect(out.kind).toBe('failed')
    expect(rec.dispatches).toBe(0)
    expect(rec.terminal.length).toBe(1)
  })

  test('a throwing outcome write is logged, never thrown, and the dispatch result stands', async () => {
    const { deps } = mkDeps({
      setOutcome: async () => {
        throw new Error('ledger write failed')
      },
    })
    expect((await routeHeal(coolify(), deps)).kind).toBe('dispatched_live')
  })
})

describe('derived identity and prompt', () => {
  test('bound-source event: the claim and the key use the ident derived from the owned session even with a null hint', async () => {
    const { deps, rec } = mkDeps()
    const ev = parseHealEvent({
      source: 'error_capture',
      user_id: 'u1',
      repo_ident: null,
      prompt: 'boom',
      metadata_run_id: null,
      trigger_run_id: null,
      dedupe_key: 'err:e1',
      bound_session_id: 's1',
      ctx: { error_id: 'e1', project_id: 'p1' },
    })
    await routeHeal(ev, deps)
    expect(rec.claims[0].repoIdent).toBe(REPO)
    expect(rec.dispatchReq.counterKey).toBe(buildHealKey('u1', REPO))
  })

  test('a prompt that already carries the scope contract is not contracted again', async () => {
    const { deps, rec } = mkDeps()
    await routeHeal(coolify({ prompt: `fix it\n\n${SCOPE_CONTRACT}` }), deps)
    expect(rec.dispatchReq.prompt.split(SCOPE_CONTRACT).length - 1).toBe(1)
  })
})

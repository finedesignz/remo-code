/**
 * PTYCAP-07-06 Task 1 -- the fail-fast path (SH-05, D-05, AM-F3-2): an un-routable / refused /
 * failed heal event terminalizes within the request and emits exactly ONE notification attempt.
 * DB-free; the incident-shaped scenario has an unrelated online session for another repo that
 * must receive zero dispatches.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'

import { describe, test, expect, beforeEach } from 'bun:test'
import { routeHeal, type HealDeps } from '../src/heal/route.ts'
import { parseHealEvent } from '../src/heal/types.ts'
import type { HealSink, HealTerminalOutcome } from '../src/heal/sinks/types.ts'
import type { NotifyDeps } from '../src/heal/notify.ts'

const REPO = 'github://acme/web'

beforeEach(() => {
  process.env.REMO_HEAL_UNIFIED = '1'
  delete process.env.REMO_ORCHESTRATOR_AUTOSPAWN
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

function mkDeps(over: Partial<HealDeps> = {}) {
  const rec = {
    terminal: [] as HealTerminalOutcome[],
    outcomes: [] as string[],
    dispatches: [] as any[],
    claimed: [] as string[],
    sends: [] as any[],
  }
  const seen = new Set<string>()
  const notifyDeps: NotifyDeps = {
    claim: async (id) => {
      rec.claimed.push(id)
      return true
    },
    resolveOwnerEmail: async () => 'owner@example.com',
    send: async (m) => {
      rec.sends.push(m)
      return true
    },
  }
  const deps: HealDeps = {
    now: () => 1_700_000_000_000,
    resolve: async () => ({ kind: 'none', reason: 'no_session_for_repo' }),
    claim: async (a) => {
      const k = `${a.source}|${a.dedupeKey}`
      if (seen.has(k)) return { ok: false, reason: 'duplicate' }
      seen.add(k)
      return { ok: true, id: `ev-${seen.size}` }
    },
    setOutcome: async (_id, o) => {
      rec.outcomes.push(o)
    },
    isHealGenerated: async () => false,
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
    dispatch: async (req) => {
      rec.dispatches.push(req)
      return { kind: 'dispatched', runId: 'run1' }
    },
    // The incident shape: an UNRELATED online session for another repo exists.
    runnerTypeOf: async () => 'stream-json',
    isChannelOnline: (id) => id === 'other-repo-session',
    notify: notifyDeps,
    ...over,
  }
  return { deps, rec }
}

describe('fail-fast terminal path (SH-05)', () => {
  test('incident shape: terminal within 5s, zero dispatches, exactly one notification attempt', async () => {
    const { deps, rec } = mkDeps()
    const t0 = Date.now()
    const out = await routeHeal(event(), deps)
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(out).toEqual({ kind: 'no_routable_session', reason: 'no_session_for_repo', notified: true, notifyClaimed: true })
    expect(rec.terminal).toEqual([{ kind: 'no_routable_session', reason: 'no_session_for_repo', notified: false }])
    expect(rec.dispatches.length).toBe(0) // the unrelated session received nothing
    expect(rec.claimed).toEqual(['ev-1'])
    expect(rec.sends.length).toBe(1)
    expect(rec.sends[0].subject).toBe('[heal] github://acme/web: no_session_for_repo')
  })

  test('a deduped second event sends nothing and still terminalizes its own run', async () => {
    const { deps, rec } = mkDeps()
    await routeHeal(event(), deps)
    const second = await routeHeal(event({ metadata_run_id: 'meta2', trigger_run_id: 'trig2' }), deps)
    expect(second).toEqual({ kind: 'deduped' })
    expect(rec.sends.length).toBe(1) // still only the first event's attempt
    expect(rec.terminal.map((t) => t.kind)).toEqual(['no_routable_session', 'deduped'])
  })

  test('notified is false when the send fails; the outcome is unchanged and not retried', async () => {
    const sends: number[] = []
    const { deps } = mkDeps({
      notify: {
        claim: async () => true,
        resolveOwnerEmail: async () => 'o@x.com',
        send: async () => {
          sends.push(1)
          return false
        },
      },
    })
    const out = await routeHeal(event(), deps)
    expect(out).toEqual({ kind: 'no_routable_session', reason: 'no_session_for_repo', notified: false, notifyClaimed: true })
    expect(sends.length).toBe(1)
  })

  test('a throwing notify seam never throws out of routeHeal', async () => {
    const { deps } = mkDeps({
      notify: {
        claim: async () => {
          throw new Error('db down')
        },
        resolveOwnerEmail: async () => 'o@x.com',
        send: async () => true,
      },
    })
    const out = await routeHeal(event(), deps)
    expect(out.kind).toBe('no_routable_session')
  })

  test('refused (repo rate bound) and failed (route error) outcomes with a ledger row notify once each', async () => {
    const a = mkDeps({
      resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
      claim: async () => ({ ok: true, id: 'ev1', repoRateBound: true }),
    })
    expect((await routeHeal(event(), a.deps)).kind).toBe('refused')
    expect(a.rec.sends.length).toBe(1)

    const b = mkDeps({
      resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }),
      dispatch: async () => {
        throw new Error('boom')
      },
    })
    expect((await routeHeal(event(), b.deps)).kind).toBe('failed')
    expect(b.rec.sends.length).toBe(1)
  })

  test('a live dispatch never notifies', async () => {
    const { deps, rec } = mkDeps({ resolve: async () => ({ kind: 'routable_live', sessionId: 's1', repoIdent: REPO }) })
    expect((await routeHeal(event(), deps)).kind).toBe('dispatched_live')
    expect(rec.sends.length).toBe(0)
    expect(rec.claimed.length).toBe(0)
  })

  test('events without a ledger row (invalid / provenance / claim refusal) never notify', async () => {
    const { deps, rec } = mkDeps({ isHealGenerated: async () => true })
    expect((await routeHeal(event(), deps)).kind).toBe('refused')
    expect(rec.sends.length).toBe(0)
  })

  test('distinct dedupe keys each notify once; the same key notifies once', async () => {
    const { deps, rec } = mkDeps()
    await routeHeal(event({ dedupe_key: 'coolify:k1' }), deps)
    await routeHeal(event({ dedupe_key: 'coolify:k1' }), deps)
    await routeHeal(event({ dedupe_key: 'coolify:k2' }), deps)
    expect(rec.sends.length).toBe(2)
  })
})

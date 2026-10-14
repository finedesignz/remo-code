/**
 * PTYCAP-07-06 Task 3 -- boot sweep for heal launches stranded by a hub restart (SC4, T-07-21,
 * T-07-24). DB-free: every collaborator is injected.
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  sweepStaleHealLaunches,
  bootSweepHealLaunches,
  followUpDelayMs,
  SWEEP_BATCH,
  type SweepDeps,
} from '../src/heal/sweep.ts'
import { OUTCOME_AUTOSPAWN_STARTING } from '../src/heal/types.ts'
import type { HealEventRow } from '../src/db/heal-events-dal.ts'
import type { HealTerminalOutcome } from '../src/heal/sinks/types.ts'

const savedFlag = process.env.REMO_HEAL_UNIFIED
const savedTimeout = process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
beforeEach(() => {
  process.env.REMO_HEAL_UNIFIED = '1'
  delete process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
})
afterAll(() => {
  if (savedFlag === undefined) delete process.env.REMO_HEAL_UNIFIED
  else process.env.REMO_HEAL_UNIFIED = savedFlag
  if (savedTimeout === undefined) delete process.env.REMO_HEAL_SPAWN_TIMEOUT_MS
  else process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = savedTimeout
})

function row(id: string, over: Partial<HealEventRow> = {}): HealEventRow {
  return {
    id,
    user_id: 'u1',
    source: 'coolify_deploy',
    repo_ident: 'github://acme/web',
    dedupe_key: `coolify:${id}`,
    window_bucket: 1,
    trigger_run_id: `t-${id}`,
    dispatch_run_id: null,
    metadata_run_id: `m-${id}`,
    session_id: 's1',
    outcome: 'autospawn_launched',
    notification_claimed_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  }
}

function mk(rows: HealEventRow[], over: Partial<SweepDeps> = {}) {
  const rec = {
    listArgs: [] as number[],
    terminal: [] as Array<[string, HealTerminalOutcome]>,
    released: [] as string[][],
    outcomes: [] as Array<[string, string]>,
    sends: [] as any[],
    listCalls: 0,
  }
  const deps: SweepDeps = {
    list: async (ms) => {
      rec.listCalls++
      rec.listArgs.push(ms)
      return rows
    },
    reread: async (id) => ({ outcome: rows.find((r) => r.id === id)?.outcome ?? null }),
    setOutcome: async (id, o) => {
      rec.outcomes.push([id, o])
    },
    makeSink: (_e, ctx) => ({
      open: async () => null,
      markSkipped: async () => {},
      markDispatched: async () => {},
      onFinalize: async () => {},
      markFailed: async () => {},
      send: async () => {},
      finalizeTerminal: async (o) => {
        rec.terminal.push([ctx.eventId as string, o])
      },
      onParkExpire: async () => {},
    }),
    release: async (u, r, e) => {
      rec.released.push([u, r, e])
    },
    notify: {
      claim: async () => true,
      resolveOwnerEmail: async () => 'o@x.com',
      send: async (m) => {
        rec.sends.push(m)
        return true
      },
    },
    ...over,
  }
  return { deps, rec }
}

describe('sweepStaleHealLaunches', () => {
  test('terminalizes each stranded launch, releases its reservation, writes the ledger outcome and notifies once', async () => {
    const { deps, rec } = mk([row('a'), row('b')])
    const res = await sweepStaleHealLaunches(deps)
    expect(res).toEqual({ swept: 2, skipped: 0, failed: 0 })
    expect(rec.terminal).toEqual([
      ['a', { kind: 'failed', reason: 'heal_spawn_timeout' }],
      ['b', { kind: 'failed', reason: 'heal_spawn_timeout' }],
    ])
    expect(rec.released).toEqual([
      ['u1', 'github://acme/web', 'a'],
      ['u1', 'github://acme/web', 'b'],
    ])
    expect(rec.outcomes).toEqual([
      ['a', 'failed:spawn_timeout'],
      ['b', 'failed:spawn_timeout'],
    ])
    expect(rec.sends.length).toBe(2)
  })

  test('selects rows older than twice the spawn timeout', async () => {
    const { deps, rec } = mk([])
    await sweepStaleHealLaunches(deps)
    expect(rec.listArgs).toEqual([50_000])
    process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = '1000'
    await sweepStaleHealLaunches(deps)
    expect(rec.listArgs[1]).toBe(2000)
  })

  test('a row whose outcome already changed is skipped untouched', async () => {
    const { deps, rec } = mk([row('a'), row('b')], {
      reread: async (id) => ({ outcome: id === 'a' ? 'dispatched_after_spawn' : 'autospawn_launched' }),
    })
    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 1, skipped: 1, failed: 0 })
    expect(rec.terminal.map((t) => t[0])).toEqual(['b'])
    expect(rec.released.length).toBe(1)
  })

  test('a sink failure counts as failed but the reservation and ledger outcome are still reconciled; other rows continue', async () => {
    const { deps, rec } = mk([row('a'), row('b'), row('c')])
    const base = deps.makeSink
    deps.makeSink = (e, ctx) => {
      if (ctx.eventId === 'b') throw new Error('sink exploded')
      return base(e, ctx)
    }
    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 2, skipped: 0, failed: 1 })
    expect(rec.terminal.map((t) => t[0])).toEqual(['a', 'c'])
    // b's slot is freed and its row closed (no re-failing on every boot)
    expect(rec.released.map((r) => r[2])).toEqual(['a', 'b', 'c'])
    expect(rec.outcomes.map((o) => o[0])).toEqual(['a', 'b', 'c'])
  })

  test('a release failure leaves the row for the next sweep (the slot is still stranded)', async () => {
    const { deps, rec } = mk([row('a'), row('b')], {
      release: async (_u, _r, e) => {
        if (e === 'a') throw new Error('db down')
      },
    })
    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 1, skipped: 0, failed: 1 })
    expect(rec.outcomes.map((o) => o[0])).toEqual(['b']) // a stays stranded: retried
  })

  test('autospawn_starting rows (crash between claim and launched) are swept and their reservation released', async () => {
    const { deps, rec } = mk([row('a', { outcome: OUTCOME_AUTOSPAWN_STARTING })])
    expect((await sweepStaleHealLaunches(deps)).swept).toBe(1)
    expect(rec.released).toEqual([['u1', 'github://acme/web', 'a']])
    expect(rec.outcomes).toEqual([['a', 'failed:spawn_timeout']])
  })

  test('error_capture rows are rebuilt with recovery_ctx and the bound session id, so the sink can be constructed', async () => {
    const seen: any[] = []
    const { deps, rec } = mk(
      [
        row('e1', {
          source: 'error_capture',
          dedupe_key: 'err:p1:fp',
          session_id: 's-bound',
          recovery_ctx: { error_id: 'err1', project_id: 'p1' },
        }),
      ],
      {
        makeSink: (event, ctx) => {
          seen.push(event)
          // mirrors buildErrorCaptureSink's precondition
          if (!('bound_session_id' in event) || !(event as any).ctx.error_id) throw new Error('error_capture_context_missing')
          return {
            open: async () => null,
            markSkipped: async () => {},
            markDispatched: async () => {},
            onFinalize: async () => {},
            markFailed: async () => {},
            send: async () => {},
            finalizeTerminal: async (o) => {
              rec.terminal.push([ctx.eventId as string, o])
            },
            onParkExpire: async () => {},
          }
        },
      },
    )
    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 1, skipped: 0, failed: 0 })
    expect(seen[0].bound_session_id).toBe('s-bound')
    expect(seen[0].ctx).toEqual({ error_id: 'err1', project_id: 'p1' })
    expect(rec.terminal).toEqual([['e1', { kind: 'failed', reason: 'heal_spawn_timeout' }]])
    expect(rec.released).toEqual([['u1', 'github://acme/web', 'e1']])
  })

  test('a thrown list query is swallowed', async () => {
    const { deps } = mk([], {
      list: async () => {
        throw new Error('db down')
      },
    })
    expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 0, skipped: 0, failed: 0 })
  })

  test('a row with no repo ident is still terminalized, with no release', async () => {
    const { deps, rec } = mk([row('a', { repo_ident: null })])
    expect((await sweepStaleHealLaunches(deps)).swept).toBe(1)
    expect(rec.released.length).toBe(0)
  })

  test('parked rows are covered too', async () => {
    const { deps } = mk([row('a', { outcome: 'autospawn_parked' })])
    expect((await sweepStaleHealLaunches(deps)).swept).toBe(1)
  })

  test('bounded at 50 rows per boot', async () => {
    const many = Array.from({ length: 70 }, (_, i) => row(`r${i}`))
    const { deps, rec } = mk(many)
    expect(SWEEP_BATCH).toBe(50)
    expect((await sweepStaleHealLaunches(deps)).swept).toBe(50)
    expect(rec.terminal.length).toBe(50)
  })
})

describe('follow-up sweep at the deadline (SC4: no heal run stays pending past deadline + margin)', () => {
  /** A fake clock + a DAL-faithful list(): rows older than the guard, at the CURRENT fake time. */
  function clockDb(rows: HealEventRow[], bootAt: number) {
    let now = bootAt
    const timers: Array<{ fn: () => void; ms: number }> = []
    const swept: string[] = []
    const { deps } = mk(rows, {
      list: async (olderThanMs) => rows.filter((r) => r.outcome && new Date(r.updated_at).getTime() < now - olderThanMs),
      setOutcome: async (id) => {
        swept.push(id)
        const r = rows.find((x) => x.id === id)!
        r.outcome = 'failed:spawn_timeout'
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length
      },
    })
    return { deps, timers, swept, advance: (ms: number) => (now += ms) }
  }

  test('a row stranded 20s before boot (younger than the 50s guard) is missed at boot and swept by the one follow-up', async () => {
    const boot = 1_000_000
    const stranded = row('quick', { updated_at: new Date(boot - 20_000) })
    const { deps, timers, swept, advance } = clockDb([stranded], boot)

    await bootSweepHealLaunches(deps)
    expect(swept).toEqual([]) // boot sweep: row is only 20s old
    expect(timers.length).toBe(1) // exactly ONE follow-up, not an interval

    expect(timers[0]!.ms).toBe(followUpDelayMs())
    expect(timers[0]!.ms).toBeGreaterThan(2 * 25_000) // strictly past the staleness guard
    advance(timers[0]!.ms)
    timers[0]!.fn()
    await new Promise((r) => setTimeout(r, 10))
    expect(swept).toEqual(['quick'])
    expect(timers.length).toBe(1) // the follow-up does not re-arm
  })

  test('the delay tracks REMO_HEAL_SPAWN_TIMEOUT_MS', () => {
    process.env.REMO_HEAL_SPAWN_TIMEOUT_MS = '4000'
    expect(followUpDelayMs()).toBe(9000)
  })

  test('flag OFF: no sweep and no timer is armed', async () => {
    process.env.REMO_HEAL_UNIFIED = '0'
    const { deps, timers } = clockDb([row('a')], 0)
    await bootSweepHealLaunches(deps)
    expect(timers.length).toBe(0)
  })
})

describe('flag OFF (behavioural)', () => {
  test('with the heal flag OFF the sweep reads nothing and touches nothing', async () => {
    for (const v of [undefined, '', '0', 'false', 'maybe']) {
      if (v === undefined) delete process.env.REMO_HEAL_UNIFIED
      else process.env.REMO_HEAL_UNIFIED = v
      const { deps, rec } = mk([row('a')])
      expect(await sweepStaleHealLaunches(deps)).toEqual({ swept: 0, skipped: 0, failed: 0 })
      expect(rec.listCalls).toBe(0)
      expect(rec.terminal.length).toBe(0)
      expect(rec.released.length).toBe(0)
    }
  })
})

describe('boot wiring pin (source text)', () => {
  const src = readFileSync(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf8')

  test('hub/src/index.ts calls bootSweepHealLaunches only inside a heal-enabled guard', () => {
    const at = src.indexOf('bootSweepHealLaunches')
    expect(at).toBeGreaterThan(-1)
    const guard = src.lastIndexOf('if (healUnifiedEnabled())', at)
    expect(guard).toBeGreaterThan(-1)
    expect(at - guard).toBeLessThan(300)
  })

  test('the sweep module is imported lazily (never eagerly), and there is no interval timer for it', () => {
    expect(/^import[^\n]*heal\/sweep/m.test(src)).toBe(false)
    expect(src).toContain("import('./heal/sweep.ts')")
    expect(/setInterval[^\n]*[Hh]eal/.test(src)).toBe(false)
  })
})

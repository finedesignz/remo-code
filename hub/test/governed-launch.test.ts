/**
 * PTYCAP-07-04 Task 2: governedLaunch adapter (AM-F1-1..AM-F1-3). Fully injected deps - no DB,
 * no WS, no mock.module.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  governedLaunch,
  type GovernedLaunchArgs,
  type GovernedLaunchDeps,
} from '../src/dispatch/governed-launch.ts'

let calls: string[] = []
let launchArgs: any[] = []
let ledgerRows: any[] = []
const st = {
  allowed: true,
  supOnline: true,
  tokenOver: false,
  launches: 0,
  launchCap: false,
  grace: false,
  launchResult: { ok: true, runId: 'run-1', supervisorId: 'sup-1', hostname: 'h', repoPath: '/r' } as any,
  launchThrows: null as null | string,
  ledgerThrows: false,
  gateReason: null as null | string,
  reserveResult: { ok: true } as any,
}

function deps(): GovernedLaunchDeps {
  return {
    isRepoAutospawnAllowed: async () => {
      calls.push('allow')
      return st.allowed
    },
    supervisorOnlineForUser: async () => {
      calls.push('sup')
      return st.supOnline
    },
    getTokenCapStatus: async () => {
      calls.push('token')
      return { over: st.tokenOver }
    },
    countAutospawnLaunchesToday: async () => {
      calls.push('count')
      return st.launches
    },
    isOverAutospawnDailyLaunchCap: () => {
      calls.push('cap')
      return st.launchCap
    },
    graceParkPending: () => {
      calls.push('grace')
      return st.grace
    },
    launchSessionForUser: async (a) => {
      calls.push('launch')
      launchArgs.push(a)
      if (st.launchThrows) throw new Error(st.launchThrows)
      return st.launchResult
    },
    appendRunLog: async (row) => {
      calls.push('ledger')
      if (st.ledgerThrows) throw new Error('ledger down')
      ledgerRows.push(row)
      return {}
    },
  }
}

function args(over: Partial<GovernedLaunchArgs> = {}): GovernedLaunchArgs {
  return {
    userId: 'u1',
    sessionId: 's1',
    repoIdent: 'github://o/r',
    tz: 'UTC',
    armed: true,
    ledger: {
      repoKey: 'github://o/r',
      command: 'autospawn-launch',
      rationale: (l) => (l ? `launched run=${l.runId} sup=${l.supervisorId}` : 'pre-launch'),
    },
    ...over,
  }
}

function governor(): NonNullable<GovernedLaunchArgs['preLaunch']> {
  return {
    checkGates: async () => {
      calls.push('gates')
      return st.gateReason
    },
    reserve: async () => {
      calls.push('reserve')
      return st.reserveResult
    },
    release: async () => {
      calls.push('release')
    },
  }
}

beforeEach(() => {
  calls = []
  launchArgs = []
  ledgerRows = []
  st.allowed = true
  st.supOnline = true
  st.tokenOver = false
  st.launches = 0
  st.launchCap = false
  st.grace = false
  st.launchResult = { ok: true, runId: 'run-1', supervisorId: 'sup-1', hostname: 'h', repoPath: '/r' }
  st.launchThrows = null
  st.ledgerThrows = false
  st.gateReason = null
  st.reserveResult = { ok: true }
})

describe('governedLaunch - heal policy (governor supplied)', () => {
  test('success: order gates, reserve, ledger, launch; release NOT called; ledger once', async () => {
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'launched', runId: 'run-1', supervisorId: 'sup-1' })
    const tail = calls.slice(calls.indexOf('gates'))
    expect(tail).toEqual(['gates', 'reserve', 'ledger', 'launch'])
    expect(calls).not.toContain('release')
    expect(ledgerRows).toHaveLength(1)
    expect(ledgerRows[0].decision_rationale).toBe('pre-launch')
    expect(launchArgs).toEqual([{ userId: 'u1', sessionId: 's1', machine: true, skipPermissions: false }])
  })

  test('pre-flag chain order: armed, allowlist, supervisor, token, count/cap, grace, then gates', async () => {
    await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(calls).toEqual(['allow', 'sup', 'token', 'count', 'cap', 'grace', 'gates', 'reserve', 'ledger', 'launch'])
  })

  test('armed false => refused disabled, nothing evaluated', async () => {
    const res = await governedLaunch(args({ armed: false, preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'refused', reason: 'disabled' })
    expect(calls).toEqual([])
  })

  test('allowlist miss / supervisor offline / token over / launch cap => refused, spawn-free', async () => {
    st.allowed = false
    expect(await governedLaunch(args({ preLaunch: governor() }), deps())).toEqual({ kind: 'refused', reason: 'not_allowlisted' })
    st.allowed = true
    st.supOnline = false
    expect(await governedLaunch(args({ preLaunch: governor() }), deps())).toEqual({ kind: 'refused', reason: 'supervisor_offline' })
    st.supOnline = true
    st.tokenOver = true
    expect(await governedLaunch(args({ preLaunch: governor() }), deps())).toEqual({ kind: 'refused', reason: 'over_token_cap' })
    st.tokenOver = false
    st.launchCap = true
    expect(await governedLaunch(args({ preLaunch: governor() }), deps())).toEqual({ kind: 'refused', reason: 'launch_cap' })
    expect(calls).not.toContain('launch')
    expect(calls).not.toContain('reserve')
  })

  test('preflight not ok is returned verbatim, before dedupe and launch', async () => {
    const early = { kind: 'failed', reason: 'counter_key_unresolved:x' } as const
    const res = await governedLaunch(
      args({ preLaunch: governor(), preflight: async () => ({ ok: false, result: early }) }),
      deps(),
    )
    expect(res).toEqual(early)
    expect(calls).not.toContain('grace')
    expect(calls).not.toContain('launch')
  })

  test('graceParkPending => in_flight: zero launches, zero reservations', async () => {
    st.grace = true
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'in_flight' })
    expect(calls).not.toContain('reserve')
    expect(calls).not.toContain('launch')
  })

  test('a gate refusal: refused with that reason, zero reservations, zero launches', async () => {
    st.gateReason = 'over_daily_cost_cap'
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'refused', reason: 'over_daily_cost_cap' })
    expect(calls).not.toContain('reserve')
    expect(calls).not.toContain('launch')
  })

  test('reserve not ok => refused with its reason, zero launches, no release (nothing reserved)', async () => {
    st.reserveResult = { ok: false, reason: 'lifetime_budget_exhausted' }
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'refused', reason: 'lifetime_budget_exhausted' })
    expect(calls).not.toContain('launch')
    expect(calls).not.toContain('ledger')
    expect(calls).not.toContain('release')
  })

  test('ledger throws => refused ledger_unavailable, release called, zero launches (fail closed)', async () => {
    st.ledgerThrows = true
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'refused', reason: 'ledger_unavailable' })
    expect(calls).toContain('release')
    expect(calls).not.toContain('launch')
  })

  test('launch not ok => release called, refused autospawn_launch_<reason>', async () => {
    st.launchResult = { ok: false, reason: 'at_capacity', running: 2, cap: 2 }
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'refused', reason: 'autospawn_launch_at_capacity' })
    expect(calls.filter((c) => c === 'release')).toHaveLength(1)
  })

  test('launch not ok no_online_supervisor => refused supervisor_offline, release called', async () => {
    st.launchResult = { ok: false, reason: 'no_online_supervisor' }
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'refused', reason: 'supervisor_offline' })
    expect(calls).toContain('release')
  })

  test('launch throws => release called, failed autospawn_launch_threw', async () => {
    st.launchThrows = 'kaboom'
    const res = await governedLaunch(args({ preLaunch: governor() }), deps())
    expect(res).toEqual({ kind: 'failed', reason: 'autospawn_launch_threw: kaboom' })
    expect(calls.filter((c) => c === 'release')).toHaveLength(1)
  })
})

describe('governedLaunch - legacy policy (no governor)', () => {
  test('order: allowlist, supervisor, token, cap, preflight, grace, launch, then best-effort ledger', async () => {
    let pre = 0
    const res = await governedLaunch(args({ preflight: async () => (pre++, { ok: true as const }) }), deps())
    expect(res).toEqual({ kind: 'launched', runId: 'run-1', supervisorId: 'sup-1' })
    expect(calls).toEqual(['allow', 'sup', 'token', 'count', 'cap', 'grace', 'launch', 'ledger'])
    expect(pre).toBe(1)
    expect(ledgerRows[0].decision_rationale).toBe('launched run=run-1 sup=sup-1')
    expect(ledgerRows[0].command).toBe('autospawn-launch')
    expect(ledgerRows[0].outcome).toBe('launched')
  })

  test('a throwing ledger is swallowed and does not change the launched result', async () => {
    st.ledgerThrows = true
    const res = await governedLaunch(args(), deps())
    expect(res).toEqual({ kind: 'launched', runId: 'run-1', supervisorId: 'sup-1' })
  })

  test('never invokes gates or reservation (no governor)', async () => {
    await governedLaunch(args(), deps())
    expect(calls).not.toContain('gates')
    expect(calls).not.toContain('reserve')
    expect(calls).not.toContain('release')
  })

  test('countAutospawnLaunchesToday throwing is treated as zero launches', async () => {
    const d = deps()
    d.countAutospawnLaunchesToday = async () => {
      throw new Error('read failed')
    }
    const res = await governedLaunch(args(), d)
    expect(res.kind).toBe('launched')
  })

  test('launch failure refusal strings match the legacy seam', async () => {
    st.launchResult = { ok: false, reason: 'no_project_dir' }
    expect(await governedLaunch(args(), deps())).toEqual({ kind: 'refused', reason: 'autospawn_launch_no_project_dir' })
    st.launchThrows = 'x'
    expect(await governedLaunch(args(), deps())).toEqual({ kind: 'failed', reason: 'autospawn_launch_threw: x' })
  })

  test('launchSessionForUser is always called with machine: true', async () => {
    await governedLaunch(args(), deps())
    expect(launchArgs[0].machine).toBe(true)
  })

  test('legacy policy leaves skipPermissions unset (session-derived, orchestrator unchanged)', async () => {
    await governedLaunch(args(), deps())
    expect('skipPermissions' in launchArgs[0]).toBe(false)
  })
})

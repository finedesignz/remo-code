// CORCH-02 Task 3: the full ordered eligibility table (SC3; CORCH-R2.3, CORCH-R2.4) and the CUG-only
// import guard. Fixed clock, table-driven, reason strings exact.
import { describe, test, expect } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { evaluateAccounts, type QuotaAccountRow } from '../src/corch/quota-eligibility.ts'

const NOW = new Date('2026-11-13T12:00:00Z')
const ago = (s: number) => new Date(NOW.getTime() - s * 1000)
const ahead = (s: number) => new Date(NOW.getTime() + s * 1000)

function row(over: Partial<QuotaAccountRow> = {}): QuotaAccountRow {
  return {
    account_id: 'acct_a', slot: 'acct_a', five_h_pct: 10, seven_d_pct: 20,
    resets_5h: ahead(3600), resets_7d: ahead(86400), fetched_at: ago(10), source: 'live',
    enabled: true, cug_blocked: false, received_at: ago(10), blocked_until: null, blocked_at: null,
    ...over,
  }
}
const ev = (r: QuotaAccountRow, busy = 0, ceilingPct = 55) =>
  evaluateAccounts([r], { now: NOW, ceilingPct, busyByAccount: { [r.account_id]: busy } })[0]!

type Case = [string, QuotaAccountRow, { eligible: boolean; reason: string | null; notBefore?: Date | null; busy?: number; ceiling?: number }]

const cases: Case[] = [
  ['received_at 599s old is eligible', row({ received_at: ago(599) }), { eligible: true, reason: null }],
  ['received_at exactly 600s old is eligible', row({ received_at: ago(600) }), { eligible: true, reason: null }],
  ['received_at 601s old => snapshot_stale', row({ received_at: ago(601) }), { eligible: false, reason: 'quota:snapshot_stale' }],
  ['fetched_at 899s old is eligible', row({ fetched_at: ago(899) }), { eligible: true, reason: null }],
  ['fetched_at 901s old => account_stale', row({ fetched_at: ago(901) }), { eligible: false, reason: 'quota:account_stale' }],
  ['fetched_at null => account_stale', row({ fetched_at: null }), { eligible: false, reason: 'quota:account_stale' }],
  ['fetched_at 61s in the future => account_stale', row({ fetched_at: ahead(61) }), { eligible: false, reason: 'quota:account_stale' }],
  ['fetched_at 59s in the future is tolerated', row({ fetched_at: ahead(59) }), { eligible: true, reason: null }],
  ['source scope_blind => source_not_live', row({ source: 'scope_blind' }), { eligible: false, reason: 'quota:source_not_live' }],
  ['source fetch_failed => source_not_live', row({ source: 'fetch_failed' }), { eligible: false, reason: 'quota:source_not_live' }],
  ['cug_blocked => cug_blocked', row({ cug_blocked: true }), { eligible: false, reason: 'quota:cug_blocked' }],
  ['enabled false => cug_disabled', row({ enabled: false }), { eligible: false, reason: 'quota:cug_disabled' }],
  [
    'blocked_until in the future => blocked, not_before = blocked_until',
    row({ blocked_until: ahead(1800), blocked_at: ago(60) }),
    { eligible: false, reason: 'quota:blocked', notBefore: ahead(1800) },
  ],
  ['blocked_until in the past => eligible', row({ blocked_until: ago(30), blocked_at: ago(600) }), { eligible: true, reason: null }],
  [
    'blocked_at set and blocked_until NULL => blocked, not_before NULL',
    row({ blocked_until: null, blocked_at: ago(60) }),
    { eligible: false, reason: 'quota:blocked', notBefore: null },
  ],
  ['seven_d NULL => seven_d_unknown', row({ seven_d_pct: null }), { eligible: false, reason: 'quota:seven_d_unknown' }],
  [
    '7d 55 with ceiling 55 => over_ceiling, not_before resets_7d',
    row({ five_h_pct: 5, seven_d_pct: 55, resets_7d: ahead(7200) }),
    { eligible: false, reason: 'quota:over_ceiling', notBefore: ahead(7200) },
  ],
  [
    '5h 60 and 7d 60 => over_ceiling, not_before = the later reset',
    row({ five_h_pct: 60, seven_d_pct: 60, resets_5h: ahead(3600), resets_7d: ahead(7200) }),
    { eligible: false, reason: 'quota:over_ceiling', notBefore: ahead(7200) },
  ],
  [
    '5h over only => not_before resets_5h',
    row({ five_h_pct: 70, seven_d_pct: 10, resets_5h: ahead(900), resets_7d: ahead(86400) }),
    { eligible: false, reason: 'quota:over_ceiling', notBefore: ahead(900) },
  ],
  [
    'over ceiling with a null reset => not_before NULL',
    row({ five_h_pct: 70, seven_d_pct: 10, resets_5h: null }),
    { eligible: false, reason: 'quota:over_ceiling', notBefore: null },
  ],
  [
    'over ceiling with a past reset => not_before NULL',
    row({ five_h_pct: 70, seven_d_pct: 10, resets_5h: ago(60) }),
    { eligible: false, reason: 'quota:over_ceiling', notBefore: null },
  ],
  ['5h 54.9 and 7d 54.9 => eligible', row({ five_h_pct: 54.9, seven_d_pct: 54.9 }), { eligible: true, reason: null }],
  ['custom ceiling 70: 7d 60 is eligible', row({ seven_d_pct: 60 }), { eligible: true, reason: null, ceiling: 70 }],
  ['custom ceiling 70: 7d 70 is over', row({ seven_d_pct: 70 }), { eligible: false, reason: 'quota:over_ceiling', ceiling: 70 }],
  ['5h NULL, 7d 20, busy 0 => eligible', row({ five_h_pct: null, seven_d_pct: 20 }), { eligible: true, reason: null, busy: 0 }],
  [
    '5h NULL, 7d 20, busy 1 => five_h_unknown_busy',
    row({ five_h_pct: null, seven_d_pct: 20 }),
    { eligible: false, reason: 'quota:five_h_unknown_busy', busy: 1 },
  ],
  ['5h 10, 7d 20, busy 3 => eligible (busy cap only for null 5h)', row(), { eligible: true, reason: null, busy: 3 }],
  [
    'rule order: stale AND over ceiling reports snapshot_stale',
    row({ received_at: ago(700), five_h_pct: 99, seven_d_pct: 99 }),
    { eligible: false, reason: 'quota:snapshot_stale' },
  ],
  [
    'rule order: account_stale before source_not_live',
    row({ fetched_at: null, source: 'fetch_failed' }),
    { eligible: false, reason: 'quota:account_stale' },
  ],
  [
    'rule order: cug_blocked before cug_disabled before blocked',
    row({ cug_blocked: true, enabled: false, blocked_until: ahead(60) }),
    { eligible: false, reason: 'quota:cug_blocked' },
  ],
  [
    'rule order: blocked before seven_d_unknown',
    row({ seven_d_pct: null, blocked_until: ahead(60) }),
    { eligible: false, reason: 'quota:blocked', notBefore: ahead(60) },
  ],
]

describe('CORCH-R2.3 / CORCH-R2.4 SC3: evaluateAccounts is fail-closed and table-driven', () => {
  for (const [name, r, exp] of cases) {
    test(name, () => {
      const out = ev(r, exp.busy ?? 0, exp.ceiling ?? 55)
      expect(out.account_id).toBe('acct_a')
      expect(out.eligible).toBe(exp.eligible)
      expect(out.reason).toBe(exp.reason)
      if (exp.notBefore !== undefined) {
        expect(out.not_before).toBe(exp.notBefore ? exp.notBefore.toISOString() : null)
      }
      if (exp.eligible) expect(out.not_before).toBeNull()
    })
  }

  test('CORCH-R2.4: null 5h is unknown, never 0 - and null 5h + null 7d is ineligible', () => {
    expect(ev(row({ five_h_pct: null, seven_d_pct: null })).reason).toBe('quota:seven_d_unknown')
    expect(ev(row({ five_h_pct: null, seven_d_pct: 54.9 })).eligible).toBe(true)
    expect(ev(row({ five_h_pct: null, seven_d_pct: 55 })).reason).toBe('quota:over_ceiling')
  })

  test('evaluates every row independently and preserves order; an empty list is empty', () => {
    const rows = [row({ account_id: 'a' }), row({ account_id: 'b', source: 'scope_blind' }), row({ account_id: 'c', seven_d_pct: 90 })]
    const out = evaluateAccounts(rows, { now: NOW, ceilingPct: 55 })
    expect(out.map((o) => [o.account_id, o.reason])).toEqual([
      ['a', null], ['b', 'quota:source_not_live'], ['c', 'quota:over_ceiling'],
    ])
    expect(evaluateAccounts([], { now: NOW, ceilingPct: 55 })).toEqual([])
  })

  test('does not mutate its input and is pure (same input, same output)', () => {
    const r = row()
    const snap = JSON.stringify(r)
    const a = ev(r)
    expect(JSON.stringify(r)).toBe(snap)
    expect(ev(r)).toEqual(a)
  })
})

// CORCH-R2.3: CUG only. Nothing in hub/src/corch or hub/src/api/quota.ts may import the oauth-poll
// usage store (hub/src/usage/**) or the threshold gate. Import statements only, so comments cannot trip it.
describe('CORCH-R2.3 CUG-only import guard', () => {
  const SRC = join(import.meta.dir, '..', 'src')
  const files = [
    ...readdirSync(join(SRC, 'corch')).filter((f) => f.endsWith('.ts')).map((f) => join(SRC, 'corch', f)),
    join(SRC, 'api', 'quota.ts'),
  ]
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[ \t])\/\/.*$/gm, '$1')
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g
  const bindingRe = /import\s+(?:type\s+)?\{([^}]*)\}\s*from/g

  test('the guard sees the corch files and the quota route', () => {
    expect(files.length).toBeGreaterThan(6)
    expect(files.some((f) => f.endsWith('quota.ts'))).toBe(true)
  })

  test('no import specifier resolves into hub/src/usage/', () => {
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const m of src.matchAll(importRe)) {
        const spec = (m[1] ?? m[2])!
        if (!spec.startsWith('.')) continue
        const target = resolve(dirname(f), spec).replace(/\\/g, '/')
        expect(target.includes('/hub/src/usage/') || target.endsWith('/hub/src/usage'), `${f} imports ${spec}`).toBe(false)
      }
    }
  })

  test('no import binds the threshold-gate export', () => {
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'))
      for (const m of src.matchAll(bindingRe)) {
        expect(/\bthresholdGate\b/.test(m[1]!), `${f} binds thresholdGate`).toBe(false)
      }
    }
  })
})

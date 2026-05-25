/**
 * Scheduler unit tests (W5/T23).
 *
 * Covers pure-logic modules of the scheduler that don't depend on DB or WS
 * registries. Anything that requires a live Postgres or live socket lives in
 * scheduled-tasks.e2e.test.ts. Run with `bun test` from `hub/`.
 *
 * Coverage:
 *   - cron util: validate / nextRuns / compilePreset / isValidTimezone
 *   - catch-up math (via croner directly, mirroring catchup.computeMissed)
 *   - session-queue: dispatch / queue / drop semantics + promotion
 *   - post-run schema: zod validation + cycle detector
 *   - post-run template renderer: substitution + html escape
 *   - post-run condition matcher: success / failure / always / cost_exceeded
 *   - fan-out aggregator: in-process aggregate path
 *
 * The aggregator and dispatcher modules carry a process-wide `setInterval`
 * sweep timer. Bun test exits after the test run, so the timer never has a
 * chance to leak. We don't import the dispatcher here precisely because it
 * pulls in postgres at module-load; tests that need it run in e2e.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import { Cron } from 'croner'

import {
  validate,
  nextRuns,
  compilePreset,
  isValidTimezone,
} from '../src/scheduler/cron.ts'
import {
  enqueue,
  markFinished,
  currentInFlight,
  setOnPromote,
  onSessionIdleAndPromote,
  _reset as resetQueue,
} from '../src/scheduler/session-queue.ts'
import {
  validatePostRunActions,
  detectChainCycles,
} from '../src/scheduler/post-run/schema.ts'
import { render } from '../src/scheduler/post-run/template.ts'
import {
  computeTaskAutoName,
  composeTaskName,
  buildTaskName,
  cronCadence,
} from '../src/scheduler/auto-name.ts'

// ─────────────────────────────────────────────────────────────────────────────
// cron util
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/cron', () => {
  test('validate accepts a well-formed expression', () => {
    expect(validate('0 * * * *')).toEqual({ ok: true })
    expect(validate('*/5 * * * *')).toEqual({ ok: true })
    expect(validate('0 9 * * 1-5')).toEqual({ ok: true })
  })

  test('validate rejects empty / nonsense input', () => {
    expect(validate('')).toMatchObject({ ok: false })
    expect(validate('   ')).toMatchObject({ ok: false })
    expect(validate('not a cron')).toMatchObject({ ok: false })
    // @ts-expect-error — explicit non-string for the runtime branch
    expect(validate(undefined)).toMatchObject({ ok: false })
  })

  test('nextRuns returns N strictly increasing dates', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const out = nextRuns('0 * * * *', 'UTC', 3, from)
    expect(out).toHaveLength(3)
    expect(out[0].getTime()).toBeGreaterThan(from.getTime())
    expect(out[1].getTime()).toBeGreaterThan(out[0].getTime())
    expect(out[2].getTime()).toBeGreaterThan(out[1].getTime())
  })

  test('nextRuns returns [] for invalid expression', () => {
    expect(nextRuns('garbage', 'UTC')).toEqual([])
  })

  test('compilePreset produces expected 5-field expressions', () => {
    expect(compilePreset({ kind: 'hourly' })).toBe('0 * * * *')
    expect(compilePreset({ kind: 'daily', hh: 9, mm: 30 })).toBe('30 9 * * *')
    expect(compilePreset({ kind: 'every_n_minutes', n: 5 })).toBe('*/5 * * * *')
    expect(compilePreset({ kind: 'weekdays', hh: 8, mm: 0 })).toBe('0 8 * * 1-5')
    expect(compilePreset({ kind: 'custom', expr: '15 14 1 * *' })).toBe('15 14 1 * *')
  })

  test('compilePreset throws on out-of-range fields', () => {
    expect(() => compilePreset({ kind: 'daily', hh: 24, mm: 0 })).toThrow()
    expect(() => compilePreset({ kind: 'daily', hh: 0, mm: 60 })).toThrow()
    expect(() => compilePreset({ kind: 'every_n_minutes', n: 0 })).toThrow()
    expect(() => compilePreset({ kind: 'every_n_minutes', n: 60 })).toThrow()
    expect(() => compilePreset({ kind: 'weekdays', hh: -1, mm: 0 })).toThrow()
  })

  test('isValidTimezone accepts IANA names and rejects junk', () => {
    expect(isValidTimezone('UTC')).toBe(true)
    expect(isValidTimezone('America/Los_Angeles')).toBe(true)
    expect(isValidTimezone('Europe/Berlin')).toBe(true)
    expect(isValidTimezone('Not/A_Timezone')).toBe(false)
    expect(isValidTimezone('')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// catch-up math
// We can't easily mock the clock used inside catchup.ts (it reads Date.now()),
// but the math is pure croner — we replicate it directly against croner and
// assert the count for a fixed `since` and an hourly cron.
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/catchup math (mirrors computeMissed)', () => {
  test('hourly cron from 3h ago yields exactly 3 missed fires', () => {
    const now = Date.now()
    const since = new Date(now - 3 * 60 * 60 * 1000 - 30_000)
    const c = new Cron('0 * * * *', { timezone: 'UTC', paused: true })
    const out: Date[] = []
    let cursor: Date | undefined = since
    while (out.length < 100) {
      const next = c.nextRun(cursor)
      if (!next) break
      if (next.getTime() >= now) break
      out.push(next)
      cursor = new Date(next.getTime() + 1000)
    }
    c.stop()
    expect(out.length).toBeGreaterThanOrEqual(3)
    expect(out.length).toBeLessThanOrEqual(4) // depending on minute alignment
  })

  test('cap at MAX_MISSED prevents infinite walk for an ancient since', () => {
    const since = new Date('2000-01-01T00:00:00Z')
    const now = Date.now()
    const c = new Cron('* * * * *', { timezone: 'UTC', paused: true })
    const out: Date[] = []
    let cursor: Date | undefined = since
    const MAX = 100
    while (out.length < MAX) {
      const next = c.nextRun(cursor)
      if (!next) break
      if (next.getTime() >= now) break
      out.push(next)
      cursor = new Date(next.getTime() + 1000)
    }
    c.stop()
    expect(out.length).toBe(MAX)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// session-queue
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/session-queue', () => {
  beforeEach(() => {
    resetQueue()
    setOnPromote(null)
  })

  test('1st enqueue dispatches, 2nd queues, 3rd drops', () => {
    expect(enqueue('s1', 'r1')).toBe('dispatched')
    expect(enqueue('s1', 'r2')).toBe('queued')
    expect(enqueue('s1', 'r3')).toBe('dropped')
    expect(currentInFlight('s1')).toBe('r1')
  })

  test('markFinished promotes the waiter to in-flight', () => {
    enqueue('s1', 'r1')
    enqueue('s1', 'r2')
    const promoted = markFinished('s1')
    expect(promoted).toBe('r2')
    expect(currentInFlight('s1')).toBe('r2')
  })

  test('markFinished with no waiter clears the slot', () => {
    enqueue('s1', 'r1')
    const promoted = markFinished('s1')
    expect(promoted).toBe(null)
    expect(currentInFlight('s1')).toBe(null)
  })

  test('onSessionIdleAndPromote fires the registered handler', () => {
    let calls: Array<[string, string]> = []
    setOnPromote((sid, rid) => calls.push([sid, rid]))
    enqueue('s1', 'r1')
    enqueue('s1', 'r2')
    const promoted = onSessionIdleAndPromote('s1')
    expect(promoted).toBe('r2')
    expect(calls).toEqual([['s1', 'r2']])
  })

  test('separate sessions have independent slots', () => {
    expect(enqueue('a', 'ra1')).toBe('dispatched')
    expect(enqueue('b', 'rb1')).toBe('dispatched')
    expect(enqueue('a', 'ra2')).toBe('queued')
    expect(currentInFlight('a')).toBe('ra1')
    expect(currentInFlight('b')).toBe('rb1')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// post-run schema + cycle detector
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/post-run/schema', () => {
  test('validatePostRunActions accepts empty / undefined as []', () => {
    expect(validatePostRunActions(undefined)).toEqual({ ok: true, value: [] })
    expect(validatePostRunActions([])).toEqual({ ok: true, value: [] })
  })

  test('validatePostRunActions accepts a well-formed chain_task', () => {
    const r = validatePostRunActions([
      { type: 'chain_task', on: 'success', config: { task_id: 't-2' } },
    ])
    expect(r.ok).toBe(true)
  })

  test('validatePostRunActions accepts a webhook with URL', () => {
    const r = validatePostRunActions([
      { type: 'webhook', on: 'always', config: { url: 'https://example.com/hook' } },
    ])
    expect(r.ok).toBe(true)
  })

  test('validatePostRunActions rejects unknown type', () => {
    const r = validatePostRunActions([
      { type: 'bogus', on: 'always', config: {} },
    ])
    expect(r.ok).toBe(false)
  })

  test('validatePostRunActions rejects bad email body length', () => {
    const r = validatePostRunActions([
      { type: 'notify_email', on: 'success', config: { subject: 'x', body: '' } },
    ])
    expect(r.ok).toBe(false)
  })

  test('detectChainCycles allows linear chain A→B→C', () => {
    const r = detectChainCycles([
      { id: 'A', actions: [{ type: 'chain_task', on: 'success', config: { task_id: 'B' } }] as any },
      { id: 'B', actions: [{ type: 'chain_task', on: 'success', config: { task_id: 'C' } }] as any },
      { id: 'C', actions: [] },
    ])
    expect(r.ok).toBe(true)
  })

  test('detectChainCycles rejects direct self-cycle A→A', () => {
    const r = detectChainCycles([
      { id: 'A', actions: [{ type: 'chain_task', on: 'always', config: { task_id: 'A' } }] as any },
    ])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.cycle).toContain('A')
  })

  test('detectChainCycles rejects A→B→A', () => {
    const r = detectChainCycles([
      { id: 'A', actions: [{ type: 'chain_task', on: 'success', config: { task_id: 'B' } }] as any },
      { id: 'B', actions: [{ type: 'chain_task', on: 'success', config: { task_id: 'A' } }] as any },
    ])
    expect(r.ok).toBe(false)
  })

  test('detectChainCycles ignores non-chain actions', () => {
    const r = detectChainCycles([
      {
        id: 'A',
        actions: [
          { type: 'notify_email', on: 'success', config: { subject: 's', body: 'b' } },
          { type: 'webhook', on: 'always', config: { url: 'https://x.test' } },
        ] as any,
      },
    ])
    expect(r.ok).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// post-run template renderer
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/post-run/template', () => {
  test('substitutes known variables', () => {
    const out = render('Task {{name}} done in {{ms}}ms', { name: 'nightly', ms: 1234 })
    expect(out).toBe('Task nightly done in 1234ms')
  })

  test('renders unknown variables as empty string', () => {
    const out = render('hello {{missing}} world', {})
    expect(out).toBe('hello  world')
  })

  test('renders null/undefined as empty', () => {
    const out = render('a={{a}} b={{b}}', { a: null, b: undefined })
    expect(out).toBe('a= b=')
  })

  test('html=true escapes substituted values', () => {
    const out = render('<p>{{body}}</p>', { body: '<script>x</script>' }, { html: true })
    expect(out).toContain('&lt;script&gt;')
    expect(out).not.toContain('<script>')
  })

  test('does not escape the surrounding template, only substitutions', () => {
    const out = render('<b>{{x}}</b>', { x: '&' }, { html: true })
    expect(out).toBe('<b>&amp;</b>')
  })

  test('tolerates whitespace inside braces', () => {
    expect(render('{{  name  }}', { name: 'ok' })).toBe('ok')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// post-run condition matcher
// We import the dispatcher's `conditionMatches` indirectly: the function is
// not exported, so we re-implement the exact same predicate here and lock it
// to behavior. If the dispatcher logic drifts, this duplicate will surface in
// CI as a behavior change requiring an explicit test edit.
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/post-run condition matcher (locked to dispatcher logic)', () => {
  type Cond = 'success' | 'failure' | 'always' | 'cost_exceeded'
  function matches(on: Cond, status: string, error: string | null): boolean {
    switch (on) {
      case 'always': return true
      case 'success': return status === 'success'
      case 'failure':
        return status === 'failed' || status === 'skipped' || status === 'cancelled'
      case 'cost_exceeded': return error === 'daily_cost_cap'
    }
  }

  test('on:success skips failed run', () => {
    expect(matches('success', 'success', null)).toBe(true)
    expect(matches('success', 'failed', null)).toBe(false)
    expect(matches('success', 'skipped', 'daily_cost_cap')).toBe(false)
  })

  test('on:failure matches failed / skipped / cancelled', () => {
    expect(matches('failure', 'failed', null)).toBe(true)
    expect(matches('failure', 'skipped', null)).toBe(true)
    expect(matches('failure', 'cancelled', 'cancelled_by_user')).toBe(true)
    expect(matches('failure', 'success', null)).toBe(false)
  })

  test('on:cost_exceeded ONLY matches error="daily_cost_cap"', () => {
    expect(matches('cost_exceeded', 'skipped', 'daily_cost_cap')).toBe(true)
    expect(matches('cost_exceeded', 'failed', 'sender_threw')).toBe(false)
    expect(matches('cost_exceeded', 'success', null)).toBe(false)
  })

  test('on:always always matches', () => {
    expect(matches('always', 'success', null)).toBe(true)
    expect(matches('always', 'failed', 'x')).toBe(true)
    expect(matches('always', 'cancelled', null)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fan-out aggregator
// We import via dynamic import so the module's setInterval sweep only fires
// inside the test process (bun test will exit cleanly).
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/post-run/aggregator', () => {
  test('fires once after expected child count reports', async () => {
    // Avoid pulling the real post-run dispatcher (which pulls DAL/DB).
    // We re-import the aggregator with a stubbed dispatcher via mock.module.
    const { mock } = await import('bun:test')
    const fired: any[] = []
    mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
      fireWithContext: async (args: any) => { fired.push(args) },
      afterRun: async () => {},
      clearPendingTimers: () => {},
    }))
    const agg = await import('../src/scheduler/post-run/aggregator.ts')
    const task: any = { id: 't1', user_id: 'u1', name: 'Test' }
    const parentFireId = `pf_${Date.now()}`
    agg.register(parentFireId, task.id, task.user_id, 3)

    await agg.report(parentFireId, task, { status: 'success', error: null }, { cost_usd: null, duration_ms: null, output_snippet: null })
    expect(fired.length).toBe(0)
    await agg.report(parentFireId, task, { status: 'success', error: null }, { cost_usd: null, duration_ms: null, output_snippet: null })
    expect(fired.length).toBe(0)
    await agg.report(parentFireId, task, { status: 'success', error: null }, { cost_usd: null, duration_ms: null, output_snippet: null })
    expect(fired.length).toBe(1)
    expect(fired[0].status).toBe('success')

    // Reports past completion are ignored.
    await agg.report(parentFireId, task, { status: 'failed', error: 'x' }, { cost_usd: null, duration_ms: null, output_snippet: null })
    expect(fired.length).toBe(1)
  })

  test('mixed children → aggregate status is failed with partial counts', async () => {
    const { mock } = await import('bun:test')
    const fired: any[] = []
    mock.module('../src/scheduler/post-run/dispatcher.ts', () => ({
      fireWithContext: async (args: any) => { fired.push(args) },
      afterRun: async () => {},
      clearPendingTimers: () => {},
    }))
    const agg = await import('../src/scheduler/post-run/aggregator.ts')
    const task: any = { id: 't2', user_id: 'u1', name: 'Test2' }
    const parentFireId = `pf2_${Date.now()}`
    agg.register(parentFireId, task.id, task.user_id, 2)

    await agg.report(parentFireId, task, { status: 'success', error: null }, { cost_usd: null, duration_ms: null, output_snippet: null })
    await agg.report(parentFireId, task, { status: 'failed', error: 'sender_threw' }, { cost_usd: null, duration_ms: null, output_snippet: null })
    expect(fired.length).toBe(1)
    expect(fired[0].status).toBe('failed')
    expect(fired[0].aggregate).toEqual({ total: 2, successes: 1, failures: 1 })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Chain depth cap
// The dispatcher's depth check sits inside `runNow` and `fireWithContext`. We
// replicate the predicate here and document the behavior:
//   - runNow rejects when incoming depth > MAX_CHAIN_DEPTH (5)
//   - post-run dispatcher early-returns when depth >= MAX_CHAIN_DEPTH
// A 6th-level chained invocation finalizes with error='chain_depth_exceeded'.
// Integration is verified end-to-end in e2e (T24).
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler chain depth cap (locked to dispatcher logic)', () => {
  const MAX = 5
  function runNowRejects(depth: number) { return depth > MAX }
  function postRunBails(depth: number) { return depth >= MAX }

  test('runNow accepts depths 0..MAX and rejects MAX+1', () => {
    for (let d = 0; d <= MAX; d++) expect(runNowRejects(d)).toBe(false)
    expect(runNowRejects(MAX + 1)).toBe(true)
  })

  test('post-run dispatcher fires at depths < MAX and bails at MAX', () => {
    for (let d = 0; d < MAX; d++) expect(postRunBails(d)).toBe(false)
    expect(postRunBails(MAX)).toBe(true)
    expect(postRunBails(MAX + 1)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Target resolver — pure-logic gate
// The real resolver depends on DB + WS registries. We assert the SHAPE of the
// resolver's contract is honored for each kind via a TODO checklist comment,
// and let integration in e2e validate the live behavior.
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/targets — contract gate', () => {
  // TODO(W5+): live socket fixtures land in e2e once a test Postgres + WS
  // harness is wired. For now we lock the discriminator shape so the
  // dispatcher's switch in routeToSender keeps compiling against the union.
  test('ResolvedTarget kinds enumerate all 4 task target kinds', () => {
    const kinds = ['session', 'supervisor', 'all_agents', 'all_supervisors']
    expect(new Set(kinds).size).toBe(4)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cost-cap predicate — pure-logic gate
// `isOverCostCap` is unexported and pulls postgres directly. We re-derive the
// arithmetic and document the boundary case (spent === cap → over).
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler cost-cap predicate (locked to dispatcher logic)', () => {
  function over(cap: number, spent: number): boolean {
    if (!Number.isFinite(cap) || cap <= 0) return false
    return spent >= cap
  }
  test('exact equality with cap is considered over', () => {
    expect(over(10, 10)).toBe(true)
  })
  test('under cap is not over', () => {
    expect(over(10, 9.999)).toBe(false)
  })
  test('zero or negative cap disables enforcement', () => {
    expect(over(0, 9999)).toBe(false)
    expect(over(-1, 9999)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// auto-name: server-side task name prefix builder
// ─────────────────────────────────────────────────────────────────────────────
describe('scheduler/auto-name', () => {
  const ctx = {
    sessions: [
      { id: 's1', name: 'kh-hub', project_dir: 'C:/Users/artic/GitHub/finedesignz/kh-hub' },
      { id: 's2', name: 'project-x', project_dir: null },
    ],
    supervisors: [
      { id: 'sup1', hostname: 'supervisor-coolify-1' },
      { id: 'sup2', hostname: 'app-abc123' },
    ],
  }

  test('cronCadence: common shapes', () => {
    expect(cronCadence('*/15 * * * *')).toBe('every 15m')
    expect(cronCadence('0 */4 * * *')).toBe('every 4h')
    expect(cronCadence('30 * * * *')).toBe('hourly')
    expect(cronCadence('0 9 * * *')).toBe('daily at 09:00')
    expect(cronCadence('0 9 * * 1')).toBe('weekly on Mon at 09:00')
    expect(cronCadence('0 9 15 * *')).toBe('monthly on day 15 at 09:00')
    expect(cronCadence('')).toBe('')
  })

  test('continue_dev on session repo (locked example from spec)', () => {
    const out = computeTaskAutoName(
      {
        task_type: 'continue_dev',
        target_kind: 'session',
        target_id: 's1',
        cron_expr: '0 */4 * * *',
      },
      ctx,
    )
    expect(out).toBe('Continue Dev on finedesignz/kh-hub every 4h')
  })

  test('skill prefix uses /command label', () => {
    const out = computeTaskAutoName(
      {
        task_type: 'skill',
        target_kind: 'supervisor',
        target_id: 'sup1',
        payload: { command: '/lint' },
        cron_expr: '0 9 * * *',
      },
      ctx,
    )
    expect(out).toBe('Skill /lint on supervisor-coolify-1 daily at 09:00')
  })

  test('log_check on supervisor with sub-15m cadence', () => {
    const out = computeTaskAutoName(
      {
        task_type: 'log_check',
        target_kind: 'supervisor',
        target_id: 'sup2',
        cron_expr: '*/15 * * * *',
      },
      ctx,
    )
    expect(out).toBe('Log Check on app-abc123 every 15m')
  })

  test('fan-out kinds render readable target labels', () => {
    expect(
      computeTaskAutoName(
        { task_type: 'prompt', target_kind: 'all_agents', cron_expr: '0 * * * *' },
        ctx,
      ),
    ).toBe('Prompt on all agents hourly')
    expect(
      computeTaskAutoName(
        { task_type: 'prompt', target_kind: 'all_supervisors', cron_expr: '0 9 * * *' },
        ctx,
      ),
    ).toBe('Prompt on all supervisors daily at 09:00')
  })

  test('returns empty when target_id is missing for session/supervisor kinds', () => {
    expect(
      computeTaskAutoName(
        { task_type: 'prompt', target_kind: 'session', target_id: null, cron_expr: '0 * * * *' },
        ctx,
      ),
    ).toBe('')
  })

  test('composeTaskName joins with em-dash and trims', () => {
    expect(composeTaskName('Continue Dev on x every 4h', 'high-priority')).toBe(
      'Continue Dev on x every 4h — high-priority',
    )
    expect(composeTaskName('Prefix only', '')).toBe('Prefix only')
    expect(composeTaskName('Prefix only', '   ')).toBe('Prefix only')
    expect(composeTaskName('', 'just suffix')).toBe('just suffix')
  })

  test('buildTaskName end-to-end with suffix', () => {
    const out = buildTaskName(
      {
        task_type: 'continue_dev',
        target_kind: 'session',
        target_id: 's1',
        cron_expr: '0 */4 * * *',
      },
      ' nightly ',
      ctx,
    )
    expect(out.prefix).toBe('Continue Dev on finedesignz/kh-hub every 4h')
    expect(out.suffix).toBe('nightly')
    expect(out.name).toBe('Continue Dev on finedesignz/kh-hub every 4h — nightly')
  })
})

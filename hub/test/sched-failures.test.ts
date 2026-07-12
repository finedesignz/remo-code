// fix/sched-failures — regression tests for the three live prod scheduler bugs:
//   1. `security` root with no custom prompt → empty_content (failed daily, 8ms).
//   2. triage timeout hardcoded at 5min → healthy ~5.5min Coolify triage runs
//      falsely finalized failed/triage_timeout.
//   3. offline-session grace replay minted a SECOND run row via runNow and left
//      the original `pending` forever (→ reaped as run_timeout at 6h).
import { describe, it, expect, afterEach } from 'bun:test'
import { buildContent } from '../src/scheduler/senders/agent'
import { triageTimeoutMs } from '../src/scheduler/senders/triage'
import type { ScheduledTask } from '../src/db/scheduled-tasks-dal'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

function task(overrides: Partial<ScheduledTask>): ScheduledTask {
  return {
    id: 't1',
    user_id: 'u1',
    session_id: 's1',
    name: 'test',
    cron_expression: '0 * * * *',
    prompt: '',
    enabled: true,
    last_run_at: null,
    next_run_at: null,
    on_complete: { type: 'none' },
    created_at: '',
    updated_at: '',
    task_type: 'security',
    target_kind: 'session',
    target_id: null,
    payload: {},
    cron_expr: '0 * * * *',
    timezone: 'UTC',
    catchup_policy: 'skip',
    max_concurrent: 1,
    last_fire_at: null,
    next_fire_at: null,
    post_run_actions: [],
    ...overrides,
  } as ScheduledTask
}

describe('BUG 1 — buildContent(security) never returns empty', () => {
  it('renders the security scan template for a bare `security` root', () => {
    const out = buildContent(task({ task_type: 'security', prompt: '', payload: {} }))
    expect(out.length).toBeGreaterThan(0)
    expect(out).toContain('## ROLE')
    expect(out).toContain('Security Scanner')
  })

  it('a custom payload.prompt still wins', () => {
    const out = buildContent(task({ task_type: 'security', payload: { prompt: 'scan exactly this' } }))
    expect(out).toBe('scan exactly this')
  })

  it('a custom task.prompt still wins', () => {
    const out = buildContent(task({ task_type: 'security', prompt: 'custom security prompt' }))
    expect(out).toBe('custom security prompt')
  })

  it('the chained security_scan step keeps the /security-review shortcut', () => {
    expect(buildContent(task({ task_type: 'security_scan', prompt: '' }))).toBe('/security-review')
  })
})

describe('BUG 2 — REMO_TRIAGE_TIMEOUT_MS', () => {
  const prev = process.env.REMO_TRIAGE_TIMEOUT_MS
  afterEach(() => {
    if (prev == null) delete process.env.REMO_TRIAGE_TIMEOUT_MS
    else process.env.REMO_TRIAGE_TIMEOUT_MS = prev
  })

  it('defaults to 15 minutes (raised from the hardcoded 5min)', () => {
    delete process.env.REMO_TRIAGE_TIMEOUT_MS
    expect(triageTimeoutMs()).toBe(900_000)
  })

  it('honors a valid override', () => {
    process.env.REMO_TRIAGE_TIMEOUT_MS = '120000'
    expect(triageTimeoutMs()).toBe(120_000)
  })

  it('falls back to the default on empty / non-positive / non-finite values', () => {
    for (const bad of ['', '0', '-1', 'abc', 'NaN', 'Infinity']) {
      process.env.REMO_TRIAGE_TIMEOUT_MS = bad
      expect(triageTimeoutMs()).toBe(900_000)
    }
  })
})

describe('BUG 3 — offline grace replay must not mint a second run row', () => {
  it('the agent sender replay re-sends the SAME run (no runNow fresh-fire)', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'src', 'scheduler', 'senders', 'agent.ts'),
      'utf8',
    )
    const replay = src.slice(src.indexOf('replay: async ()'))
    const body = replay.slice(0, replay.indexOf('},'))
    // The old body imported dispatcher.runNow, which inserted a NEW
    // scheduled_task_runs row and orphaned the parked one as `pending`.
    expect(body).not.toContain('runNow')
    expect(body).toContain('sendAgentTask(task, ctx)')
  })
})

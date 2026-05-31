import { describe, it, expect } from 'bun:test'
import { buildContent } from '../src/scheduler/senders/agent'
import type { ScheduledTask } from '../src/db/scheduled-tasks-dal'

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
    task_type: 'dev',
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

describe('buildContent — dev controller (auto-dev P2)', () => {
  it('renders the controller template for a bare dev root (no custom prompt)', () => {
    const out = buildContent(task({ task_type: 'dev', prompt: '', payload: {} }))
    expect(out).toContain('## ROLE')
    expect(out).toContain('<<DECISION')
    expect(out).toContain('You are the **Controller**')
    expect(out).not.toBe('Continue where you left off.')
  })

  it('renders the controller template for an explicit dev_controller step', () => {
    const out = buildContent(task({ task_type: 'dev_controller', prompt: '', payload: {} }))
    expect(out).toContain('## ROLE')
    expect(out).toContain('<<DECISION')
  })

  it('does NOT render the controller when a custom payload.prompt is set (#214)', () => {
    const out = buildContent(
      task({ task_type: 'dev', payload: { prompt: 'do exactly this' } }),
    )
    expect(out).toBe('do exactly this')
    expect(out).not.toContain('<<DECISION')
  })

  it('does NOT render the controller when task.prompt is set', () => {
    const out = buildContent(task({ task_type: 'dev', prompt: 'custom dev prompt' }))
    expect(out).toBe('custom dev prompt')
  })

  it('does NOT render the controller for chained dev_plan/execute/ship steps', () => {
    for (const tt of ['dev_plan', 'dev_execute', 'dev_ship'] as const) {
      const out = buildContent(task({ task_type: tt, prompt: 'step prompt' }))
      expect(out).toBe('step prompt')
      expect(out).not.toContain('<<DECISION')
    }
  })

  it('keeps the security_scan slash-command shortcut', () => {
    expect(buildContent(task({ task_type: 'security_scan' }))).toBe('/security-review')
  })
})

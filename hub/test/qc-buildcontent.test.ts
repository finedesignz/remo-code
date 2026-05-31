import { describe, it, expect } from 'bun:test'
import { buildContent } from '../src/scheduler/senders/agent'
import type { ScheduledTask } from '../src/db/scheduled-tasks-dal'
import {
  WORKFLOWS,
  nextStepInWorkflow,
  stepsForWorkflow,
  workflowRootForStep,
} from '../src/scheduler/workflows'

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
    task_type: 'qc',
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

describe('buildContent — qc review (auto-dev P4)', () => {
  it('renders the review template for a bare qc root (no custom prompt)', () => {
    const out = buildContent(task({ task_type: 'qc', prompt: '', payload: {} }))
    expect(out).toContain('## ROLE')
    expect(out).toContain('<<FINDINGS')
    expect(out).toContain('You are the **QC Reviewer**')
  })

  it('renders the review template for an explicit qc_review step', () => {
    const out = buildContent(task({ task_type: 'qc_review', prompt: '', payload: {} }))
    expect(out).toContain('<<FINDINGS')
  })

  it('does NOT render the review template when a custom payload.prompt is set', () => {
    const out = buildContent(task({ task_type: 'qc', payload: { prompt: 'review exactly this' } }))
    expect(out).toBe('review exactly this')
    expect(out).not.toContain('<<FINDINGS')
  })

  it('does NOT render the review template when task.prompt is set', () => {
    const out = buildContent(task({ task_type: 'qc', prompt: 'custom qc prompt' }))
    expect(out).toBe('custom qc prompt')
  })

  it('does NOT render the review template for chained qc_fix/qc_verify steps', () => {
    for (const tt of ['qc_fix', 'qc_verify'] as const) {
      const out = buildContent(task({ task_type: tt, prompt: 'step prompt' }))
      expect(out).toBe('step prompt')
      expect(out).not.toContain('<<FINDINGS')
    }
  })
})

describe('WORKFLOWS.qc + loop-safety (auto-dev P4)', () => {
  it('declares review → fix → verify', () => {
    expect(WORKFLOWS.qc).toEqual(['qc_review', 'qc_fix', 'qc_verify'])
    expect(stepsForWorkflow('qc')).toEqual(['qc_review', 'qc_fix', 'qc_verify'])
  })

  it('advances review → fix → verify', () => {
    expect(nextStepInWorkflow('qc_review')).toBe('qc_fix')
    expect(nextStepInWorkflow('qc_fix')).toBe('qc_verify')
  })

  it('qc_verify is terminal — NEVER chains back to qc_review (loop-safety)', () => {
    expect(nextStepInWorkflow('qc_verify')).toBeNull()
  })

  it('maps qc steps back to the qc root', () => {
    expect(workflowRootForStep('qc_review')).toBe('qc')
    expect(workflowRootForStep('qc_fix')).toBe('qc')
    expect(workflowRootForStep('qc_verify')).toBe('qc')
    expect(workflowRootForStep('qc')).toBeNull()
  })
})

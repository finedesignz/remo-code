import { describe, it, expect } from 'bun:test'
import {
  WORKFLOWS,
  nextStepInWorkflow,
  stepsForWorkflow,
  workflowRootForStep,
} from '../src/scheduler/workflows'

describe('WORKFLOWS table', () => {
  it('declares the expected steps per workflow', () => {
    // auto-dev P2: dev gains a leading `dev_controller` state-gate step.
    expect(WORKFLOWS.dev.length).toBe(4)
    expect(WORKFLOWS.dev[0]).toBe('dev_controller')
    expect(WORKFLOWS.security.length).toBe(3)
    expect(WORKFLOWS.log_check.length).toBe(3)
  })
})

describe('nextStepInWorkflow', () => {
  it('advances within dev', () => {
    expect(nextStepInWorkflow('dev_controller')).toBe('dev_plan')
    expect(nextStepInWorkflow('dev_plan')).toBe('dev_execute')
    expect(nextStepInWorkflow('dev_execute')).toBe('dev_ship')
  })

  it('returns null at terminal step', () => {
    expect(nextStepInWorkflow('dev_ship')).toBeNull()
    expect(nextStepInWorkflow('security_fix_or_issue')).toBeNull()
    expect(nextStepInWorkflow('log_triage')).toBeNull()
  })

  it('returns null for workflow roots', () => {
    expect(nextStepInWorkflow('dev')).toBeNull()
    expect(nextStepInWorkflow('security')).toBeNull()
    expect(nextStepInWorkflow('log_check')).toBeNull()
  })

  it('returns null for unknown / internal kinds', () => {
    expect(nextStepInWorkflow('triage')).toBeNull()
  })
})

describe('stepsForWorkflow', () => {
  it('returns ordered step list for roots', () => {
    expect(stepsForWorkflow('dev')).toEqual([
      'dev_controller',
      'dev_plan',
      'dev_execute',
      'dev_ship',
    ])
  })

  it('returns null for non-roots', () => {
    expect(stepsForWorkflow('dev_plan')).toBeNull()
    expect(stepsForWorkflow('triage')).toBeNull()
  })
})

describe('workflowRootForStep', () => {
  it('maps step → root', () => {
    expect(workflowRootForStep('dev_execute')).toBe('dev')
    expect(workflowRootForStep('security_triage')).toBe('security')
    expect(workflowRootForStep('log_classify')).toBe('log_check')
  })

  it('returns null for roots + unknowns', () => {
    expect(workflowRootForStep('dev')).toBeNull()
    expect(workflowRootForStep('triage')).toBeNull()
  })
})

import { describe, it, expect } from 'bun:test'
import {
  parseControllerDecision,
  nextStepForAction,
} from '../src/scheduler/controller-schema'

describe('parseControllerDecision', () => {
  it('parses each action', () => {
    for (const action of ['bootstrap', 'continue', 'ship', 'plan', 'propose'] as const) {
      const raw = `<<DECISION\naction: ${action}\nreason: because\nnext_goal: do the thing\nDECISION`
      const r = parseControllerDecision(raw)
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.value.action).toBe(action)
        expect(r.value.reason).toBe('because')
        expect(r.value.next_goal).toBe('do the thing')
      }
    }
  })

  it('captures roadmap on propose', () => {
    const raw =
      '<<DECISION\naction: propose\nreason: no goal\nnext_goal: ask user\nroadmap: a | b | c\nDECISION'
    const r = parseControllerDecision(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.roadmap).toBe('a | b | c')
  })

  it('roadmap is null when absent or empty', () => {
    const raw = '<<DECISION\naction: continue\nreason: r\nnext_goal: g\nDECISION'
    const r = parseControllerDecision(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.roadmap).toBeNull()
  })

  it('tolerates surrounding prose', () => {
    const raw =
      'I scanned the repo and here is my read.\n\n' +
      'Some analysis...\n' +
      '<<DECISION\naction: ship\nreason: plan complete\nnext_goal: open PR\nDECISION\n\n' +
      'Summary: Controller: ship — plan complete'
    const r = parseControllerDecision(raw)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.action).toBe('ship')
  })

  it('missing block → safe continue fallback', () => {
    const r = parseControllerDecision('no decision here, just prose')
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toBe('no_decision_block')
      expect(r.fallback.action).toBe('continue')
    }
  })

  it('malformed action → fallback continue', () => {
    const raw = '<<DECISION\naction: explode\nreason: r\nnext_goal: g\nDECISION'
    const r = parseControllerDecision(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.reason).toContain('invalid_action')
      expect(r.fallback.action).toBe('continue')
    }
  })

  it('empty input → fallback continue', () => {
    const r = parseControllerDecision('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.fallback.action).toBe('continue')
  })
})

describe('nextStepForAction', () => {
  it('maps actions to chained step kinds', () => {
    expect(nextStepForAction('bootstrap')).toBe('dev_plan')
    expect(nextStepForAction('plan')).toBe('dev_plan')
    expect(nextStepForAction('continue')).toBe('dev_execute')
    expect(nextStepForAction('ship')).toBe('dev_ship')
  })

  it('propose chains nothing', () => {
    expect(nextStepForAction('propose')).toBeNull()
  })
})

/**
 * Milestone TMAC §7.2 — auto-detected lifecycle_stage default.
 * Pure decision + best-effort probe; conservative (defaults to 'development').
 */
import { describe, test, expect } from 'bun:test'
import {
  deriveStageFromSignal,
  detectLifecycleStage,
  DEFAULT_STAGE,
  type StageDetectDeps,
} from '../src/orchestrator/stage-detect.ts'

describe('deriveStageFromSignal — PURE §7.2 mapping', () => {
  test('no signal ⇒ development (safe default)', () => {
    expect(deriveStageFromSignal({ hasCoolifyApp: false, hasRecordedDeploy: false })).toBe('development')
    expect(DEFAULT_STAGE).toBe('development')
  })
  test('a mapped Coolify app ⇒ production-maintenance', () => {
    expect(deriveStageFromSignal({ hasCoolifyApp: true, hasRecordedDeploy: false })).toBe('production-maintenance')
  })
  test('a recorded deploy ⇒ production-maintenance', () => {
    expect(deriveStageFromSignal({ hasCoolifyApp: false, hasRecordedDeploy: true })).toBe('production-maintenance')
  })
  test('never returns beta (not derivable)', () => {
    for (const a of [true, false]) for (const d of [true, false]) {
      expect(deriveStageFromSignal({ hasCoolifyApp: a, hasRecordedDeploy: d })).not.toBe('beta')
    }
  })
})

function deps(over: Partial<StageDetectDeps> = {}): StageDetectDeps {
  return { countRecordedDeploys: async () => 0, ...over }
}

describe('detectLifecycleStage — best-effort probe', () => {
  test('no mapped Coolify app uuid ⇒ development (no DB probe)', async () => {
    let called = false
    const d = deps({ countRecordedDeploys: async () => { called = true; return 99 } })
    expect(await detectLifecycleStage({ userId: 'u1', coolifyAppUuid: null }, d)).toBe('development')
    expect(await detectLifecycleStage({ userId: 'u1', coolifyAppUuid: '  ' }, d)).toBe('development')
    expect(called).toBe(false)
  })

  test('mapped app + a recorded deploy ⇒ production-maintenance', async () => {
    const d = deps({ countRecordedDeploys: async () => 3 })
    expect(await detectLifecycleStage({ userId: 'u1', coolifyAppUuid: 'app-123' }, d)).toBe('production-maintenance')
  })

  test('mapped app but zero deploys ⇒ still production-maintenance (app IS the signal)', async () => {
    const d = deps({ countRecordedDeploys: async () => 0 })
    expect(await detectLifecycleStage({ userId: 'u1', coolifyAppUuid: 'app-123' }, d)).toBe('production-maintenance')
  })

  test('a DB probe error degrades to development (never throws)', async () => {
    const d = deps({ countRecordedDeploys: async () => { throw new Error('db down') } })
    expect(await detectLifecycleStage({ userId: 'u1', coolifyAppUuid: 'app-123' }, d)).toBe('development')
  })
})

/**
 * Tasks single-page redesign — pure-logic guards.
 *
 *   1. Hash redirects: `#/tasks?tab=activity` → `#/activity` (Activity parked,
 *      NOT deleted); other legacy `?tab=` / `#/schedules` collapse to `#/tasks`.
 *   2. GSD template catalog: the web mirror matches the locked product spec
 *      (4 GSD presets, dash slash syntax, gsd_run auto-merge OFF, plan-first,
 *      non-bypassable cost cap), and prefill builds a valid ScheduleRule.
 */
import { describe, expect, test } from 'bun:test'
import { canonicalizeHash } from '../src/App'
import {
  GSD_TEMPLATES,
  getGsdTemplate,
  templateScheduleRules,
} from '../src/lib/gsd-templates'
import { validateRule } from '../src/lib/schedule-rules'
import { isInternalTask } from '../src/components/SchedulesPage'

describe('canonicalizeHash — Activity parked + sub-tab collapse', () => {
  test('#/tasks?tab=activity redirects to the parked #/activity route', () => {
    expect(canonicalizeHash('#/tasks?tab=activity')).toBe('#/activity')
    expect(canonicalizeHash('#/tasks?foo=1&tab=activity')).toBe('#/activity')
  })

  test('legacy #/error-capture lands on the parked Activity route', () => {
    expect(canonicalizeHash('#/error-capture')).toBe('#/activity')
  })

  test('other Tasks sub-tab deep links collapse to the single #/tasks page', () => {
    // #/schedules was the old Schedule tab.
    expect(canonicalizeHash('#/schedules')).toBe('#/tasks')
  })

  test('plain routes are left untouched', () => {
    expect(canonicalizeHash('#/tasks')).toBe('#/tasks')
    expect(canonicalizeHash('#/activity')).toBe('#/activity')
    expect(canonicalizeHash('#/settings')).toBe('#/settings')
    expect(canonicalizeHash('#/')).toBe('#/')
  })
})

describe('GSD template catalog (web mirror)', () => {
  test('ships exactly the 4 GSD presets', () => {
    expect(GSD_TEMPLATES.map((t) => t.id).sort()).toEqual([
      'gsd_audit',
      'gsd_plan',
      'gsd_review',
      'gsd_run',
    ])
    for (const t of GSD_TEMPLATES) {
      expect(t.category).toBe('gsd')
      expect(t.taskType).toBe('dev')
    }
  })

  test('slash prompts use a DASH, never a colon', () => {
    const expected: Record<string, string> = {
      gsd_run: '/gsd-run',
      gsd_audit: '/gsd-audit-fix',
      gsd_review: '/gsd-code-review',
      gsd_plan: '/gsd-plan-phase',
    }
    for (const t of GSD_TEMPLATES) {
      expect(t.promptTemplate).toBe(expected[t.id])
      expect(t.promptTemplate.includes('/gsd:')).toBe(false)
    }
  })

  test('guardrails: cost cap inherited, plan-first ON, gsd_run auto-merge OFF', () => {
    for (const t of GSD_TEMPLATES) {
      expect(t.guardrails.inheritCostCap).toBe(true)
      expect(t.guardrails.planFirst).toBe(true)
    }
    expect(getGsdTemplate('gsd_run')?.guardrails.autoMerge).toBe(false)
  })

  test('prefill produces a valid ScheduleRule per template', () => {
    for (const t of GSD_TEMPLATES) {
      const rules = templateScheduleRules(t)
      expect(rules).toHaveLength(1)
      expect(validateRule(rules[0])).toBeNull()
    }
  })
})

describe('user-facing Tasks list excludes __internal_ system tasks', () => {
  // Mirrors the SchedulesPage `filteredSchedules` exclusion guard.
  const visible = (names: string[]) =>
    names.filter((name) => !isInternalTask({ name }))

  test('isInternalTask flags only the __internal_ prefix', () => {
    expect(isInternalTask({ name: '__internal_triage' })).toBe(true)
    expect(isInternalTask({ name: '__internal_coolify_deployment' })).toBe(true)
    expect(isInternalTask({ name: 'Continue Dev on finedesignz/kh-hub' })).toBe(false)
    expect(isInternalTask({ name: 'internal report' })).toBe(false)
  })

  test('filteredSchedules drops internal tasks, keeps user tasks', () => {
    expect(
      visible(['__internal_triage', 'My nightly scan', '__internal_coolify_deployment']),
    ).toEqual(['My nightly scan'])
  })
})

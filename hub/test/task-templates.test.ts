/**
 * GSD task-template catalog tests.
 *
 * Covers the static catalog in `hub/src/scheduler/task-templates.ts`:
 *   - catalog shape + the 4 expected GSD presets
 *   - every defaultCron is a valid 5-field cron
 *   - guardrails: non-bypassable cost cap inherited; gsd_run auto-merge OFF;
 *     plan-first ON for the dev-chain templates
 *   - GSD slash syntax uses a DASH (not a colon)
 *   - default post-run actions pass the REAL post-run validator
 *   - create-from-template builds a valid scheduled-task payload (template_id
 *     + args.gsd ride the loose payload; cost cap is NOT bypassed)
 *
 * Pure-logic only (no DB / WS) — mirrors `scheduler.test.ts` style.
 */
import { describe, test, expect } from 'bun:test'

import {
  TASK_TEMPLATES,
  TASK_TEMPLATE_IDS,
  getTaskTemplate,
  type TaskTemplate,
} from '../src/scheduler/task-templates.ts'
import { validate as validateCron } from '../src/scheduler/cron.ts'
import { validatePostRunActions } from '../src/scheduler/post-run/schema.ts'
import { computeTaskAutoName } from '../src/scheduler/auto-name.ts'

describe('task-templates/catalog', () => {
  test('ships exactly the 4 GSD presets', () => {
    expect(TASK_TEMPLATE_IDS.sort()).toEqual(
      ['gsd_audit', 'gsd_plan', 'gsd_review', 'gsd_run'],
    )
    expect(TASK_TEMPLATES).toHaveLength(4)
    for (const t of TASK_TEMPLATES) {
      expect(t.category).toBe('gsd')
      expect(t.taskType).toBe('dev') // live dev-chain root (not legacy continue_dev)
      expect(t.label.length).toBeGreaterThan(0)
      expect(t.description.length).toBeGreaterThan(0)
      expect(getTaskTemplate(t.id)).toBe(t)
    }
  })

  test('getTaskTemplate returns undefined for unknown ids', () => {
    expect(getTaskTemplate('nope')).toBeUndefined()
    expect(getTaskTemplate('')).toBeUndefined()
  })

  test('every defaultCron is a valid 5-field cron', () => {
    for (const t of TASK_TEMPLATES) {
      expect(validateCron(t.defaultCron)).toEqual({ ok: true })
    }
  })

  test('GSD slash prompts use a DASH, never a colon', () => {
    const expected: Record<string, string> = {
      gsd_run: '/gsd-run',
      gsd_audit: '/gsd-audit-fix',
      gsd_review: '/gsd-code-review',
      gsd_plan: '/gsd-plan-phase',
    }
    for (const t of TASK_TEMPLATES) {
      expect(t.promptTemplate).toBe(expected[t.id])
      expect(t.promptTemplate.startsWith('/gsd-')).toBe(true)
      expect(t.promptTemplate.includes('/gsd:')).toBe(false)
    }
  })

  test('every template inherits the non-bypassable cost cap + is plan-first', () => {
    for (const t of TASK_TEMPLATES) {
      expect(t.guardrails.inheritCostCap).toBe(true)
      expect(t.guardrails.planFirst).toBe(true)
    }
  })

  test('gsd_run auto-merge default is OFF', () => {
    const run = getTaskTemplate('gsd_run') as TaskTemplate
    expect(run.guardrails.autoMerge).toBe(false)
    // No GSD preset opts into auto-merge in v1.
    for (const t of TASK_TEMPLATES) expect(t.guardrails.autoMerge).toBe(false)
  })

  test('default post-run actions pass the real validator', () => {
    for (const t of TASK_TEMPLATES) {
      const r = validatePostRunActions(t.defaultPostRunActions)
      expect(r.ok).toBe(true)
    }
  })
})

describe('task-templates/create-from-template', () => {
  // Mirrors what the web does: pre-fill ScheduleEditor from a template, then
  // POST the NORMAL create body with the additive provenance fields on the
  // loose payload. We assert the produced body is well-formed and that the
  // cost cap is not bypassed (templates set nothing special).
  function buildCreateBody(t: TaskTemplate, targetSessionId: string) {
    return {
      task_type: t.taskType, // 'dev' → routeToSender → agent runner runs payload.prompt
      target_kind: 'session' as const,
      target_id: targetSessionId,
      payload: {
        prompt: t.promptTemplate,
        template_id: t.id,
        args: { gsd: { planFirst: t.guardrails.planFirst, autoMerge: t.guardrails.autoMerge } },
      },
      cron_expr: t.defaultCron,
      timezone: 'America/Los_Angeles',
      post_run_actions: t.defaultPostRunActions,
    }
  }

  test('produces a valid, cost-cappable scheduled-task body', () => {
    const run = getTaskTemplate('gsd_run') as TaskTemplate
    const body = buildCreateBody(run, 'sess-123')

    expect(body.task_type).toBe('dev')
    expect(body.target_kind).toBe('session')
    expect(body.target_id).toBe('sess-123')
    expect(body.payload.prompt).toBe('/gsd-run')
    expect(body.payload.template_id).toBe('gsd_run')
    expect(body.payload.args.gsd.planFirst).toBe(true)
    expect(body.payload.args.gsd.autoMerge).toBe(false)
    expect(validateCron(body.cron_expr)).toEqual({ ok: true })
    // No `bypass`/cap-override key is injected — cost cap stays non-bypassable.
    expect(Object.keys(body.payload)).not.toContain('bypass_cost_cap')
    expect(Object.keys(body.payload)).not.toContain('skip_cost_cap')
    expect(validatePostRunActions(body.post_run_actions).ok).toBe(true)
  })

  test('auto-name prefix is template-aware (Run dev on <repo> …)', () => {
    const ctx = {
      sessions: [{ id: 'sess-123', name: 'remo', project_dir: 'C:/Users/x/GitHub/finedesignz/remo-code' }],
      supervisors: [],
    }
    const run = getTaskTemplate('gsd_run') as TaskTemplate
    const name = computeTaskAutoName(
      {
        task_type: 'dev',
        target_kind: 'session',
        target_id: 'sess-123',
        payload: { prompt: run.promptTemplate, template_id: run.id },
        cron_expr: run.defaultCron,
      },
      ctx,
    )
    expect(name.startsWith('Run dev on')).toBe(true)
    expect(name).toContain('finedesignz/remo-code')
  })

  test('builds a valid body for all 4 templates', () => {
    for (const t of TASK_TEMPLATES) {
      const body = buildCreateBody(t, 'sess-x')
      expect(validateCron(body.cron_expr)).toEqual({ ok: true })
      expect(body.payload.template_id).toBe(t.id)
      expect(validatePostRunActions(body.post_run_actions).ok).toBe(true)
    }
  })
})

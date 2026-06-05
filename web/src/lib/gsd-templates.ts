/**
 * Web mirror of the hub GSD task-template catalog
 * (`hub/src/scheduler/task-templates.ts`). Kept as a typed local catalog so the
 * `+ New Task ▾` menu renders instantly without a round-trip; the hub endpoint
 * `GET /api/tasks/templates` is the authoritative source and is fetched to
 * hydrate/override if it drifts (see `useTaskTemplates`).
 *
 * A template is pure sugar: picking one pre-fills `ScheduleEditor`, then the
 * normal CREATE POSTs with two additive payload fields —
 *   - `payload.template_id` — provenance tag
 *   - `payload.args.gsd`    — { planFirst, autoMerge } operator intent
 *
 * GSD slash syntax uses a DASH, never a colon.
 */
import type { TaskType } from '../hooks/useSchedules'
import type { ScheduleRule } from './schedule-rules'

export type GsdTemplateId = 'gsd_run' | 'gsd_audit' | 'gsd_review' | 'gsd_plan'

export interface GsdTemplatePostRun {
  type: 'notify_telegram' | 'github_issue'
  on: 'success' | 'failure' | 'always'
  config: Record<string, any>
}

export interface GsdTemplate {
  id: GsdTemplateId
  label: string
  description: string
  promptTemplate: string
  /** Live dev-chain root. */
  taskType: Extract<TaskType, 'dev'>
  defaultCron: string
  cadenceLabel: string
  guardrails: { planFirst: boolean; autoMerge: boolean; inheritCostCap: true }
  defaultPostRunActions: GsdTemplatePostRun[]
  category: 'gsd'
  /**
   * Cadence expressed as a ScheduleRule the editor consumes directly (the
   * editor builds cron from rules, not the other way around). `start_at` is
   * filled at prefill time with "now-ish" so the rule validates.
   */
  scheduleRule: Omit<ScheduleRule, 'start_at'>
}

const TELEGRAM_SUMMARY: GsdTemplatePostRun = {
  type: 'notify_telegram',
  on: 'always',
  config: { body: 'GSD run finished: {{task_name}} — {{status}}' },
}

export const GSD_TEMPLATES: GsdTemplate[] = [
  {
    id: 'gsd_run',
    label: 'Run dev on repo',
    description: 'Continue the active milestone — plan-first, then execute the next phase behind QC.',
    promptTemplate: '/gsd-run',
    taskType: 'dev',
    defaultCron: '0 */4 * * *',
    cadenceLabel: 'Every 4 hours',
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [TELEGRAM_SUMMARY],
    category: 'gsd',
    scheduleRule: { interval: 4, unit: 'hours' },
  },
  {
    id: 'gsd_audit',
    label: 'Audit repo (nightly)',
    description: 'Run an audit and apply fixes behind QC. Files findings on failure.',
    promptTemplate: '/gsd-audit-fix',
    taskType: 'dev',
    defaultCron: '0 3 * * *',
    cadenceLabel: 'Nightly at 03:00',
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [TELEGRAM_SUMMARY],
    category: 'gsd',
    scheduleRule: { interval: 1, unit: 'days' },
  },
  {
    id: 'gsd_review',
    label: 'Review open PRs (weekly)',
    description: 'Review the open PRs in this repo and comment findings. Read-only.',
    promptTemplate: '/gsd-code-review',
    taskType: 'dev',
    defaultCron: '0 9 * * 1',
    cadenceLabel: 'Weekly · Mon 09:00',
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [TELEGRAM_SUMMARY],
    category: 'gsd',
    scheduleRule: { interval: 1, unit: 'weeks' },
  },
  {
    id: 'gsd_plan',
    label: 'Plan next phase',
    description: 'Draft the next phase plan into .planning/ — does NOT execute code.',
    promptTemplate: '/gsd-plan-phase',
    taskType: 'dev',
    defaultCron: '0 8 * * 1',
    cadenceLabel: 'Weekly · Mon 08:00',
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [{ ...TELEGRAM_SUMMARY, on: 'success' }],
    category: 'gsd',
    scheduleRule: { interval: 1, unit: 'weeks' },
  },
]

export function getGsdTemplate(id: string | null | undefined): GsdTemplate | undefined {
  if (!id) return undefined
  return GSD_TEMPLATES.find((t) => t.id === id)
}

/** Build a concrete ScheduleRule (with start_at) for a template prefill. */
export function templateScheduleRules(t: GsdTemplate): ScheduleRule[] {
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 2)
  return [{ ...t.scheduleRule, start_at: d.toISOString() }]
}

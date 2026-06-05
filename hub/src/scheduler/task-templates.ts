/**
 * Predefined GSD scheduled-task templates (static catalog).
 *
 * A template is pure SUGAR over the existing `scheduled_tasks` row + payload —
 * NOT a new engine and NOT a new DB table. Creating from a template just opens
 * `ScheduleEditor` pre-filled, then POSTs the normal CREATE with two additive,
 * fully back-compat payload fields:
 *   - `payload.template_id` — provenance tag
 *   - `payload.args.gsd`    — `{ planFirst, autoMerge }` operator intent the
 *                             dev controller reads without re-parsing the prompt
 *
 * GSD slash syntax uses a DASH, never a colon (`/gsd-run`, not `/gsd:run`) —
 * see global memory `feedback_gsd_command_syntax`.
 *
 * Task-type note: the live dev-chain root is `task_type: 'dev'` (the legacy
 * `continue_dev`/`prompt` enum values were rewritten by the schema.sql migration
 * in commit b9edb82 — see `hub/src/scheduler/auto-name.ts`). All four GSD
 * templates therefore use `task_type: 'dev'`, which `routeToSender` sends to the
 * agent runner running `payload.prompt` verbatim. `gsd_run`/`gsd_audit` ride the
 * existing dev chain + dev controller via their post-run actions; `gsd_review`/
 * `gsd_plan` are read/plan-only single turns. v1 degrades gracefully to a plain
 * scheduled prompt when the dev controller isn't active.
 *
 * Cost cap: templates set NOTHING special — every dispatch still flows through
 * the shared non-bypassable `dailyCostCapGate` (hub/src/dispatch/gates.ts).
 */

export type TaskTemplateId = 'gsd_run' | 'gsd_audit' | 'gsd_review' | 'gsd_plan'

export interface TaskTemplateGuardrails {
  /** Plan-first ALWAYS for the dev chain (locked auto-dev decision). */
  planFirst: boolean
  /** Auto-merge after QC. `gsd_run` default OFF (QC → PR). */
  autoMerge: boolean
  /** Cost cap is non-bypassable; templates always inherit the user cap. */
  inheritCostCap: true
}

/**
 * A post-run action template entry. Mirrors the discriminated union in
 * `hub/src/scheduler/post-run/schema.ts` but kept loose here so the static
 * catalog doesn't import the Zod types; the API still validates real rows.
 */
export interface TaskTemplatePostRun {
  type: 'notify_telegram' | 'github_issue'
  on: 'success' | 'failure' | 'always'
  config: Record<string, unknown>
}

export interface TaskTemplate {
  id: TaskTemplateId
  label: string
  description: string
  /** Literal GSD slash text injected into `payload.prompt`. */
  promptTemplate: string
  /** Live dev-chain root — see module note. */
  taskType: 'dev'
  /** Default cron (5-field). The web mirrors this as a ScheduleRule. */
  defaultCron: string
  /** Human cadence label shown in the catalog card. */
  cadenceLabel: string
  requiredInputs: Array<'target_session' | 'cadence'>
  guardrails: TaskTemplateGuardrails
  defaultPostRunActions: TaskTemplatePostRun[]
  category: 'gsd'
}

const TELEGRAM_SUMMARY: TaskTemplatePostRun = {
  type: 'notify_telegram',
  on: 'always',
  config: { body: 'GSD run finished: {{task_name}} — {{status}}' },
}

export const TASK_TEMPLATES: TaskTemplate[] = [
  {
    id: 'gsd_run',
    label: 'Run dev on repo',
    description:
      'Continue the active milestone: plan-first, then execute the next phase behind QC. Rides the dev chain.',
    promptTemplate: '/gsd-run',
    taskType: 'dev',
    defaultCron: '0 */4 * * *',
    cadenceLabel: 'Every 4 hours',
    requiredInputs: ['target_session', 'cadence'],
    // Locked: gsd_run auto-merge default = OFF (QC → PR).
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [TELEGRAM_SUMMARY],
    category: 'gsd',
  },
  {
    id: 'gsd_audit',
    label: 'Audit repo (nightly)',
    description:
      'Run an audit and apply fixes behind QC. Files findings as a GitHub issue on failure.',
    promptTemplate: '/gsd-audit-fix',
    taskType: 'dev',
    defaultCron: '0 3 * * *',
    cadenceLabel: 'Nightly at 03:00',
    requiredInputs: ['target_session', 'cadence'],
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [TELEGRAM_SUMMARY],
    category: 'gsd',
  },
  {
    id: 'gsd_review',
    label: 'Review open PRs (weekly)',
    description:
      'Review the open PRs in this repo and comment findings. Read-only — no auto-merge.',
    promptTemplate: '/gsd-code-review',
    taskType: 'dev',
    defaultCron: '0 9 * * 1',
    cadenceLabel: 'Weekly · Mon 09:00',
    requiredInputs: ['target_session', 'cadence'],
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [TELEGRAM_SUMMARY],
    category: 'gsd',
  },
  {
    id: 'gsd_plan',
    label: 'Plan next phase',
    description:
      'Draft the next phase plan into .planning/ — does NOT execute code. Plan-only.',
    promptTemplate: '/gsd-plan-phase',
    taskType: 'dev',
    defaultCron: '0 8 * * 1',
    cadenceLabel: 'Weekly · Mon 08:00',
    requiredInputs: ['target_session', 'cadence'],
    guardrails: { planFirst: true, autoMerge: false, inheritCostCap: true },
    defaultPostRunActions: [
      { ...TELEGRAM_SUMMARY, on: 'success' },
    ],
    category: 'gsd',
  },
]

const BY_ID = new Map<TaskTemplateId, TaskTemplate>(
  TASK_TEMPLATES.map((t) => [t.id, t]),
)

export function getTaskTemplate(id: string): TaskTemplate | undefined {
  return BY_ID.get(id as TaskTemplateId)
}

export const TASK_TEMPLATE_IDS: TaskTemplateId[] = TASK_TEMPLATES.map((t) => t.id)

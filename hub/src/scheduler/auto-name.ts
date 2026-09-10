/**
 * Server-side auto-generated task name prefix builder.
 *
 * Mirrors `web/src/lib/task-name.ts` so the hub can recompute the locked
 * prefix on every POST/PATCH from (task_type, target_kind, target_id,
 * payload, cron_expr). The final stored `name` column is
 * `<prefix> — <suffix>` (or just `<prefix>` if suffix is empty).
 *
 * Pure function. Callers resolve sessions/supervisors and pass via ctx.
 */

// Phase 11: narrowed to dev/security/log_check roots + chained step kinds
// + internal triage. Legacy prompt/skill/continue_dev/security_scan(root)
// were migrated by the DB rewrite in commit b9edb82.
export type TaskType =
  | 'dev' | 'security' | 'log_check' | 'qc'
  | 'dev_controller' | 'dev_plan' | 'dev_execute' | 'dev_ship'
  | 'security_scan' | 'security_triage' | 'security_fix_or_issue'
  | 'log_pull' | 'log_classify' | 'log_triage'
  | 'qc_review' | 'qc_fix' | 'qc_verify'
  | 'triage'
  | 'teab'
export type TargetKind = 'session' | 'supervisor' | 'all_agents' | 'all_supervisors'

export interface SessionLike {
  id: string
  name?: string | null
  project_dir?: string | null
}

export interface SupervisorLike {
  id: string
  hostname?: string | null
}

export interface TaskNameContext {
  sessions: SessionLike[]
  supervisors: SupervisorLike[]
}

export interface TaskNameInput {
  task_type: TaskType
  target_kind: TargetKind
  target_id?: string | null
  payload?: Record<string, any>
  cron_expr: string
}

const TYPE_LABELS: Record<TaskType, string> = {
  dev: 'Dev',
  security: 'Security',
  log_check: 'Log Check',
  qc: 'QC',
  qc_review: 'QC · Review',
  qc_fix: 'QC · Fix',
  qc_verify: 'QC · Verify',
  dev_controller: 'Dev · Controller',
  dev_plan: 'Dev · Plan',
  dev_execute: 'Dev · Execute',
  dev_ship: 'Dev · Ship',
  security_scan: 'Security · Scan',
  security_triage: 'Security · Triage',
  security_fix_or_issue: 'Security · Fix/Issue',
  log_pull: 'Log · Pull',
  log_classify: 'Log · Classify',
  log_triage: 'Log · Triage',
  triage: 'Triage',
  teab: 'TEAB Build',
}

function shortenPath(p: string | null | undefined): string {
  if (!p) return ''
  const norm = p.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = norm.split('/').filter(Boolean)
  if (parts.length === 0) return ''
  const ghIdx = parts.findIndex((s) => s.toLowerCase() === 'github')
  if (ghIdx >= 0 && parts.length > ghIdx + 2) {
    return parts[ghIdx + 1] + '/' + parts[ghIdx + 2]
  }
  if (parts.length >= 2) return parts[parts.length - 2] + '/' + parts[parts.length - 1]
  return parts[parts.length - 1]
}

function targetLabel(
  target_kind: TargetKind,
  target_id: string | null | undefined,
  ctx: TaskNameContext,
): string {
  switch (target_kind) {
    case 'session': {
      if (!target_id) return ''
      const s = ctx.sessions.find((x) => x.id === target_id)
      if (!s) return ''
      const repo = shortenPath(s.project_dir)
      return repo || s.name || ''
    }
    case 'supervisor': {
      if (!target_id) return ''
      const sup = ctx.supervisors.find((x) => x.id === target_id)
      return sup?.hostname || ''
    }
    case 'all_agents':
      return 'all agents'
    case 'all_supervisors':
      return 'all supervisors'
    default:
      return ''
  }
}

export function cronCadence(cron: string): string {
  if (!cron) return ''
  const parts = cron.trim().split(/\s+/)
  if (parts.length < 5) return cron
  const [min, hour, dom, mon, dow] = parts

  const minStep = /^\*\/(\d+)$/.exec(min)
  if (minStep && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'every ' + minStep[1] + 'm'
  }
  const hourStep = /^\*\/(\d+)$/.exec(hour)
  if (hourStep && /^\d+$/.test(min) && dom === '*' && mon === '*' && dow === '*') {
    return 'every ' + hourStep[1] + 'h'
  }
  if (/^\d+$/.test(min) && hour === '*' && dom === '*' && mon === '*' && dow === '*') {
    return 'hourly'
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && dow === '*') {
    return 'daily at ' + hour.padStart(2, '0') + ':' + min.padStart(2, '0')
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && mon === '*' && /^\d+$/.test(dow)) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const d = days[parseInt(dow, 10) % 7] || dow
    return 'weekly on ' + d + ' at ' + hour.padStart(2, '0') + ':' + min.padStart(2, '0')
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
    return 'monthly on day ' + dom + ' at ' + hour.padStart(2, '0') + ':' + min.padStart(2, '0')
  }
  return cron
}

/**
 * Compute the locked, auto-generated prefix portion of a scheduled-task name.
 * Returns '' when not enough context to render (no target yet, etc.).
 */
// GSD template id → leading label, so a template-created task reads
// "Run dev on <repo> every 4h" instead of the generic "Dev on <repo> …".
// Kept in lockstep with `hub/src/scheduler/task-templates.ts`.
const TEMPLATE_LEADS: Record<string, string> = {
  gsd_run: 'Run dev',
  gsd_audit: 'Audit',
  gsd_review: 'Review PRs',
  gsd_plan: 'Plan phase',
}

export function computeTaskAutoName(task: TaskNameInput, ctx: TaskNameContext): string {
  const typeLbl = TYPE_LABELS[task.task_type] || task.task_type
  const target = targetLabel(task.target_kind, task.target_id ?? null, ctx)
  const cadence = cronCadence(task.cron_expr)

  const templateId = task.payload?.template_id
  const leading =
    (typeof templateId === 'string' && TEMPLATE_LEADS[templateId]) || typeLbl

  if (!target) return ''
  if (!cadence) return leading + ' on ' + target
  return leading + ' on ' + target + ' ' + cadence
}

/**
 * Compose the final `name` column value from prefix + optional user suffix.
 * Falls back to prefix-only when suffix is empty/whitespace.
 */
export function composeTaskName(prefix: string, suffix: string | null | undefined): string {
  const p = (prefix || '').trim()
  const s = (suffix || '').trim()
  if (!p && !s) return ''
  if (!s) return p
  if (!p) return s
  return p + ' — ' + s
}

/**
 * One-shot helper: build the locked prefix + compose with user's suffix.
 */
export function buildTaskName(
  input: TaskNameInput,
  suffix: string | null | undefined,
  ctx: TaskNameContext,
): { prefix: string; suffix: string; name: string } {
  const prefix = computeTaskAutoName(input, ctx)
  const cleanSuffix = (suffix || '').trim()
  const name = composeTaskName(prefix, cleanSuffix)
  return { prefix, suffix: cleanSuffix, name }
}

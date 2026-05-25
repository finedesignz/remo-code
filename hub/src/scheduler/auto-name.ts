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

export type TaskType =
  | 'prompt'
  | 'skill'
  | 'security_scan'
  | 'log_check'
  | 'continue_dev'
  | 'triage'
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
  prompt: 'Prompt',
  skill: 'Skill',
  security_scan: 'Security Scan',
  log_check: 'Log Check',
  continue_dev: 'Continue Dev',
  triage: 'Triage',
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
export function computeTaskAutoName(task: TaskNameInput, ctx: TaskNameContext): string {
  const typeLbl = TYPE_LABELS[task.task_type] || task.task_type
  const target = targetLabel(task.target_kind, task.target_id ?? null, ctx)
  const cadence = cronCadence(task.cron_expr)

  let leading = typeLbl
  if (task.task_type === 'skill') {
    const cmd = (task.payload?.command || '').trim()
    if (cmd) leading = 'Skill ' + cmd
  }

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

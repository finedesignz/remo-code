/**
 * PTYCAP-07 (AM-F5-3): durable internal scheduled-task recognition.
 *
 * A task is internal when scheduled_tasks.is_internal is true OR its name starts
 * with `__internal_` (union, fail closed). The prefix half keeps rows created
 * before the is_internal column existed recognised without any backfill (rule 6).
 */
export const INTERNAL_TASK_NAME_PREFIX = '__internal_'

export function isInternalScheduledTask(
  task: { name?: string | null; is_internal?: boolean | null } | null | undefined,
): boolean {
  if (!task) return true // no row to reason about: fail closed
  if (task.is_internal === true) return true
  return typeof task.name === 'string' && task.name.startsWith(INTERNAL_TASK_NAME_PREFIX)
}

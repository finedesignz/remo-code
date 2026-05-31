/**
 * Phase 11 — workflow step ordering registry.
 *
 * Declarative map of workflow → ordered chained step kinds. The
 * dispatcher does NOT walk this table at dispatch time — chain edges are
 * stored as explicit `chain_task` post-run actions on each
 * `scheduled_tasks` row (the existing `hub/src/scheduler/post-run/chain.ts`
 * keeps owning the actual fan-out). This module is the source-of-truth
 * for:
 *
 *   1. The UI's "Create workflow" path that auto-creates three pre-chained
 *      `scheduled_tasks` rows when a user saves a `dev`/`security`/
 *      `log_check` schedule (PLAN.md decision #3).
 *   2. The `nextStepInWorkflow(currentTaskKind)` helper used by chain
 *      validators + the upcoming triage logic.
 *
 * Keep this in lockstep with `hub/src/scheduler/prompts/<workflow>/<step>.md`
 * — each declared step MUST have a matching template file.
 */

import type { TaskType } from '../db/scheduled-tasks-dal.ts'

export type WorkflowRoot = 'dev' | 'security' | 'log_check' | 'qc'

/** Canonical ordered step kinds per workflow. */
export const WORKFLOWS = {
  dev: ['dev_controller', 'dev_plan', 'dev_execute', 'dev_ship'],
  security: ['security_scan', 'security_triage', 'security_fix_or_issue'],
  log_check: ['log_pull', 'log_classify', 'log_triage'],
  // auto-dev P4: review → fix → verify. verify opens a PR (never merges) and
  // NEVER chains back to review — the next scheduled tick re-reviews.
  qc: ['qc_review', 'qc_fix', 'qc_verify'],
} as const satisfies Record<WorkflowRoot, readonly TaskType[]>

/**
 * Return the next chained step kind after `current`, or null when:
 *   - `current` is the terminal step in its workflow (e.g. `dev_ship`)
 *   - `current` is not a chained step kind (e.g. a workflow root or `triage`)
 *
 * Pure. No IO.
 */
export function nextStepInWorkflow(current: TaskType): TaskType | null {
  for (const root of Object.keys(WORKFLOWS) as WorkflowRoot[]) {
    const steps = WORKFLOWS[root]
    const idx = steps.indexOf(current as never)
    if (idx === -1) continue
    if (idx === steps.length - 1) return null
    return steps[idx + 1] as TaskType
  }
  return null
}

/** Map a workflow root to its step list. Returns null for non-roots. */
export function stepsForWorkflow(root: TaskType): readonly TaskType[] | null {
  if (root === 'dev') return WORKFLOWS.dev
  if (root === 'security') return WORKFLOWS.security
  if (root === 'log_check') return WORKFLOWS.log_check
  if (root === 'qc') return WORKFLOWS.qc
  return null
}

/**
 * Map a chained step kind back to its workflow root. Returns null for
 * roots and unknown kinds.
 */
export function workflowRootForStep(step: TaskType): WorkflowRoot | null {
  for (const root of Object.keys(WORKFLOWS) as WorkflowRoot[]) {
    if ((WORKFLOWS[root] as readonly TaskType[]).includes(step)) return root
  }
  return null
}

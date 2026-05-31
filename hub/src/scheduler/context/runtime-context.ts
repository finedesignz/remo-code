/**
 * Phase 11 — runtime context injector.
 *
 * Builds the JSON snapshot persisted to
 * `scheduled_task_runs.runtime_context_snapshot` and rendered as the
 * `## RUNTIME CONTEXT` markdown block prepended to every scheduled agent
 * message.
 *
 * Hub-side data only. Fields fall back to `null`/`undefined` when the
 * underlying source isn't reachable — DO NOT fabricate values.
 */
import { sql } from '../../db/postgres.ts'

export interface RuntimeContext {
  project_type?: 'tauri' | 'web-app' | 'api' | 'service' | 'unknown' | null
  deploy_target?: string | null
  coolify_app_name?: string | null
  coolify_app_uuid?: string | null
  notify_email?: string | null
  repo?: string | null
  branch?: string | null
  last_commit_sha?: string | null
  current_version?: string | null
  latest_tag?: string | null
  mode?: 'pre-v1' | 'post-v1' | null
  design_preferences?: string | null
  user_global_rules_digest?: string | null
  /**
   * auto-dev P2: the prior run's output snippet (its `Summary:` + decision/
   * result) for this task, so a controller/continue step sees what the last run
   * concluded. Maps to the `{{prior_step_output}}` template var.
   */
  prior_step_output?: string | null
  /**
   * auto-dev P3: the routine's `payload.notes` — the stated user goal, including
   * a human's roadmap approval captured via HITL. Surfaced to the controller as
   * `user_goal` so the next tick sees a goal and chooses `plan` over `propose`.
   */
  user_goal?: string | null
}

// Hardcoded placeholders per scope brief — wired sources land in later phases.
const USER_GLOBAL_RULES_DIGEST =
  'Titanium auth (#16) | Coolify Postgres (#17) | emails4agents (#7) | ' +
  'smallest-diff Karpathy (#11) | one branch per feature (#19) | ' +
  'docs+version+release on phase done (#14)'
const DESIGN_PREFERENCES = 'orange-accent-subtle-borderless'

/**
 * Build a RuntimeContext for a scheduled run. Pulls user email and (when
 * available) session repo metadata. Unavailable fields stay undefined.
 */
export async function buildRuntimeContext(input: {
  userId: string
  sessionId?: string | null
  taskKind: string
  /** auto-dev P2: the firing task's id, used to fetch the prior run's output. */
  taskId?: string | null
}): Promise<RuntimeContext> {
  const ctx: RuntimeContext = {
    design_preferences: DESIGN_PREFERENCES,
    user_global_rules_digest: USER_GLOBAL_RULES_DIGEST,
  }

  try {
    const rows = await sql<{ email: string | null }[]>`
      SELECT email FROM users WHERE id = ${input.userId} LIMIT 1
    `
    if (rows[0]?.email) ctx.notify_email = rows[0].email
  } catch { /* fall back to undefined */ }

  if (input.sessionId) {
    try {
      // sessions has `project_dir` and (additive) `repo_key`. branch /
      // last_commit_sha / local_paths are NOT in the current hub schema —
      // leave them undefined rather than faking.
      const rows = await sql<{ repo_key: string | null; project_dir: string | null }[]>`
        SELECT repo_key, project_dir FROM sessions WHERE id = ${input.sessionId} LIMIT 1
      `
      if (rows[0]) {
        if (rows[0].repo_key) ctx.repo = rows[0].repo_key
        else if (rows[0].project_dir) ctx.repo = rows[0].project_dir
      }
    } catch { /* fall back to undefined */ }
  }

  // auto-dev P3: the routine's stated goal (payload.notes), so the controller
  // sees a goal (incl. a HITL-approved roadmap item) and picks `plan` over
  // `propose` on the next tick. Best-effort; empty notes leave it undefined.
  if (input.taskId) {
    try {
      const rows = await sql<{ notes: string | null }[]>`
        SELECT payload->>'notes' AS notes FROM scheduled_tasks WHERE id = ${input.taskId} LIMIT 1
      `
      const notes = rows[0]?.notes?.trim()
      if (notes) ctx.user_goal = notes
    } catch { /* fall back to undefined */ }
  }

  // auto-dev P2: the latest finished prior run's output for this task, so the
  // controller/continue step knows what the last run concluded. One cheap query;
  // best-effort (an absent prior run just leaves the field undefined).
  if (input.taskId) {
    try {
      const rows = await sql<{ output_snippet: string | null }[]>`
        SELECT output_snippet FROM scheduled_task_runs
        WHERE task_id = ${input.taskId}
          AND status IN ('success', 'failed', 'skipped', 'skipped_quota')
        ORDER BY COALESCE(finished_at, started_at, created_at) DESC
        LIMIT 1
      `
      if (rows[0]?.output_snippet) ctx.prior_step_output = rows[0].output_snippet
    } catch { /* fall back to undefined */ }
  }

  return ctx
}

/**
 * Render a RuntimeContext as the `## RUNTIME CONTEXT` markdown block.
 * Null/undefined/empty fields are SKIPPED (per scope brief).
 */
export function renderRuntimeContextBlock(ctx: RuntimeContext): string {
  const order: (keyof RuntimeContext)[] = [
    'project_type',
    'deploy_target',
    'coolify_app_name',
    'coolify_app_uuid',
    'notify_email',
    'repo',
    'branch',
    'last_commit_sha',
    'current_version',
    'latest_tag',
    'mode',
    'design_preferences',
    'user_global_rules_digest',
    'user_goal',
    'prior_step_output',
  ]
  const lines: string[] = ['## RUNTIME CONTEXT']
  for (const key of order) {
    const val = ctx[key]
    if (val == null || val === '') continue
    lines.push(`- ${key}: ${val}`)
  }
  return lines.join('\n')
}

/**
 * Coolify log_check sender (W2/T10).
 *
 * Hub-local — does NOT go through agent or supervisor. Used by `log_check`
 * scheduled tasks to fetch recent container logs and capture them into the
 * run's output_snippet for downstream post-run actions.
 *
 *   COOLIFY_TOKEN env → Bearer auth (per CLAUDE.md secrets convention)
 *   COOLIFY_BASE_URL  → default https://coolify.titaniumlabs.us
 *   task.payload.application_uuid → app to query
 */
import type { ScheduledTask } from '../../db/scheduled-tasks-dal.ts'
import { getSession, getCoolifyAppByRepoKey } from '../../db/dal.ts'
import { finalizeRun } from '../dispatcher.ts'
import { classifyLogs } from '../log-classifier.ts'

interface RunCtxLike { runId: string; taskId: string; userId: string }

const DEFAULT_BASE = 'https://coolify.titaniumlabs.us'
const MAX_SNIPPET = 4000
const MAX_LINES = 200

/**
 * Resolve the Coolify app to query for this task.
 *
 * Prod bug (2026-07): repo-bound `log_check` tasks carry no `application_uuid`
 * in their payload, so every 6h fire finalized `failed / no_application_uuid` —
 * pure noise, and `failed` fires `on:'failure'` post-run chains. Before giving
 * up we now resolve the uuid the same way `GET /api/sessions/:id/coolify-app`
 * does: session → `repo_key` → `coolify_app_repo` map (user-scoped).
 * Best-effort + non-throwing; returns null when unresolvable.
 */
async function resolveAppUuid(task: ScheduledTask, userId: string): Promise<string | null> {
  const payload = task.payload as any
  const fromPayload: string | undefined = payload?.application_uuid || payload?.app_uuid
  if (fromPayload) return fromPayload

  const sessionId = task.session_id
    ?? (task.target_kind === 'session' ? task.target_id : null)
  if (!sessionId) return null

  try {
    const session = await getSession(sessionId, userId) as any
    const repoKey: string | null = session?.repo_key ?? null
    if (!repoKey) return null
    const row = await getCoolifyAppByRepoKey(repoKey, userId)
    return row?.application_uuid ?? null
  } catch {
    return null
  }
}

export async function sendLogCheck(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
  const token = process.env.COOLIFY_TOKEN
  const baseUrl = process.env.COOLIFY_BASE_URL || DEFAULT_BASE
  if (!token) { await finalizeRun(ctx.runId, 'failed', 'coolify_unconfigured'); return }

  const appUuid = await resolveAppUuid(task, ctx.userId)
  // Nothing to check is NOT a failure: finalize `skipped` so `on:'failure'`
  // post-run chains don't fire on a task that simply isn't bound to an app.
  if (!appUuid) { await finalizeRun(ctx.runId, 'skipped', 'no_application_uuid'); return }

  const url = `${baseUrl.replace(/\/+$/, '')}/api/v1/applications/${appUuid}/logs`
  const startedAt = Date.now()
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    })
    const text = await res.text()
    const lines = text.split(/\r?\n/).slice(-MAX_LINES).join('\n')
    const snippet = lines.length > MAX_SNIPPET ? lines.slice(-MAX_SNIPPET) : lines
    if (!res.ok) {
      await finalizeRun(ctx.runId, 'failed', `coolify_http_${res.status}`, {
        duration_ms: Date.now() - startedAt, output_snippet: snippet,
      })
      return
    }
    // Phase 11 cleanup: classify the pulled logs with a cheap regex gate
    // BEFORE handing off to any LLM step. When clean, finalize as `skipped`
    // with reason `no_errors_detected` so the daily cost cap is preserved —
    // post-run chains gated on `on:'success'` will NOT fire. (Chains gated
    // on `on:'failure'` still fire, mirroring existing skipped semantics.)
    const classification = classifyLogs(snippet)
    if (!classification.hasErrors) {
      await finalizeRun(ctx.runId, 'skipped', 'no_errors_detected', {
        duration_ms: Date.now() - startedAt,
        output_snippet: snippet,
      })
      return
    }
    await finalizeRun(ctx.runId, 'success', null, {
      duration_ms: Date.now() - startedAt, output_snippet: snippet,
    })
  } catch (err: any) {
    await finalizeRun(ctx.runId, 'failed', `coolify_fetch_failed: ${err?.message}`, {
      duration_ms: Date.now() - startedAt,
    })
  }
}

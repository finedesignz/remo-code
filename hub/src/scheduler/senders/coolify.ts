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
import { finalizeRun } from '../dispatcher.ts'

interface RunCtxLike { runId: string; taskId: string; userId: string }

const DEFAULT_BASE = 'https://coolify.titaniumlabs.us'
const MAX_SNIPPET = 4000
const MAX_LINES = 200

export async function sendLogCheck(task: ScheduledTask, ctx: RunCtxLike): Promise<void> {
  const token = process.env.COOLIFY_TOKEN
  const baseUrl = process.env.COOLIFY_BASE_URL || DEFAULT_BASE
  if (!token) { await finalizeRun(ctx.runId, 'failed', 'coolify_unconfigured'); return }

  const payload = task.payload as any
  const appUuid: string | undefined = payload?.application_uuid || payload?.app_uuid
  if (!appUuid) { await finalizeRun(ctx.runId, 'failed', 'no_application_uuid'); return }

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
    await finalizeRun(ctx.runId, 'success', null, {
      duration_ms: Date.now() - startedAt, output_snippet: snippet,
    })
  } catch (err: any) {
    await finalizeRun(ctx.runId, 'failed', `coolify_fetch_failed: ${err?.message}`, {
      duration_ms: Date.now() - startedAt,
    })
  }
}

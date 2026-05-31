/**
 * auto-dev P5 — `deploy_verify` post-run action handler.
 *
 * Closes the Coolify error→fix→redeploy loop with VERIFICATION (not hope):
 *   1. Trigger a forced Coolify redeploy (POST /api/v1/deploy?uuid=…&force=true)
 *      so the probe runs against the freshly-built image, not a racing push build.
 *   2. Run the verify probe: poll /health, THEN probe the REAL routes
 *      (rule 14.4 — never /health alone), classifying 401/404/502 per route.
 *   3. Report pass/fail to chat — posted into the repo-bound session (or the
 *      orchestrator session) so the user sees a per-route verdict.
 *
 * Coolify token + base URL come from env ONLY (COOLIFY_TOKEN / COOLIFY_BASE_URL),
 * never hard-coded. The redeploy is the ONLY prod-mutating call in this PR.
 *
 * Best-effort throughout: a failure here is log-only and never fails the parent
 * run. Skips cleanly (logs) when Coolify is unconfigured.
 */
import type { PostRunAction } from './schema.ts'
import { coolifyConfigFromEnv, triggerRedeploy } from '../../lib/coolify-client.ts'
import { runDeployVerify, formatVerifyReport } from '../deploy-verify-probe.ts'
import { resolveRepoKeyedAgentSession } from '../../sessions/repo-routing.ts'
import { findOpenOrchestratorSession } from '../../db/orchestrator-dal.ts'
import { insertMessage } from '../../db/dal.ts'
import { getRun } from '../../db/scheduled-tasks-dal.ts'
import { broadcastToSubscribers } from '../../ws/registry.ts'

interface DeployVerifyCtx {
  userId: string
  templateVars: Record<string, unknown>
  runId: string
}

/** Resolve where the verify report should land: explicit config → repo-bound
 *  session (from the run's git_repository) → orchestrator session → null. */
async function resolveReportSession(
  userId: string,
  explicitSessionId: string | undefined,
  gitRepository: string | null | undefined,
): Promise<string | null> {
  if (explicitSessionId) return explicitSessionId
  try {
    const repoKeyed = await resolveRepoKeyedAgentSession(userId, gitRepository)
    if (repoKeyed) return repoKeyed.agent_session_id
  } catch {
    /* fall through to orchestrator */
  }
  try {
    const orch = await findOpenOrchestratorSession(userId)
    if (orch) return (orch as any).id as string
  } catch {
    /* no session to report into */
  }
  return null
}

/** Post the verify report into a session (persisted + broadcast to web). */
async function reportToChat(sessionId: string, runId: string, body: string): Promise<void> {
  try {
    const msg = await insertMessage(sessionId, 'assistant', body)
    broadcastToSubscribers(sessionId, {
      type: 'message',
      session_id: sessionId,
      message: msg,
      run_id: runId,
    } as any)
  } catch (err: any) {
    console.warn(`[post-run.deploy-verify] report-to-chat failed session=${sessionId}: ${err?.message}`)
  }
}

export async function executeDeployVerify(action: PostRunAction, ctx: DeployVerifyCtx): Promise<void> {
  if (action.type !== 'deploy_verify') return
  const cfgEnv = coolifyConfigFromEnv()
  if (!cfgEnv) {
    console.warn('[post-run.deploy-verify] COOLIFY_TOKEN unset; skipping redeploy+verify')
    return
  }

  const { application_uuid, base_url, routes } = action.config
  let gitRepository = (ctx.templateVars.git_repository as string | undefined) ?? null
  if (!gitRepository) {
    // Fall back to the run row (deployment metadata columns), like github-issue.
    try {
      const row: any = await getRun(ctx.runId, ctx.userId)
      if (row?.git_repository) gitRepository = row.git_repository
    } catch (err: any) {
      console.warn(`[post-run.deploy-verify] getRun threw: ${err?.message}`)
    }
  }
  const appLabel = gitRepository || application_uuid

  // (1) Forced redeploy.
  const redeploy = await triggerRedeploy(cfgEnv, application_uuid)
  if (!redeploy.ok) {
    console.warn(
      `[post-run.deploy-verify] redeploy failed app=${application_uuid} status=${redeploy.status} ${redeploy.detail ?? ''}`,
    )
    // Still probe — the fix push may already have triggered an auto-deploy.
  } else {
    console.info(`[post-run.deploy-verify] redeploy triggered app=${application_uuid}`)
  }

  // (2) Verify probe — health then REAL routes.
  const result = await runDeployVerify({
    baseUrl: base_url,
    routes,
    healthPaths: action.config.health_paths,
    healthTimeoutMs: action.config.health_timeout_ms,
    healthIntervalMs: action.config.health_interval_ms,
  })

  const report = formatVerifyReport(appLabel, result)
  if (!redeploy.ok) {
    console.log(`[post-run.deploy-verify] (redeploy not ok) ${report.replace(/\n/g, ' | ')}`)
  } else {
    console.log(`[post-run.deploy-verify] ${report.replace(/\n/g, ' | ')}`)
  }

  // (3) Report to chat.
  const sessionId = await resolveReportSession(
    ctx.userId,
    action.config.report_session_id,
    gitRepository,
  )
  if (sessionId) {
    const redeployNote = redeploy.ok
      ? ''
      : `\n(note: forced redeploy returned ${redeploy.status || 'error'} — probed the push-triggered build instead)`
    await reportToChat(sessionId, ctx.runId, report + redeployNote)
  } else {
    console.log('[post-run.deploy-verify] no session to report verify result into')
  }
}

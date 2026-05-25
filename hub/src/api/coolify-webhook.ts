/**
 * Coolify deployment webhook ingress (Phase 06 / G2 + G5).
 *
 * Public route — auth is per-user HMAC over the raw body. Coolify is configured
 * to POST here with:
 *   - X-Coolify-Signature: sha256=<hex>  (HMAC-SHA256 over `${ts}.${rawBody}`)
 *   - X-Coolify-Timestamp: <unix-seconds>
 *
 * Flow:
 *   1. read raw body BEFORE any JSON parse (HMAC verification needs exact bytes)
 *   2. reject if signature/timestamp headers missing
 *   3. reject if timestamp skew > 5 minutes
 *   4. load per-user secret from users.coolify_webhook_secret
 *   5. constant-time compare against expected signature
 *   6. Zod-validate payload
 *   7. insert a scheduled_task_runs row with deployment metadata
 *        - deployment.failed     → status='pending' + dispatchTriageStub()
 *        - deployment.succeeded  → status='success' (metadata only, no spend)
 *        - deployment.in_progress→ status='success' (metadata only)
 *   8. respond 202 { ok: true, run_id }
 *
 * Triage routing (plan 008) replaces the body of `dispatchTriageStub` with the
 * real session-target picker — this file ships the ingress + storage.
 */
import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import {
  getUserCoolifyWebhookSecret,
  ensureInternalDeploymentTask,
  ensureInternalTriageTask,
  insertDeploymentRun,
} from '../db/dal.ts'
import { runNow as dispatcherRunNow } from '../scheduler/dispatcher.ts'

export const coolifyWebhookRoutes = new Hono()

const SKEW_SECONDS = 300

const CoolifyWebhookPayload = z.object({
  event: z.enum(['deployment.failed', 'deployment.succeeded', 'deployment.in_progress']),
  deployment_uuid: z.string().min(1),
  application_uuid: z.string().min(1),
  git_repository: z.string().optional(),
  commit_sha: z.string().optional(),
})

export type CoolifyWebhookPayload = z.infer<typeof CoolifyWebhookPayload>

/**
 * Phase 06 plan 008 — fires a real triage run through the scheduler:
 *   1. lazy-create the per-user internal triage task (task_type='triage', disabled)
 *   2. dispatcher.runNow with payloadOverride carrying deployment metadata
 *   3. senders/triage.ts picks a target via pickSessionTarget, dispatches the
 *      rendered prompt, and finalizes on the next assistant message
 *
 * `deploymentRunId` is the metadata row stored at webhook ingress; kept for
 * UI telemetry. The triage run is a separate row owned by the triage task.
 * Cost-cap is enforced inside dispatcher.runNow → fireTask.
 *
 * Note: log_snippet is empty — the webhook body does not carry logs. The
 * model triages on metadata + repo context. A future enhancement can pull
 * logs via the Coolify API before dispatch.
 */
export async function dispatchTriage(
  userId: string,
  deploymentRunId: string,
  payload: CoolifyWebhookPayload,
): Promise<void> {
  const taskId = await ensureInternalTriageTask(userId)
  await dispatcherRunNow(taskId, userId, {
    triggeredByRunId: deploymentRunId,
    chainDepth: 0,
    payloadOverride: {
      application_uuid: payload.application_uuid,
      deployment_uuid: payload.deployment_uuid,
      git_repository: payload.git_repository,
      commit_sha: payload.commit_sha,
      log_snippet: '',
    },
  })
}

// Back-compat export kept for tests that referenced the stub by name.
export const dispatchTriageStub = dispatchTriage

function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

coolifyWebhookRoutes.post('/webhook/:user_id', async (c) => {
  const userId = c.req.param('user_id')

  // (1) Raw body — MUST happen before any JSON parse so HMAC sees exact bytes.
  const rawBody = await c.req.text()

  // (2) Required headers.
  const sigHeader = c.req.header('x-coolify-signature')
  const tsHeader = c.req.header('x-coolify-timestamp')
  if (!sigHeader || !tsHeader) {
    return c.json({ error: 'missing_signature' }, 401)
  }

  // (3) Skew check.
  const ts = Number(tsHeader)
  if (!Number.isFinite(ts)) {
    return c.json({ error: 'bad_timestamp' }, 401)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > SKEW_SECONDS) {
    return c.json({ error: 'stale_timestamp' }, 401)
  }

  // (4) Per-user secret.
  const secret = await getUserCoolifyWebhookSecret(userId)
  if (!secret) {
    return c.json({ error: 'webhook_not_configured' }, 401)
  }

  // (5) HMAC verify with constant-time compare.
  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  if (!constantTimeEqualStr(sigHeader, expected)) {
    return c.json({ error: 'bad_signature' }, 401)
  }

  // (6) Validate payload.
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    return c.json({ error: 'bad_json' }, 400)
  }
  const result = CoolifyWebhookPayload.safeParse(parsedBody)
  if (!result.success) {
    return c.json({ error: 'bad_payload', issues: result.error.issues }, 400)
  }
  const payload = result.data

  // (7) Persist deployment metadata. task_id FK is NOT NULL, so we lazily
  // ensure a per-user internal "deployment" task row and attach runs to it.
  const taskId = await ensureInternalDeploymentTask(userId)
  const status: 'pending' | 'success' =
    payload.event === 'deployment.failed' ? 'pending' : 'success'

  const run = await insertDeploymentRun({
    task_id: taskId,
    user_id: userId,
    status,
    deployment_uuid: payload.deployment_uuid,
    application_uuid: payload.application_uuid,
    git_repository: payload.git_repository ?? null,
    commit_sha: payload.commit_sha ?? null,
  })

  if (payload.event === 'deployment.failed') {
    // Fire-and-forget — webhook responds 202 immediately. Triage failures
    // surface in scheduled_task_runs and the WS run-finished broadcast.
    void dispatchTriage(userId, run.id, payload).catch((err: any) => {
      console.warn('[coolify-webhook] triage dispatch failed:', err?.message)
    })
  }

  // (8) Accepted.
  return c.json({ ok: true, run_id: run.id }, 202)
})

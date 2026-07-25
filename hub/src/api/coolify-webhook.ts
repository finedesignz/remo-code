/**
 * Coolify deployment webhook ingress.
 *
 * Two authentication paths:
 *
 * (A) URL-path token (primary, post-fix/coolify-webhook-url-token):
 *       POST /api/coolify/webhook/:user_id/:token
 *     `token` IS the `users.coolify_webhook_secret` UUID. Constant-time
 *     compared. This matches Coolify's actual webhook UI which only exposes
 *     a single URL field — no headers, no signing.
 *
 * (B) Legacy HMAC (deprecated, kept 30 days):
 *       POST /api/coolify/webhook/:user_id
 *     Verifies `X-Coolify-Signature: sha256=<hex>` HMAC over `${ts}.${rawBody}`
 *     with 5-min skew window. Returns 200/202 with `Deprecation: true` header
 *     + a warning log. Existing pre-fix integrations keep working until the
 *     user re-rotates to get the new URL.
 *
 * Common pipeline after auth:
 *   1. Optional IP allowlist check (users.coolify_webhook_allowed_ips).
 *   2. Zod-validate payload.
 *   3. Insert scheduled_task_runs row with deployment metadata.
 *   4. On deployment.failed → fire-and-forget triage dispatch.
 *   5. Record an audit row in coolify_webhook_attempts (every hit, even fails).
 *   6. Respond 202 { ok, run_id }.
 *
 * Audit row policy:
 *   - SUCCESS rows include the inserted run_id (via reason field).
 *   - AUTH-FAIL rows record the failed path so users can see "wrong token"
 *     hits in the UI rather than silence.
 *   - We NEVER store the wrong token or the full body — preview only.
 */
import { Hono } from 'hono'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import {
  getUserCoolifyWebhookSecret,
  getUserCoolifyWebhookConfig,
  ensureInternalDeploymentTask,
  ensureInternalTriageTask,
  insertDeploymentRun,
  recordCoolifyWebhookAttempt,
  markUserCoolifyWebhookLegacyHit,
  claimDeployFailure,
} from '../db/dal.ts'
import { runNow as dispatcherRunNow, finalizeRun } from '../scheduler/dispatcher.ts'
import { deployFailureFingerprint, DEPLOY_DEDUPE_WINDOW_MS } from '../scheduler/deploy-fingerprint.ts'
import { hasActiveSessionForRepo, resolveRepoKeyedAgentSession } from '../sessions/repo-routing.ts'
import { listOnlineAgentSessionsForUser } from '../ws/registry.ts'
import { ipAllowed, sourceIpFromHeaders } from '../lib/cidr.ts'

export const coolifyWebhookRoutes = new Hono()

const SKEW_SECONDS = 300

/**
 * Coolify's `SendWebhookJob` emits underscore event names (`deployment_success`,
 * `deployment_failed`), not the dotted form. Older docs/examples use dotted.
 * Accept both at the wire and normalize to the dotted form internally so the
 * rest of the pipeline (status mapping, triage gating) keeps one canonical shape.
 */
const DOTTED_EVENT = z.enum(['deployment.failed', 'deployment.succeeded', 'deployment.in_progress'])
type DottedEvent = z.infer<typeof DOTTED_EVENT>

const EVENT_ALIAS: Record<string, DottedEvent> = {
  'deployment.failed': 'deployment.failed',
  'deployment.succeeded': 'deployment.succeeded',
  'deployment.in_progress': 'deployment.in_progress',
  // Coolify SendWebhookJob underscore forms:
  deployment_failed: 'deployment.failed',
  deployment_success: 'deployment.succeeded',
  deployment_succeeded: 'deployment.succeeded',
  deployment_in_progress: 'deployment.in_progress',
}

/**
 * Coolify emits NON-deployment events too — notably `task_failed` / `task_success`
 * for its per-application scheduled-task (cron command) feature. These ride the
 * SAME webhook channel as deployments but carry a different body shape (no
 * `deployment_uuid` / `application_uuid` in the deployment sense) and are NOT a
 * deploy-failure signal, so they must never trigger deploy triage.
 *
 * We RECOGNIZE them explicitly so a well-formed event is recorded as `ignored`
 * (with its event type) instead of dropped as `bad_payload` just because we
 * don't model its type. Both underscore and dotted forms are accepted.
 */
const RECOGNIZED_NON_DEPLOY_EVENTS = new Set<string>([
  'task_failed',
  'task.failed',
  'task_success',
  'task.success',
  'task_succeeded',
  'task.succeeded',
])

const CoolifyWebhookPayload = z
  .object({
    event: z
      .string()
      .min(1)
      .transform((s, ctx) => {
        const mapped = EVENT_ALIAS[s]
        if (!mapped) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `unsupported_event: ${s}` })
          return z.NEVER
        }
        return mapped
      }),
    deployment_uuid: z.string().min(1),
    application_uuid: z.string().min(1),
    git_repository: z.string().optional(),
    commit_sha: z.string().optional(),
  })
  // Tolerate unknown/extra fields Coolify may add — a deploy event with a
  // slightly richer shape must not hard-fail on strictness.
  .passthrough()

export type CoolifyWebhookPayload = z.infer<typeof CoolifyWebhookPayload>

export async function dispatchTriage(
  userId: string,
  deploymentRunId: string,
  payload: CoolifyWebhookPayload,
): Promise<void> {
  // auto-dev P5: storm dedupe. A crash-looping app can emit dozens of
  // `deployment.failed` events; collapse them to ONE fix per
  // (user, application_uuid, fingerprint) window. The first failure claims the
  // fingerprint and dispatches; repeats inside the window lose the claim and are
  // dropped. Fail-open on a claim error (better a dup fix than a silent miss).
  try {
    const fpInput = {
      application_uuid: payload.application_uuid,
      git_repository: payload.git_repository,
      commit_sha: payload.commit_sha,
    }
    const now = Date.now()
    const fingerprint = deployFailureFingerprint(fpInput, now)
    // Previous-bucket fingerprint: collapses a storm that straddles a 15-min
    // bucket boundary (otherwise the new bucket would re-dispatch).
    const prevFingerprint = deployFailureFingerprint(fpInput, now - DEPLOY_DEDUPE_WINDOW_MS)
    const claimed = await claimDeployFailure(
      userId,
      payload.application_uuid,
      fingerprint,
      prevFingerprint,
    )
    if (!claimed) {
      console.info(
        `[coolify-webhook] storm dedupe: dropped duplicate deploy-failure app=${payload.application_uuid} fp=${fingerprint.slice(0, 12)}`,
      )
      return
    }
  } catch (err: any) {
    console.warn(`[coolify-webhook] deploy-failure claim errored (fail-open): ${err?.message}`)
  }

  // Orphan-run finalize. The deployment metadata run (`deploymentRunId`) was
  // inserted as `pending` (NULL session_id) and is NEVER finalized by the triage
  // path. When the deploy failure is UN-ROUTABLE — no session bound to the repo
  // (resolved via git_repository OR the application_uuid→repo_key cache) with a
  // live socket, AND no online agent / supervisor to capacity-route to — a
  // dispatched triage would just self-finalize `no_target_available` while this
  // metadata row sits `pending` forever (the at_capacity orphan-run leak). So we
  // close it cleanly here and skip the doomed dispatch.
  //
  // Semantics: `skipped` / `no_routable_session` (not `failed`) — an un-routable
  // deploy failure is a no-op, not a triage failure; this matches the existing
  // metadata-skip semantics (log_check `no_errors_detected`) and won't fire
  // `on:'success'` post-run chains. Best-effort + fail-open: any error in the
  // routability probe falls through to dispatch-anyway (never silently drops).
  try {
    const repoKeyed = await resolveRepoKeyedAgentSession(
      userId,
      payload.git_repository,
      payload.application_uuid,
    )
    if (!repoKeyed) {
      // Local-agent sessions ONLY: triage no longer supervisor-spawns (see
      // scheduler/senders/triage.ts header), so an online supervisor with no
      // agent session is NOT a routable triage target.
      const hasLiveTarget = listOnlineAgentSessionsForUser(userId).length > 0
      if (!hasLiveTarget) {
        await finalizeRun(deploymentRunId, 'skipped', 'no_routable_session')
        console.info(
          `[coolify-webhook] un-routable deploy failure app=${payload.application_uuid} — finalized metadata run=${deploymentRunId} as skipped/no_routable_session`,
        )
        return
      }
    }
  } catch (err: any) {
    console.warn(
      `[coolify-webhook] orphan-run routability probe errored (fail-open, dispatching): ${err?.message}`,
    )
  }

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

// Back-compat export.
export const dispatchTriageStub = dispatchTriage

function constantTimeEqualStr(a: string, b: string): boolean {
  const aBuf = Buffer.from(a)
  const bBuf = Buffer.from(b)
  if (aBuf.length !== bBuf.length) return false
  return timingSafeEqual(aBuf, bBuf)
}

/**
 * Best-effort attempt logger. Wrapped in try/catch so a logging failure
 * never breaks the webhook response path.
 */
async function logAttempt(
  userId: string,
  sourceIp: string | null,
  eventType: string | null,
  status: Parameters<typeof recordCoolifyWebhookAttempt>[0]['status'],
  reason: string | null,
  rawBodyPreview: string | null,
): Promise<void> {
  try {
    await recordCoolifyWebhookAttempt({
      user_id: userId,
      source_ip: sourceIp,
      event_type: eventType,
      status,
      reason,
      raw_body_preview: rawBodyPreview,
    })
  } catch (err: any) {
    console.warn('[coolify-webhook] audit log failed:', err?.message)
  }
}

/**
 * Shared post-auth pipeline — payload validate → optional IP gate →
 * persist run → optional triage → audit row.
 *
 * `legacy` only affects logging (so we can see HMAC traffic distinctly)
 * and the response header. `sourceIp` is the canonical IP we'll allowlist-check.
 */
async function handleAuthenticated(opts: {
  userId: string
  rawBody: string
  sourceIp: string | null
  allowedIps: string[]
  autoTriageEnabled: boolean
  legacy: boolean
}) {
  const { userId, rawBody, sourceIp, allowedIps, autoTriageEnabled, legacy } = opts
  const preview = rawBody.slice(0, 500)

  // (1) IP allowlist (only if user has configured one).
  if (allowedIps.length > 0 && !ipAllowed(sourceIp, allowedIps)) {
    await logAttempt(userId, sourceIp, null, 'ip_rejected', 'source_ip_not_in_allowlist', preview)
    return { status: 403 as const, body: { error: 'ip_not_allowed' } }
  }

  // (2) Validate payload.
  let parsedBody: unknown
  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    await logAttempt(userId, sourceIp, null, 'bad_payload', 'invalid_json', preview)
    return { status: 400 as const, body: { error: 'bad_json' } }
  }

  // (2a) Test ping — Coolify sends this when user clicks "Send Test Notification".
  // Shape: { success: true, message: "...", event: "test", url: "..." }
  // No run inserted, no triage. Just audit + 200.
  if (typeof parsedBody === 'object' && parsedBody !== null && (parsedBody as any).event === 'test') {
    await logAttempt(userId, sourceIp, 'test', 'success', 'test_ok', preview)
    return { status: 200 as const, body: { ok: true, message: 'test received' } }
  }

  // (2b) Recognized non-deployment event (e.g. `task_failed` — a Coolify
  // scheduled-command failure, NOT a deploy failure). Accept + audit as
  // `ignored` with its event type; insert no run and dispatch no triage. This
  // keeps a well-formed Coolify event from landing as `bad_payload` just
  // because we don't model its type.
  const rawEvent =
    typeof (parsedBody as any)?.event === 'string' ? (parsedBody as any).event : null
  if (rawEvent && RECOGNIZED_NON_DEPLOY_EVENTS.has(rawEvent)) {
    await logAttempt(userId, sourceIp, rawEvent, 'ignored', 'non_deploy_event', preview)
    return { status: 200 as const, body: { ok: true, ignored: true, event: rawEvent } }
  }

  const result = CoolifyWebhookPayload.safeParse(parsedBody)
  if (!result.success) {
    const eventType = typeof (parsedBody as any)?.event === 'string' ? (parsedBody as any).event : null
    await logAttempt(userId, sourceIp, eventType, 'bad_payload', 'schema_validation_failed', preview)
    return { status: 400 as const, body: { error: 'bad_payload', issues: result.error.issues } }
  }
  const payload = result.data

  // (3) Persist deployment metadata row.
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

  // (4) Triage on failed deploys — gated by the master switch + active-session
  // suppression. `triageDisposition` is folded into the audit reason at (5).
  let triageDisposition = `run_id=${run.id}`
  if (payload.event === 'deployment.failed') {
    if (!autoTriageEnabled) {
      // (4a) Master switch OFF — persist metadata, skip triage entirely.
      triageDisposition = `run_id=${run.id} skipped=auto_triage_disabled`
      console.info(
        `[coolify-webhook] auto-triage disabled for user=${userId} app=${payload.application_uuid} — skipping dispatch`,
      )
    } else {
      // (4b) Active-session suppression — if a dev already has a LIVE session on
      // this repo, they're working + monitoring; don't interrupt with triage.
      // Fail-open: the try/catch below catches any lookup error and leaves
      // `suppress=false`, so a lookup failure dispatches triage anyway (never
      // silently drops it).
      let suppress = false
      try {
        suppress = await hasActiveSessionForRepo(userId, payload.git_repository)
      } catch (err: any) {
        console.warn(
          `[coolify-webhook] active-session lookup errored (fail-open, dispatching): ${err?.message}`,
        )
      }
      if (suppress) {
        triageDisposition = `run_id=${run.id} skipped=suppressed_active_dev_session`
        console.info(
          `[coolify-webhook] active dev session on repo=${payload.git_repository} — suppressing triage for app=${payload.application_uuid}`,
        )
      } else {
        void dispatchTriage(userId, run.id, payload).catch((err: any) => {
          console.warn('[coolify-webhook] triage dispatch failed:', err?.message)
        })
      }
    }
  }

  // (5) Audit row — success. Reason carries the run_id (+ any triage skip reason)
  // for UI cross-ref.
  await logAttempt(
    userId,
    sourceIp,
    payload.event,
    legacy ? 'legacy_hmac' : 'success',
    triageDisposition,
    preview,
  )

  return { status: 202 as const, body: { ok: true, run_id: run.id }, legacy }
}

// ── (A) Primary route: URL-path token ───────────────────────────────────────

coolifyWebhookRoutes.post('/webhook/:user_id/:token', async (c) => {
  const userId = c.req.param('user_id')
  const token = c.req.param('token')
  const rawBody = await c.req.text()
  const sourceIp = sourceIpFromHeaders({
    get: (n: string) => c.req.header(n) ?? null,
  })

  // Look up config (secret + allowlist) in one round-trip.
  const cfg = await getUserCoolifyWebhookConfig(userId).catch(() => ({
    secret: null,
    allowedIps: [] as string[],
    autoTriageEnabled: true,
  }))

  // Constant-time compare. Always run compare against a dummy when missing
  // so timing reveals neither "user not found" nor "no secret set".
  const expected = cfg.secret ?? '00000000-0000-0000-0000-000000000000'
  const match = constantTimeEqualStr(token, expected)
  if (!cfg.secret || !match) {
    await logAttempt(
      userId,
      sourceIp,
      null,
      'auth_failed',
      cfg.secret ? 'token_mismatch' : 'webhook_not_configured',
      rawBody.slice(0, 500),
    )
    // Identical response shape regardless of cause — no enumeration.
    return c.json({ error: 'unauthorized' }, 401)
  }

  const result = await handleAuthenticated({
    userId,
    rawBody,
    sourceIp,
    allowedIps: cfg.allowedIps,
    autoTriageEnabled: cfg.autoTriageEnabled,
    legacy: false,
  })
  return c.json(result.body, result.status)
})

// ── (B) Legacy HMAC route — DEPRECATED, kept 30 days ────────────────────────

coolifyWebhookRoutes.post('/webhook/:user_id', async (c) => {
  const userId = c.req.param('user_id')
  const rawBody = await c.req.text()
  const sourceIp = sourceIpFromHeaders({
    get: (n: string) => c.req.header(n) ?? null,
  })

  console.warn(
    '[coolify-webhook] DEPRECATED legacy HMAC route hit by user',
    userId,
    '— ask user to re-rotate to migrate to URL-token auth.',
  )
  c.header('Deprecation', 'true')
  c.header('Sunset', new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString())
  c.header('Link', '</docs/coolify-webhook-migration.md>; rel="deprecation"')

  const sigHeader = c.req.header('x-coolify-signature')
  const tsHeader = c.req.header('x-coolify-timestamp')
  if (!sigHeader || !tsHeader) {
    await logAttempt(userId, sourceIp, null, 'auth_failed', 'legacy_missing_signature', rawBody.slice(0, 500))
    return c.json({ error: 'missing_signature' }, 401)
  }

  const ts = Number(tsHeader)
  if (!Number.isFinite(ts)) {
    await logAttempt(userId, sourceIp, null, 'auth_failed', 'legacy_bad_timestamp', rawBody.slice(0, 500))
    return c.json({ error: 'bad_timestamp' }, 401)
  }
  const nowSec = Math.floor(Date.now() / 1000)
  if (Math.abs(nowSec - ts) > SKEW_SECONDS) {
    await logAttempt(userId, sourceIp, null, 'auth_failed', 'legacy_stale_timestamp', rawBody.slice(0, 500))
    return c.json({ error: 'stale_timestamp' }, 401)
  }

  const secret = await getUserCoolifyWebhookSecret(userId)
  if (!secret) {
    await logAttempt(userId, sourceIp, null, 'auth_failed', 'webhook_not_configured', rawBody.slice(0, 500))
    return c.json({ error: 'webhook_not_configured' }, 401)
  }

  const expected = 'sha256=' + createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')
  if (!constantTimeEqualStr(sigHeader, expected)) {
    await logAttempt(userId, sourceIp, null, 'auth_failed', 'legacy_bad_signature', rawBody.slice(0, 500))
    return c.json({ error: 'bad_signature' }, 401)
  }

  // Allowlist on legacy too — same defense-in-depth applies.
  const cfg = await getUserCoolifyWebhookConfig(userId).catch(() => ({
    secret,
    allowedIps: [] as string[],
    autoTriageEnabled: true,
  }))

  // Flag user as still on the legacy HMAC format so the Settings UI can show
  // a "rotate to migrate" banner. Best-effort — never block the webhook.
  markUserCoolifyWebhookLegacyHit(userId).catch((err: any) => {
    console.warn('[coolify-webhook] failed to mark legacy-hit flag:', err?.message)
  })

  const result = await handleAuthenticated({
    userId,
    rawBody,
    sourceIp,
    allowedIps: cfg.allowedIps,
    autoTriageEnabled: cfg.autoTriageEnabled,
    legacy: true,
  })
  return c.json(result.body, result.status)
})

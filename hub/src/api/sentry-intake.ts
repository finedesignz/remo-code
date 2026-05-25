/**
 * Sentry-style error-intake (06-error-capture, Wave 1 shell).
 *
 * Public, unauthenticated at the network layer — the `sentry_key` carried in
 * the X-Sentry-Auth header IS the credential. Mounted at /api/sentry so it
 * sits OUTSIDE the JWT-auth catch-all on /api/* in `hub/src/index.ts`.
 *
 * Routes (Sentry DSN convention):
 *   POST /api/sentry/:project_id/envelope/  — envelope endpoint
 *   POST /api/sentry/:project_id/store/     — legacy "store" endpoint variant
 * Both point at the same handler.
 *
 * W1 SHELL: validates the sentry_key against `error_projects.sentry_key`,
 * confirms project enabled, returns 202. Envelope decoding, fingerprinting,
 * dedupe/rate-limit/cap gating, and dispatch to the agent socket all land
 * in W2 — see the TODO marker in the handler.
 */
import { Hono } from 'hono'
import { extractSentryKey } from '../error-capture/auth.ts'
import { getErrorProjectBySentryKey } from '../db/error-capture-dal.ts'

export const sentryIntake = new Hono()

async function handleIntake(c: any) {
  const projectId = c.req.param('project_id')

  // Parse credential out of X-Sentry-Auth (header) or ?sentry_key= (legacy SDK fallback).
  const authHeader = c.req.header('x-sentry-auth') ?? undefined
  const queryKey = c.req.query('sentry_key') ?? undefined
  const key = extractSentryKey(authHeader, queryKey)
  if (!key) return c.json({ error: 'missing_sentry_key' }, 401)

  const project = await getErrorProjectBySentryKey(key)
  if (!project) return c.json({ error: 'bad_sentry_key' }, 401)
  if (project.id !== projectId) return c.json({ error: 'project_mismatch' }, 401)
  if (!project.enabled) return c.json({ error: 'project_disabled' }, 403)

  // Body is gzipped multi-line JSON. Pulled here as bytes so it's available
  // to the W2 decoder without re-reading the stream. (Not used by the shell.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _body = await c.req.arrayBuffer()

  // TODO(W2): decode envelope with parseEnvelope(), map first 'event' item to
  // {type, value, stack, release}, compute fingerprint(), gate on dedupe →
  // rate-limit → daily cap, insertError(), and on accept dispatch a
  // user_message to `project.session_id` through the existing agent socket
  // path (reuse `hub/src/scheduler/session-queue.ts` for 1-in-flight + 1-waiter).

  return c.json({ ok: true, project_id: project.id }, 202)
}

sentryIntake.post('/:project_id/envelope/', handleIntake)
sentryIntake.post('/:project_id/store/', handleIntake)

/**
 * Sentry-style error-intake (06-error-capture, Wave 2).
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
 * W2: decodes the gzipped envelope, extracts the first exception, computes
 * a fingerprint, and delegates to `recordError` for dedupe/rate-limit/cap
 * gating. Non-exception envelopes (transactions, sessions, etc.) are
 * acknowledged but ignored. Dispatch into the target Claude session
 * lands in W3.
 */
import { Hono } from 'hono'
import { extractSentryKey } from '../error-capture/auth.ts'
import { parseEnvelope } from '../error-capture/envelope.ts'
import { fingerprint } from '../error-capture/fingerprint.ts'
import { recordError } from '../error-capture/record.ts'
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

  // Decode the envelope. Body is gzipped multi-line JSON; parseEnvelope handles
  // both gzip and identity encodings via the content-encoding header.
  const arrayBuf = await c.req.arrayBuffer()
  const body = Buffer.from(arrayBuf)
  let parsed
  try {
    parsed = await parseEnvelope(body, {
      'content-encoding': c.req.header('content-encoding') ?? undefined,
    })
  } catch (err: any) {
    return c.json({ error: 'bad_envelope', detail: err?.message }, 400)
  }

  // Find the first event item with an exception. Sentry envelopes can carry
  // transactions, sessions, attachments, etc.; we ignore everything that
  // isn't a real error event.
  const eventItem = parsed.items.find(it => it.header?.type === 'event')
  const event = (eventItem?.payload ?? null) as any
  const firstExc = event?.exception?.values?.[0]
  if (!firstExc) {
    return c.json({ ok: true, ignored: 'non_exception' }, 202)
  }

  const errorType: string = firstExc.type ?? 'Error'
  const errorValue: string = firstExc.value ?? ''
  const frames = firstExc.stacktrace?.frames ?? []
  // Stringify the top frames for the fingerprint stack input. parseEnvelope
  // gives us raw frame objects from Sentry; we format `function (file:line)`.
  const stackForFingerprint = frames
    .slice()
    .reverse() // Sentry stores callee-first; we want top-of-stack-first
    .slice(0, 3)
    .map((f: any) => {
      const fn = f.function ?? '<anonymous>'
      const file = f.filename ?? f.abs_path ?? ''
      const line = f.lineno ?? ''
      return `  at ${fn} (${file}:${line})`
    })
    .join('\n')

  const fp = fingerprint(project.id, errorType, errorValue, stackForFingerprint)
  const release: string | null = event?.release ?? null

  // Delegate to the gating module. recordError persists the row, applies the
  // three gates, fires silent-skip emails on hit, and returns the resulting
  // dispatch_status. W3 will pick up rows that come back 'pending'.
  const result = await recordError(project, {
    fingerprint: fp,
    error_type: errorType,
    error_value: errorValue,
    stacktrace_json: frames,
    release,
  })

  return c.json(
    {
      ok: true,
      error_id: result.error_id,
      dispatch_status: result.dispatch_status,
      ...(result.skip_reason ? { skip_reason: result.skip_reason } : {}),
    },
    202,
  )
}

sentryIntake.post('/:project_id/envelope/', handleIntake)
sentryIntake.post('/:project_id/store/', handleIntake)

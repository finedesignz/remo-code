// hub/src/corch/aaf-events.ts
//
// CORCH-08 (CORCH-R5.5, R5.6): POST /api/corch-events/aaf - the receiver for AgentAutofix's signed PR-outcome
// events (sender: agentautofix CORCH-06 event outbox). Mounted BEFORE the /api/* auth catch-all: the HMAC is the
// credential, cookies and API keys never authenticate here.
//
// Auth envelope (runIntake, shared with the other public webhooks): raw body read once before any JSON parse,
// X-ZeroExposure-Signature = "sha256=" + HMAC-SHA256(secret, `${X-ZeroExposure-Timestamp}.${rawBody}`) compared
// in constant time, timestamp skew > 5 minutes rejected, every credential failure is the same uniform 401. There
// is no separate bearer credential: the signature IS the credential, so the "presented credential" slot is the
// configured secret itself (the compare is vacuous by construction) and the HMAC layer does the verification.
// REMO_CORCH_AAF_EVENT_SECRET unset => 503 and nothing is read, parsed or recorded.
//
// Business body: event fields are UNTRUSTED data. They are validated by a strict schema, used only as lookup keys
// (repo + head ref `corch/<work_item_id>` must match an enrolled item), and never echoed, logged or placed in a
// notification. Transitions (store.applyAafEvent, one transaction with the event_id dedupe):
//   pr.merged => done | pr.closed (unmerged) => blocked, never requeued | pr.failed => blocked + ONE notification
//   unknown / terminal item => 200, audited in corch_events, unchanged | replayed event_id => 200, no 2nd transition
// Each applied transition triggers one dispatch evaluation (a no-op while REMO_CORCH_ENABLED is OFF).

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { runIntake } from '../webhooks/intake.ts'
import { aafEventSecret, corchEnabled } from './flag.ts'
import { corchStore, type AafEventInput, type AafEventResult } from './store.ts'

export const AAF_EVENT_MAX_BODY_BYTES = 16 * 1024
export const AAF_EVENT_SIGNATURE_HEADER = 'x-zeroexposure-signature'
export const AAF_EVENT_TIMESTAMP_HEADER = 'x-zeroexposure-timestamp'
export const AAF_EVENT_ID_HEADER = 'x-zeroexposure-event-id'

const EventBody = z.object({
  event_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  event: z.enum(['pr.merged', 'pr.closed', 'pr.failed']),
  repo: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
  pr_number: z.number().int().positive().max(2_147_483_647).nullish(),
  head_ref: z.string().min(1).max(255),
})

export interface AafEventDeps {
  secret: () => string | null
  store: {
    applyAafEvent(e: AafEventInput): Promise<AafEventResult>
    claimAafNotify(eventId: string): Promise<{ userId: string; workItemId: string } | null>
    finishAafNotify(eventId: string, delivered: boolean): Promise<void>
  }
  /** One owner notification for a failed PR. Resolves true on a durable delivery. Never throws into the route. */
  notifyFailed: (userId: string, workItemId: string) => Promise<boolean>
  /** One dispatch evaluation for the owner (a no-op while the CORCH flag is OFF). */
  evaluate: (userId: string) => Promise<void>
}

const REAL_DEPS: AafEventDeps = {
  secret: aafEventSecret,
  store: corchStore,
  notifyFailed: async (userId, workItemId) => {
    const { fanOutNotify } = await import('../orchestrator/notify.ts')
    const r = await fanOutNotify({
      userId,
      sessionId: '',
      event: 'failure',
      level: 'blocking',
      // Identifiers only: never event text.
      detail: `CORCH work item ${workItemId}: its pull request failed (reported by AgentAutofix); the item is blocked and will not be requeued`,
      channels: ['telegram', 'email'],
    })
    // inapp is a live-socket broadcast that persists nothing: only email or telegram count as delivered.
    return r.delivered.includes('email') || r.delivered.includes('telegram')
  },
  evaluate: async (userId) => (await import('./dispatcher.ts')).evaluateUserNow(userId),
}

export function createAafEventRoutes(deps: AafEventDeps = REAL_DEPS): Hono {
  const app = new Hono()

  app.post(
    '/aaf',
    // Reject oversized bodies before anything reads them. Uniform, non-leaky.
    bodyLimit({ maxSize: AAF_EVENT_MAX_BODY_BYTES, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
    async (c) => {
      const secret = deps.secret()
      if (!secret) return c.json({ error: 'not_configured' }, 503)

      const gate = await runIntake(c, {
        credentialSource: 'header',
        resolveSecret: async () => ({ ownerId: null, presented: secret, secret }),
        verifyHmac: true,
        hmacHeader: AAF_EVENT_SIGNATURE_HEADER,
        hmacTimestampHeader: AAF_EVENT_TIMESTAMP_HEADER,
        skewSeconds: 300,
        // No audit on auth failure: a flood of bad signatures must not fill a table (IR-6).
      })
      if (!gate.ok) return c.json(gate.body, gate.status)

      let parsed: z.infer<typeof EventBody>
      try {
        parsed = EventBody.parse(JSON.parse(gate.rawBody))
      } catch {
        return c.json({ error: 'bad_request' }, 400)
      }
      // The delivery id header is stable across retries; when present it must agree with the signed body.
      const hdrId = c.req.header(AAF_EVENT_ID_HEADER)
      if (hdrId !== undefined && hdrId !== parsed.event_id) return c.json({ error: 'bad_request' }, 400)

      let result: AafEventResult
      try {
        result = await deps.store.applyAafEvent({
          eventId: parsed.event_id,
          event: parsed.event,
          repo: parsed.repo,
          headRef: parsed.head_ref,
          prNumber: parsed.pr_number ?? null,
        })
      } catch (err: any) {
        // Nothing was committed (one transaction): the sender retries with the same event_id.
        console.warn(`[corch] aaf event apply failed: ${err?.name ?? 'error'}`)
        return c.json({ error: 'internal_error' }, 500)
      }

      if (result.kind === 'unchanged') return c.json({ ok: true, status: 'ignored' })

      // pr.failed owner notification: durable intent in corch_events, claimed atomically so exactly one delivery
      // owns it. A delivery failure releases the claim and answers 503 so the sender retries the SAME event_id;
      // that retry is a "duplicate" which still reaches this claim and re-attempts the notification.
      let notifyFailed = false
      try {
        const claim = await deps.store.claimAafNotify(parsed.event_id)
        if (claim) {
          let delivered = false
          try {
            delivered = await deps.notifyFailed(claim.userId, claim.workItemId)
          } catch (err: any) {
            console.warn(`[corch] aaf pr.failed notification failed item=${claim.workItemId}: ${err?.name ?? 'error'}`)
          }
          await deps.store.finishAafNotify(parsed.event_id, delivered)
          if (!delivered) {
            console.warn(`[corch] aaf pr.failed notification undelivered item=${claim.workItemId}`)
            notifyFailed = true
          }
        }
      } catch (err: any) {
        console.warn(`[corch] aaf notify claim failed: ${err?.name ?? 'error'}`)
        notifyFailed = true
      }

      if (result.kind === 'transitioned' && corchEnabled()) {
        void deps.evaluate(result.userId).catch((err) => console.warn(`[corch] aaf evaluate trigger failed: ${err?.name ?? 'error'}`))
      }
      if (notifyFailed) return c.json({ error: 'notification_pending' }, 503)
      return c.json({ ok: true, status: result.kind === 'duplicate' ? 'duplicate' : 'applied' })
    },
  )

  return app
}

export const aafEventRoutes = createAafEventRoutes()

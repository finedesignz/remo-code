// CORCH-08 (CORCH-R5.5): the AAF event receiver's auth envelope + dedupe + non-leaky errors, with the store and
// notifier injected (NO mock.module). The transition SQL is proven on real Postgres in e2e/corch-aaf.e2e.test.ts.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test'
import { createHmac, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { verifyHmacSig } from '../src/webhooks/intake.ts'
import { createAafEventRoutes, AAF_EVENT_MAX_BODY_BYTES } from '../src/corch/aaf-events.ts'
import type { AafEventInput, AafEventResult } from '../src/corch/store.ts'

const SECRET = randomBytes(24).toString('hex')
const vector = JSON.parse(readFileSync(new URL('./fixtures/corch-event-signature-vector.json', import.meta.url), 'utf8'))

let applied: AafEventInput[] = []
let seen = new Set<string>()
let nextResult: AafEventResult | null = null
let nextNotify = false
// event_id -> notification state, mirroring corch_events.notify_state claim semantics
let notifyState = new Map<string, 'pending' | 'sending' | 'sent'>()
let storeThrows = false
let notified: Array<[string, string]> = []
let evaluated: string[] = []
let cancelled: string[] = []
let secret: string | null = SECRET

const deps = () => ({
  secret: () => secret,
  store: {
    async applyAafEvent(e: AafEventInput): Promise<AafEventResult> {
      if (storeThrows) throw new Error('db down: secret-ish detail')
      if (seen.has(e.eventId)) return { kind: 'duplicate' }
      seen.add(e.eventId)
      applied.push(e)
      const r = nextResult ?? { kind: 'transitioned', userId: 'u1', workItemId: 'w1', to: 'done', endedRunIds: [] }
      if (r.kind === 'transitioned' && nextNotify) notifyState.set(e.eventId, 'pending')
      return r
    },
    async claimAafNotify(eventId: string) {
      const st = notifyState.get(eventId)
      if (st === 'sending') return { kind: 'busy' as const }
      if (st !== 'pending') return { kind: 'none' as const }
      notifyState.set(eventId, 'sending')
      return { kind: 'claimed' as const, userId: 'u1', workItemId: 'w1', token: 'tok-' + eventId }
    },
    async finishAafNotify(eventId: string, token: string, delivered: boolean) {
      if (token !== 'tok-' + eventId || notifyState.get(eventId) !== 'sending') return
      notifyState.set(eventId, delivered ? 'sent' : 'pending')
    },
  },
  notifyFailed: async (u: string, w: string) => {
    notified.push([u, w])
    return true
  },
  evaluate: async (u: string) => {
    evaluated.push(u)
  },
  cancelRunSends: async (ids: string[]) => {
    cancelled.push(...ids)
  },
})

const sign = (ts: number, body: string, key = SECRET) => 'sha256=' + createHmac('sha256', key).update(`${ts}.${body}`).digest('hex')
const bodyOf = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    event_id: 'evt-0000000001',
    event: 'pr.merged',
    repo: 'acme/site',
    pr_number: 7,
    head_ref: 'corch/11111111-2222-4333-8444-555555555555',
    occurred_at: '2026-11-13T12:00:00.000Z',
    ...over,
  })
async function post(body: string, o: { ts?: number; sig?: string; key?: string; headers?: Record<string, string> } = {}) {
  const ts = o.ts ?? Math.floor(Date.now() / 1000)
  const app = createAafEventRoutes(deps() as any)
  return app.request('/aaf', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-zeroexposure-timestamp': String(ts),
      'x-zeroexposure-signature': o.sig ?? sign(ts, body, o.key),
      ...(o.headers ?? {}),
    },
    body,
  })
}

const savedFlag = process.env.REMO_CORCH_ENABLED
beforeEach(() => {
  applied = []
  seen = new Set()
  nextResult = null
  nextNotify = false
  notifyState = new Map()
  storeThrows = false
  notified = []
  evaluated = []
  cancelled = []
  secret = SECRET
  delete process.env.REMO_CORCH_ENABLED
})
afterEach(() => {
  setSystemTime()
  if (savedFlag === undefined) delete process.env.REMO_CORCH_ENABLED
  else process.env.REMO_CORCH_ENABLED = savedFlag
})

describe('shared CORCH-06 signature vector', () => {
  test('the hub verifier accepts the vector (hmac_key, timestamp . body)', () => {
    expect(verifyHmacSig(vector.hmac_key, String(vector.timestamp), vector.body, vector.signature)).toBe(true)
    expect(verifyHmacSig(vector.hmac_key, String(vector.timestamp), vector.body + ' ', vector.signature)).toBe(false)
    expect(verifyHmacSig(vector.hmac_key + 'x', String(vector.timestamp), vector.body, vector.signature)).toBe(false)
  })

  test('the receiver accepts the vector end to end at the vector timestamp', async () => {
    secret = vector.hmac_key
    setSystemTime(new Date(vector.timestamp * 1000))
    const res = await post(vector.body, { ts: vector.timestamp, sig: vector.signature })
    expect(res.status).toBe(200)
    expect(applied.length).toBe(1)
    expect(applied[0]!.eventId).toBe('11111111-2222-4333-8444-555555555555')
    expect(applied[0]!.event).toBe('pr.merged')
  })
})

describe('POST /api/corch-events/aaf receiver', () => {
  test('valid signature => 200 applied, one transition, one evaluation only when the flag is ON', async () => {
    const res = await post(bodyOf())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'applied' })
    expect(applied.length).toBe(1)
    expect(evaluated).toEqual([]) // flag OFF: no dispatch evaluation
    process.env.REMO_CORCH_ENABLED = '1'
    await post(bodyOf({ event_id: 'evt-0000000002' }))
    await new Promise((r) => setTimeout(r, 5))
    expect(evaluated).toEqual(['u1'])
  })

  test('secret unset => 503 and nothing is applied or recorded', async () => {
    secret = null
    const res = await post(bodyOf())
    expect(res.status).toBe(503)
    expect(applied.length).toBe(0)
    expect(seen.size).toBe(0)
  })

  test('bad signature and wrong key => uniform 401, nothing recorded, no detail leaked', async () => {
    const b = bodyOf()
    for (const res of [
      await post(b, { sig: 'sha256=' + '0'.repeat(64) }),
      await post(b, { key: 'some-other-secret' }),
      await post(b, { sig: 'garbage' }),
    ]) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
    expect(applied.length).toBe(0)
  })

  test('a body altered after signing fails the HMAC (raw bytes, not parsed-equal)', async () => {
    const b = bodyOf()
    const ts = Math.floor(Date.now() / 1000)
    const res = await post(b.replace('"pr_number":7', '"pr_number": 7'), { ts, sig: sign(ts, b) })
    expect(res.status).toBe(401)
    expect(applied.length).toBe(0)
  })

  test('missing signature or timestamp headers => the same uniform 401', async () => {
    const app = createAafEventRoutes(deps() as any)
    const b = bodyOf()
    const r1 = await app.request('/aaf', { method: 'POST', body: b })
    expect(r1.status).toBe(401)
    expect(await r1.json()).toEqual({ error: 'unauthorized' })
    const ts = Math.floor(Date.now() / 1000)
    const r2 = await app.request('/aaf', { method: 'POST', body: b, headers: { 'x-zeroexposure-signature': sign(ts, b) } })
    expect(r2.status).toBe(401)
  })

  test('timestamp skew over 5 minutes (past or future) => 401 even with a valid signature', async () => {
    const b = bodyOf()
    const now = Math.floor(Date.now() / 1000)
    for (const ts of [now - 301, now + 301]) {
      const res = await post(b, { ts })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'unauthorized' })
    }
    expect((await post(b, { ts: now - 290 })).status).toBe(200)
  })

  test('replayed event_id => 200 duplicate and the store applies nothing a second time', async () => {
    const b = bodyOf()
    expect((await post(b)).status).toBe(200)
    const again = await post(b)
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ ok: true, status: 'duplicate' })
    expect(applied.length).toBe(1)
    expect(evaluated).toEqual([])
  })

  test('an unknown or terminal item is 200 "ignored": no notification, no evaluation', async () => {
    process.env.REMO_CORCH_ENABLED = '1'
    nextResult = { kind: 'unchanged', reason: 'unknown_item' }
    const res = await post(bodyOf({ event: 'pr.failed' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: 'ignored' })
    await new Promise((r) => setTimeout(r, 5))
    expect(notified).toEqual([])
    expect(evaluated).toEqual([])
  })

  test('pr.failed transition sends exactly one notification (identifiers only), also across replays', async () => {
    nextResult = { kind: 'transitioned', userId: 'u1', workItemId: 'w1', to: 'blocked', endedRunIds: [] }
    nextNotify = true
    const b = bodyOf({ event: 'pr.failed' })
    expect((await post(b)).status).toBe(200)
    expect((await post(b)).status).toBe(200) // replay
    expect(notified).toEqual([['u1', 'w1']])
  })

  test('a failed notification is not lost: 503 now, the sender retry (same event_id) delivers it exactly once', async () => {
    nextResult = { kind: 'transitioned', userId: 'u1', workItemId: 'w1', to: 'blocked', endedRunIds: [] }
    nextNotify = true
    let fail = true
    const app = createAafEventRoutes({
      ...deps(),
      notifyFailed: async (u: string, w: string) => {
        if (fail) throw new Error('smtp down')
        notified.push([u, w])
        return true
      },
    } as any)
    const b = bodyOf({ event: 'pr.failed' })
    const call = () => {
      const ts = Math.floor(Date.now() / 1000)
      return app.request('/aaf', { method: 'POST', body: b, headers: { 'x-zeroexposure-timestamp': String(ts), 'x-zeroexposure-signature': sign(ts, b) } })
    }
    const first = await call()
    expect(first.status).toBe(503)
    expect(await first.json()).toEqual({ error: 'notification_pending' })
    expect(applied.length).toBe(1) // the transition itself was applied once
    fail = false
    const retry = await call()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toEqual({ ok: true, status: 'duplicate' })
    expect((await call()).status).toBe(200)
    expect(notified).toEqual([['u1', 'w1']])
    expect(applied.length).toBe(1)
  })

  test('a fresh claim held by another delivery is NOT a success: 503 busy until it finishes', async () => {
    nextResult = { kind: 'transitioned', userId: 'u1', workItemId: 'w1', to: 'blocked', endedRunIds: [] }
    nextNotify = true
    const b = bodyOf({ event: 'pr.failed' })
    expect((await post(b, {})).status).toBe(200) // first delivery sends and marks sent
    notifyState.set('evt-0000000001', 'sending') // a crashed/in-flight delivery holds the claim
    const res = await post(b)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'notification_pending' })
  })

  test('a transition that ended live runs cancels their in-process send guard exactly once', async () => {
    nextResult = { kind: 'transitioned', userId: 'u1', workItemId: 'w1', to: 'done', endedRunIds: ['run-1', 'run-2'] }
    expect((await post(bodyOf())).status).toBe(200)
    expect(cancelled).toEqual(['run-1', 'run-2'])
    await post(bodyOf()) // replay: nothing more to cancel
    expect(cancelled).toEqual(['run-1', 'run-2'])
  })

  test('send guards are cancelled BEFORE notification I/O (a slow channel leaves no dispatch window)', async () => {
    nextResult = { kind: 'transitioned', userId: 'u1', workItemId: 'w1', to: 'blocked', endedRunIds: ['run-9'] }
    nextNotify = true
    let cancelledAtNotify: string[] = []
    const app = createAafEventRoutes({
      ...deps(),
      notifyFailed: async () => {
        cancelledAtNotify = [...cancelled]
        return true
      },
    } as any)
    const b = bodyOf({ event: 'pr.failed' })
    const ts = Math.floor(Date.now() / 1000)
    const res = await app.request('/aaf', { method: 'POST', body: b, headers: { 'x-zeroexposure-timestamp': String(ts), 'x-zeroexposure-signature': sign(ts, b) } })
    expect(res.status).toBe(200)
    expect(cancelledAtNotify).toEqual(['run-9'])
  })

  test('an undelivered (false) notification also answers 503 so the sender retries', async () => {
    nextResult = { kind: 'transitioned', userId: 'u1', workItemId: 'w1', to: 'blocked', endedRunIds: [] }
    nextNotify = true
    const app = createAafEventRoutes({ ...deps(), notifyFailed: async () => false } as any)
    const b = bodyOf({ event: 'pr.failed' })
    const ts = Math.floor(Date.now() / 1000)
    const res = await app.request('/aaf', { method: 'POST', body: b, headers: { 'x-zeroexposure-timestamp': String(ts), 'x-zeroexposure-signature': sign(ts, b) } })
    expect(res.status).toBe(503)
  })

  test('malformed or invalid payloads => 400 bad_request, nothing echoed', async () => {
    for (const b of ['not json', JSON.stringify({ event: 'pr.merged' }), bodyOf({ event: 'pr.opened' }), bodyOf({ repo: '../../etc' }), bodyOf({ event_id: 'x' })]) {
      const res = await post(b)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'bad_request' })
    }
    expect(applied.length).toBe(0)
  })

  test('the X-ZeroExposure-Event-Id header must agree with the signed body when present', async () => {
    expect((await post(bodyOf(), { headers: { 'x-zeroexposure-event-id': 'evt-0000000001' } })).status).toBe(200)
    const res = await post(bodyOf({ event_id: 'evt-0000000009' }), { headers: { 'x-zeroexposure-event-id': 'evt-0000000001' } })
    expect(res.status).toBe(400)
  })

  test('oversized body => 413 before any parse', async () => {
    const big = bodyOf({ head_ref: 'corch/' + 'a'.repeat(AAF_EVENT_MAX_BODY_BYTES) })
    const res = await post(big)
    expect(res.status).toBe(413)
    expect(applied.length).toBe(0)
  })

  test('a store failure => 500 with a generic body (no detail), sender retries', async () => {
    storeThrows = true
    const res = await post(bodyOf())
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'internal_error' })
  })
})

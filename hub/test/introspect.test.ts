/**
 * B4: /healthz/deep + /metrics tests.
 *
 * Uses `createIntrospectApp(getToken)` factory to inject token directly —
 * never depends on the global `config` module. Bun's mock.module is sticky
 * across test files, so any approach that mocks `../src/config` here would
 * be polluted by sibling tests.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'

import { describe, test, expect, mock } from 'bun:test'
import { Hono } from 'hono'

mock.module('../src/db/postgres', () => {
  const tag = async (_strings: TemplateStringsArray, ..._args: any[]) => [] as any[]
  return { sql: tag }
})

// IMPORTANT: include ALL exports from ../src/sessions/budget so this mock
// doesn't strip exports that sibling test files depend on (Bun mock.module
// is sticky across files). Only getInFlightRunCount needs a stub value.
mock.module('../src/sessions/budget', () => ({
  getInFlightRunCount: async () => 7,
  reserveSessionSlot: async () => ({ ok: false, reason: 'mocked' }),
  releaseSessionSlot: async () => undefined,
  getCapacitySnapshot: async () => null,
}))

const { createIntrospectApp } = await import('../src/api/introspect')

const TOKEN = 'test-introspect-token-must-be-16-chars-or-more'

function mountWithToken(token: string): Hono {
  const a = new Hono()
  a.route('/', createIntrospectApp(() => token))
  return a
}

describe('introspect — bearer gating', () => {
  const app = mountWithToken(TOKEN)

  test('GET /healthz/deep without bearer → 401', async () => {
    const res = await app.request('/healthz/deep')
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toBe('missing_bearer')
  })

  test('GET /healthz/deep with wrong bearer → 401', async () => {
    const res = await app.request('/healthz/deep', {
      headers: { authorization: 'Bearer wrong-token-also-long-enough-here' },
    })
    expect(res.status).toBe(401)
    const body = await res.json() as any
    expect(body.error).toBe('invalid_bearer')
  })

  test('GET /metrics without bearer → 401', async () => {
    const res = await app.request('/metrics')
    expect(res.status).toBe(401)
  })

  test('GET /healthz/deep with valid bearer → 200 + expected shape', async () => {
    const res = await app.request('/healthz/deep', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect([200, 503]).toContain(res.status)
    const body = await res.json() as any
    expect(body).toHaveProperty('db')
    expect(body).toHaveProperty('redis')
    expect(body).toHaveProperty('titanium')
    expect(body).toHaveProperty('supervisors')
    expect(typeof body.db.latency_ms).toBe('number')
    expect(Array.isArray(body.supervisors)).toBe(true)
  })

  test('GET /metrics with valid bearer → 200 + Prometheus text', async () => {
    const res = await app.request('/metrics', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    const text = await res.text()
    expect(text).toContain('# HELP remo_session_runs_in_flight')
    expect(text).toContain('# TYPE remo_session_runs_in_flight gauge')
    expect(text).toContain('remo_session_runs_in_flight 7')
  })

  test('short token does not bypass', async () => {
    const res = await app.request('/healthz/deep', {
      headers: { authorization: 'Bearer short' },
    })
    expect(res.status).toBe(401)
  })
})

describe('introspect — unset token fails closed (503)', () => {
  const app = mountWithToken('')

  test('GET /metrics with bearer → 503 introspect_token_not_configured', async () => {
    const res = await app.request('/metrics', {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(503)
    const body = await res.json() as any
    expect(body.error).toBe('introspect_token_not_configured')
  })

  test('GET /healthz/deep without bearer → 503', async () => {
    const res = await app.request('/healthz/deep')
    expect(res.status).toBe(503)
  })
})

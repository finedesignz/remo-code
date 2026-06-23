/**
 * Endpoint tests for /api/account/coolify-webhook-secret (Phase 06 / Plan 005).
 *
 * Gated on REMO_E2E_DB_URL because it exercises the real Postgres DAL
 * (rotates UUID, reads back configured flag). Skips cleanly when unset.
 */

// Ensure config validation passes BEFORE importing anything that pulls
// config.ts (the account router → DAL → postgres → config).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
if (process.env.REMO_E2E_DB_URL) {
  process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL
}

import { describe, test, expect, beforeAll } from 'bun:test'
import { Hono } from 'hono'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

let app: Hono
let userId: string
let token: string
let unauthedApp: Hono

maybe('coolify-webhook-secret endpoints', () => {
  beforeAll(async () => {
    const { account } = await import('../src/api/account.ts')
    const { signJwt } = await import('../src/auth/jwt.ts')
    const { sql } = await import('../src/db/postgres.ts')

    // Ensure schema columns exist (idempotent; cheap).
    await sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`
    await sql`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        display_name TEXT,
        system_prompt TEXT,
        timezone TEXT,
        daily_cost_cap_usd NUMERIC(10,4),
        web_push_enabled BOOLEAN DEFAULT true,
        claude_global_md TEXT,
        codex_agents_md TEXT,
        codex_config_toml TEXT,
        coolify_webhook_secret TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `
    await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS coolify_webhook_secret TEXT`

    // Seed a fresh test user (unique email per run).
    const email = `webhook-secret-test-${Date.now()}@example.test`
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, password_hash, role)
      VALUES (${email}, ${'x'}, ${'user'})
      RETURNING id
    `
    userId = rows[0].id
    token = signJwt({ sub: userId, email, role: 'user' })

    app = new Hono()
    app.route('/api/account', account)

    // Bare app with no auth headers for 401 checks.
    unauthedApp = app
  })

  async function get(path: string, withAuth: boolean): Promise<Response> {
    const headers: Record<string, string> = {}
    if (withAuth) headers.Authorization = `Bearer ${token}`
    return app.request(path, { method: 'GET', headers })
  }
  async function post(path: string, withAuth: boolean): Promise<Response> {
    const headers: Record<string, string> = {}
    if (withAuth) headers.Authorization = `Bearer ${token}`
    return app.request(path, { method: 'POST', headers })
  }

  test('GET /api/account/coolify-webhook-secret without auth → 401', async () => {
    const res = await get('/api/account/coolify-webhook-secret', false)
    expect(res.status).toBe(401)
  })

  test('POST /api/account/coolify-webhook-secret/rotate without auth → 401', async () => {
    const res = await post('/api/account/coolify-webhook-secret/rotate', false)
    expect(res.status).toBe(401)
  })

  test('GET before any rotate → configured: false', async () => {
    const res = await get('/api/account/coolify-webhook-secret', true)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(false)
    expect(typeof body.webhook_url).toBe('string')
    expect(body.webhook_url).toContain(`/api/coolify/webhook/${userId}`)
    expect(body.secret).toBeUndefined()
  })

  test('First POST rotate → returns 36-char UUID secret + webhook_url', async () => {
    const res = await post('/api/account/coolify-webhook-secret/rotate', true)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.secret).toBe('string')
    expect(body.secret.length).toBe(36)
    // UUID v4 shape: 8-4-4-4-12 hex chars
    expect(body.secret).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    expect(typeof body.webhook_url).toBe('string')
    expect(body.webhook_url).toContain(`/api/coolify/webhook/${userId}`)
    // The rotate endpoint moved to the url_token auth model: the webhook_url
    // itself is the credential. The old HMAC header_format/timestamp_header
    // fields no longer exist on this response.
    expect(body.auth_mode).toBe('url_token')

    // Stash for next test.
    ;(globalThis as any).__first_secret__ = body.secret
  })

  test('Second POST rotate → returns a DIFFERENT secret', async () => {
    const first = (globalThis as any).__first_secret__ as string
    expect(first).toBeTruthy()
    const res = await post('/api/account/coolify-webhook-secret/rotate', true)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.secret).not.toBe(first)
    expect(body.secret.length).toBe(36)
  })

  test('GET after rotate → configured: true, no secret field', async () => {
    const res = await get('/api/account/coolify-webhook-secret', true)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.configured).toBe(true)
    expect(body.secret).toBeUndefined()
  })
})

// Always-on sanity test so bun test always reports something for this file.
describe('coolify-webhook-secret — harness sanity', () => {
  test('e2e gated on REMO_E2E_DB_URL', () => {
    expect(typeof HAS_TEST_DB).toBe('boolean')
    if (!HAS_TEST_DB) {
      console.log('[coolify-webhook-secret] REMO_E2E_DB_URL not set — endpoint tests SKIPPED.')
    }
  })
})

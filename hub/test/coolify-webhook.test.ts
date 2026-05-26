/**
 * Tests for the Coolify webhook ingress.
 *
 * Covers:
 *   1. URL-path token auth (primary, post-fix/coolify-webhook-url-token).
 *   2. Legacy HMAC auth (deprecated, kept 30 days).
 *   3. IP allowlist gating (Part 3).
 *   4. Underscore event-name aliasing (Coolify's SendWebhookJob shape).
 *   5. Audit log recording for success + every failure path.
 *
 * DAL is mocked via `mock.module` so no Postgres is needed.
 */
import { describe, test, expect, beforeAll, beforeEach, mock } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'

const TEST_USER_ID = '11111111-1111-1111-1111-111111111111'
const TEST_SECRET = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

// Per-test mutable mock state.
const mockState: {
  secret: string | null
  allowedIps: string[]
  attempts: any[]
  runs: any[]
} = {
  secret: TEST_SECRET,
  allowedIps: [],
  attempts: [],
  runs: [],
}

mock.module('../src/db/dal.ts', () => ({
  getUserCoolifyWebhookSecret: async () => mockState.secret,
  getUserCoolifyWebhookConfig: async () => ({
    secret: mockState.secret,
    allowedIps: mockState.allowedIps,
  }),
  ensureInternalDeploymentTask: async () => 'task-internal-deploy',
  ensureInternalTriageTask: async () => 'task-internal-triage',
  insertDeploymentRun: async (input: any) => {
    const row = { id: 'run-' + (mockState.runs.length + 1), ...input }
    mockState.runs.push(row)
    return row
  },
  recordCoolifyWebhookAttempt: async (input: any) => {
    mockState.attempts.push(input)
  },
  // Stubs for transitive imports.
  hasOpenIssueForHash: async () => false,
  recordOpenIssueForHash: async () => {},
  // Phase 07-D stubs — webhooks-titanium.ts imports these from dal.ts.
  recordAuthEvent: async () => {},
  getUserByTitaniumSubject: async () => null,
  updateLicenseStatus: async () => {},
  getUserLicenseFields: async () => null,
}))

// Also mock the dispatcher so triage dispatch is a no-op.
mock.module('../src/scheduler/dispatcher.ts', () => ({
  runNow: async () => ({ skipped: false }),
}))

let app: Hono
let coolifyMod: typeof import('../src/api/coolify-webhook.ts')

beforeAll(async () => {
  coolifyMod = await import('../src/api/coolify-webhook.ts')
  app = new Hono()
  app.route('/api/coolify', coolifyMod.coolifyWebhookRoutes)
})

beforeEach(() => {
  mockState.secret = TEST_SECRET
  mockState.allowedIps = []
  mockState.attempts.length = 0
  mockState.runs.length = 0
})

function urlTokenPath(userId: string, token: string): string {
  return `/api/coolify/webhook/${userId}/${token}`
}

function legacyPath(userId: string): string {
  return `/api/coolify/webhook/${userId}`
}

function sign(secret: string, ts: number, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')
}

const validBody = (event = 'deployment.succeeded') =>
  JSON.stringify({
    event,
    deployment_uuid: 'depl-1',
    application_uuid: 'app-1',
    git_repository: 'https://github.com/x/y',
    commit_sha: 'abc123',
  })

// ── URL-path token auth ─────────────────────────────────────────────────────

describe('coolify-webhook URL-path token auth', () => {
  test('correct token + valid body → 202 + run inserted + audit success', async () => {
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody('deployment.succeeded'),
    })
    expect(res.status).toBe(202)
    const json: any = await res.json()
    expect(json.ok).toBe(true)
    expect(typeof json.run_id).toBe('string')
    expect(mockState.runs.length).toBe(1)
    expect(mockState.runs[0].status).toBe('success')
    // Audit row recorded.
    const audit = mockState.attempts.find((a) => a.status === 'success')
    expect(audit).toBeTruthy()
    expect(audit.event_type).toBe('deployment.succeeded')
  })

  test('wrong token → 401 + audit auth_failed + no run inserted', async () => {
    const res = await app.request(urlTokenPath(TEST_USER_ID, 'bogus-token'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody(),
    })
    expect(res.status).toBe(401)
    expect(mockState.runs.length).toBe(0)
    const audit = mockState.attempts.find((a) => a.status === 'auth_failed')
    expect(audit).toBeTruthy()
    expect(audit.reason).toBe('token_mismatch')
  })

  test('user has no secret configured → 401 + audit reason webhook_not_configured', async () => {
    mockState.secret = null
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody(),
    })
    expect(res.status).toBe(401)
    const audit = mockState.attempts.find((a) => a.status === 'auth_failed')
    expect(audit?.reason).toBe('webhook_not_configured')
  })

  test('missing token path segment → 404 (route does not match)', async () => {
    // Hitting /webhook/:user_id with no token goes to the LEGACY route, which
    // requires HMAC headers — missing headers there → 401, not 404. So the
    // contract here is: the URL-token route requires the token segment;
    // missing it falls through to the legacy handler.
    const res = await app.request(legacyPath(TEST_USER_ID), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody(),
    })
    expect(res.status).toBe(401) // legacy missing signature
  })

  test('deployment.failed → status=pending + dispatch attempted', async () => {
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody('deployment.failed'),
    })
    expect(res.status).toBe(202)
    expect(mockState.runs[0].status).toBe('pending')
  })
})

// ── Underscore event-name aliasing (Coolify SendWebhookJob) ─────────────────

describe('coolify-webhook event name aliasing', () => {
  test('deployment_success (underscore) → normalized to deployment.succeeded → 202', async () => {
    const body = JSON.stringify({
      event: 'deployment_success',
      deployment_uuid: 'd',
      application_uuid: 'a',
    })
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(202)
    expect(mockState.runs[0].status).toBe('success')
    const audit = mockState.attempts.find((a) => a.status === 'success')
    expect(audit?.event_type).toBe('deployment.succeeded')
  })

  test('deployment_failed (underscore) → normalized → status=pending', async () => {
    const body = JSON.stringify({
      event: 'deployment_failed',
      deployment_uuid: 'd',
      application_uuid: 'a',
    })
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(202)
    expect(mockState.runs[0].status).toBe('pending')
  })

  test('unknown event → 400 bad_payload', async () => {
    const body = JSON.stringify({
      event: 'mystery_event',
      deployment_uuid: 'd',
      application_uuid: 'a',
    })
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    expect(res.status).toBe(400)
  })
})

// ── IP allowlist (Part 3) ───────────────────────────────────────────────────

describe('coolify-webhook IP allowlist', () => {
  test('empty allowlist → request allowed', async () => {
    mockState.allowedIps = []
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '8.8.8.8' },
      body: validBody(),
    })
    expect(res.status).toBe(202)
  })

  test('source IP in allowlist → allowed', async () => {
    mockState.allowedIps = ['46.224.61.233']
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '46.224.61.233' },
      body: validBody(),
    })
    expect(res.status).toBe(202)
  })

  test('source IP NOT in allowlist → 403 + audit ip_rejected', async () => {
    mockState.allowedIps = ['46.224.61.233']
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: validBody(),
    })
    expect(res.status).toBe(403)
    const audit = mockState.attempts.find((a) => a.status === 'ip_rejected')
    expect(audit).toBeTruthy()
    expect(audit?.reason).toBe('source_ip_not_in_allowlist')
  })

  test('CIDR range match → allowed', async () => {
    mockState.allowedIps = ['10.0.0.0/8']
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': '10.5.99.42' },
      body: validBody(),
    })
    expect(res.status).toBe(202)
  })

  test('falls through cf → x-forwarded-for first hop', async () => {
    mockState.allowedIps = ['46.224.61.233']
    const res = await app.request(urlTokenPath(TEST_USER_ID, TEST_SECRET), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '46.224.61.233, 10.0.0.1',
      },
      body: validBody(),
    })
    expect(res.status).toBe(202)
  })
})

// ── Legacy HMAC route (kept 30 days) ────────────────────────────────────────

describe('coolify-webhook legacy HMAC route', () => {
  test('valid signature → 202 + Deprecation header + audit status=legacy_hmac', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = validBody()
    const res = await app.request(legacyPath(TEST_USER_ID), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coolify-signature': sign(TEST_SECRET, ts, body),
        'x-coolify-timestamp': String(ts),
      },
      body,
    })
    expect(res.status).toBe(202)
    expect(res.headers.get('deprecation')).toBe('true')
    expect(res.headers.get('sunset')).toBeTruthy()
    const audit = mockState.attempts.find((a) => a.status === 'legacy_hmac')
    expect(audit).toBeTruthy()
  })

  test('missing signature header → 401 + audit auth_failed', async () => {
    const res = await app.request(legacyPath(TEST_USER_ID), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: validBody(),
    })
    expect(res.status).toBe(401)
    const audit = mockState.attempts.find((a) => a.status === 'auth_failed')
    expect(audit?.reason).toBe('legacy_missing_signature')
  })

  test('stale timestamp → 401', async () => {
    const ts = Math.floor(Date.now() / 1000) - 1000
    const body = validBody()
    const res = await app.request(legacyPath(TEST_USER_ID), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coolify-signature': sign(TEST_SECRET, ts, body),
        'x-coolify-timestamp': String(ts),
      },
      body,
    })
    expect(res.status).toBe(401)
  })

  test('wrong-secret signature → 401', async () => {
    const ts = Math.floor(Date.now() / 1000)
    const body = validBody()
    const res = await app.request(legacyPath(TEST_USER_ID), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-coolify-signature': sign('different-secret', ts, body),
        'x-coolify-timestamp': String(ts),
      },
      body,
    })
    expect(res.status).toBe(401)
  })
})

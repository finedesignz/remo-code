/**
 * Agent auth-failure observability.
 *
 * Regression test for: silent agent auth failures (invalid api_key, or
 * project_dir + rootless_sessions both missing) leaving no diagnostic on the
 * hub — the only signal was `[agent] connection opened` with no follow-up,
 * which masquerades as a network blip. Now matches the supervisor-side
 * disambiguation pattern (`[agent] auth fail reason=...`).
 *
 * Gated on REMO_E2E_DB_URL so verifyApiKey can resolve. Skips cleanly when
 * unset like the rest of the DAL suites.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-32-chars-long-aaaaaaaa'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'session-secret-at-least-32-chars-long-x'
process.env.MAGIC_LINK_SECRET = process.env.MAGIC_LINK_SECRET || 'magic-link-secret-at-least-32-chars-x'
process.env.TITANIUM_KEYGEN_API_URL = process.env.TITANIUM_KEYGEN_API_URL || 'https://keygen.titaniumlabs.us'
process.env.TITANIUM_KEYGEN_ACCOUNT_ID = process.env.TITANIUM_KEYGEN_ACCOUNT_ID || 'acct_test_0000000000'
process.env.TITANIUM_KEYGEN_PRODUCT_ID = process.env.TITANIUM_KEYGEN_PRODUCT_ID || 'prod_test_remo'
if (process.env.REMO_E2E_DB_URL) process.env.DATABASE_URL = process.env.REMO_E2E_DB_URL

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'

const HAS_TEST_DB = !!process.env.REMO_E2E_DB_URL
const maybe = HAS_TEST_DB ? describe : describe.skip

// Minimal fake of bun's ServerWebSocket — captures sends + close calls and
// exposes the AgentWsData we need to assert against.
function makeFakeWs() {
  const sent: string[] = []
  const closes: Array<{ code: number; reason: string }> = []
  return {
    data: {
      authenticated: false,
      role: 'agent' as const,
      sessionId: null,
      supervisorId: null,
      userId: null,
      apiKeyId: null,
      authTimer: null,
      heartbeatTimer: null,
      messageCount: 0,
      windowStart: Date.now(),
    },
    send(s: string) { sent.push(s) },
    close(code: number, reason: string) { closes.push({ code, reason }) },
    _sent: sent,
    _closes: closes,
  }
}

maybe('agent auth surfaces structured log lines on failure', () => {
  let handleAgentMessage: typeof import('../src/ws/agent.ts')['handleAgentMessage']
  let warnings: string[] = []
  let origWarn: typeof console.warn

  beforeAll(async () => {
    const { runMigrations } = await import('../src/db/migrate.ts')
    await runMigrations()
    handleAgentMessage = (await import('../src/ws/agent.ts')).handleAgentMessage
  })

  afterAll(() => {
    if (origWarn) console.warn = origWarn
  })

  function captureWarn(fn: () => Promise<void>) {
    warnings = []
    origWarn = console.warn
    console.warn = (...a: any[]) => { warnings.push(a.map(String).join(' ')) }
    return fn().finally(() => {
      console.warn = origWarn
    })
  }

  test('invalid api_key emits structured warn (reason=invalid_api_key)', async () => {
    const ws = makeFakeWs()
    await captureWarn(async () => {
      await handleAgentMessage(ws as any, JSON.stringify({
        type: 'auth',
        api_key: 'definitely-not-a-real-key-' + Date.now(),
        project_dir: '/tmp/somewhere',
        hostname: 'testhost',
      }))
    })
    const hit = warnings.find((w) => w.includes('[agent] auth fail') && w.includes('reason=invalid_api_key'))
    expect(hit, `expected '[agent] auth fail reason=invalid_api_key' in warnings, got:\n${warnings.join('\n')}`).toBeDefined()
    // Auth_error frame is sent and connection closed with 4001.
    expect(ws._sent.some((s) => s.includes('auth_error'))).toBe(true)
    expect(ws._closes[0]?.code).toBe(4001)
    expect(ws.data.authenticated).toBe(false)
  })

  test('schema reject (no api_key) emits structured warn', async () => {
    const ws = makeFakeWs()
    await captureWarn(async () => {
      await handleAgentMessage(ws as any, JSON.stringify({
        type: 'auth',
        project_dir: '/tmp/x',
        // api_key intentionally missing
      }))
    })
    const hit = warnings.find((w) => w.includes('[agent] schema reject'))
    expect(hit, `expected '[agent] schema reject' in warnings, got:\n${warnings.join('\n')}`).toBeDefined()
  })
})

/**
 * POST /api/cloud-hook/reply — auth + validation contract (quick 20260927-cloud-sessions).
 * The DAL key lookup and the ingest side-effects are mocked; this pins who may post.
 */
import { describe, test, expect, mock, beforeEach } from 'bun:test'

let keyRow: { id: string; user_id: string; scopes: string[] | null; purpose: string } | null = null
const ingestCalls: any[] = []

const realDal = await import('../src/db/dal.ts')
mock.module('../src/db/dal.ts', () => ({ ...realDal, verifyApiKeyFull: async () => keyRow }))
mock.module('../src/cloud/ingest.ts', () => ({
  ingestCloudReply: async (input: any) => {
    ingestCalls.push(input)
    return { sessionId: 'sess-1', messageId: 'msg-1', linked: true }
  },
}))

const { default: cloudHook } = await import('../src/api/cloud-hook.ts')
const { normalizeCloudSessionId } = await import('../src/db/cloud-sessions-dal.ts')

const KEY = 'remokey_abcdefghijklmnop'
function post(body: unknown, auth: string | null = `Bearer ${KEY}`) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (auth) headers.authorization = auth
  return cloudHook.request('/reply', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) })
}
const good = { cloud_session_id: 'cse_01ABCdef', text: 'done', model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5 } }

beforeEach(() => {
  keyRow = { id: 'k1', user_id: 'u1', scopes: ['cloud:hook'], purpose: 'external' }
  ingestCalls.length = 0
})

describe('cloud-hook auth', () => {
  test('no bearer → 401', async () => {
    expect((await post(good, null)).status).toBe(401)
  })
  test('unknown key → 401', async () => {
    keyRow = null
    expect((await post(good)).status).toBe(401)
  })
  test('legacy NULL-scopes key is NOT enough → 403', async () => {
    keyRow = { id: 'k1', user_id: 'u1', scopes: null, purpose: 'supervisor' }
    expect((await post(good)).status).toBe(403)
    expect(ingestCalls.length).toBe(0)
  })
  test('ext:* key without cloud:hook → 403', async () => {
    keyRow = { id: 'k1', user_id: 'u1', scopes: ['ext:read', 'ext:ask'], purpose: 'external' }
    expect((await post(good)).status).toBe(403)
  })
})

describe('cloud-hook body', () => {
  test('valid → 202 and ingests for the key owner', async () => {
    const res = await post(good)
    expect(res.status).toBe(202)
    expect(ingestCalls[0]).toMatchObject({ userId: 'u1', cloudSessionId: 'cse_01ABCdef', text: 'done', model: 'claude-sonnet-5' })
  })
  test('bad cloud_session_id → 400', async () => {
    expect((await post({ ...good, cloud_session_id: '../etc' })).status).toBe(400)
  })
  test('empty text → 400', async () => {
    expect((await post({ ...good, text: '' })).status).toBe(400)
  })
  test('non-JSON → 400', async () => {
    expect((await post('not json')).status).toBe(400)
  })
  test('negative token counts → 400', async () => {
    expect((await post({ ...good, usage: { input_tokens: -1 } })).status).toBe(400)
  })
})

describe('normalizeCloudSessionId', () => {
  test('bare ids and claude.ai URLs', () => {
    expect(normalizeCloudSessionId('cse_01ABC')).toBe('cse_01ABC')
    expect(normalizeCloudSessionId('session_01XYZ')).toBe('session_01XYZ')
    expect(normalizeCloudSessionId('https://claude.ai/code/session_01XYZ?from=cli&m=0')).toBe('session_01XYZ')
    expect(normalizeCloudSessionId('claude.ai/code/cse_9')).toBe('cse_9')
  })
  test('rejects junk', () => {
    expect(normalizeCloudSessionId('')).toBeNull()
    expect(normalizeCloudSessionId('cse_; rm -rf /')).toBeNull()
    expect(normalizeCloudSessionId('https://evil.example/cse_1')).toBeNull()
  })
})

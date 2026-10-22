import { test, expect, mock, afterAll } from 'bun:test'

const updates: any[] = []
let secretReads = 0
const fetchBefore = globalThis.fetch
const fetchMock = mock(async () => new Response('', { status: 200 }))
globalThis.fetch = fetchMock as any
mock.module('../src/db/postgres.ts', () => ({
  sql: async () => [{ user_id: 'owner', callback_url: 'https://revanote.example/callback', status: 'archived' }],
}))
mock.module('../src/db/revanote-dal.ts', () => ({
  enqueueCallbackAttempt: async () => {},
  updateCallbackAttempt: async (_id: string, patch: any) => { updates.push(patch) },
  claimDueCallbackAttempts: async () => [{ id: 'attempt', annotation_id: 'obsolete', attempt_no: 0, payload_json: { resolved: false } }],
  getUserRevanoteWebhookSecret: async () => { secretReads++; return 'test-only-secret' },
}))
mock.module('../src/ws/registry.ts', () => ({ broadcastRevanoteEvent: () => {} }))
const { _internals } = await import('../src/revanote/callback.ts')
afterAll(() => { globalThis.fetch = fetchBefore; mock.restore() })

test('a previously claimed callback for archived work is terminal without HTTP', async () => {
  await _internals.tick()
  expect(fetchMock).toHaveBeenCalledTimes(0)
  expect(secretReads).toBe(0)
  expect(updates).toEqual([expect.objectContaining({
    delivered: false, dead: true, next_retry_at: null, error: 'annotation_archived',
  })])
})

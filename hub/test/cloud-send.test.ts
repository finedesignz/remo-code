/**
 * Cloud sessions — hub relay (hub/src/cloud/send.ts). Pins: caps run first and
 * block before any supervisor is contacted; transport failures fall through to the
 * next supervisor; a CLI rejection is final.
 */
import { describe, test, expect } from 'bun:test'
import { sendToCloudSession, type CloudSendDeps } from '../src/cloud/send.ts'

const req = { userId: 'u1', sessionId: 's1', cloudSessionId: 'cse_01ABC', content: 'hi', token: 'm1' }
const pass = { name: 'pass', check: async () => ({ ok: true as const }) }
const block = { name: 'daily_token_cap', check: async () => ({ ok: false as const, reason: 'over_daily_token_cap:9>=5' }) }

function deps(over: Partial<CloudSendDeps> & { calls?: any[] } = {}): CloudSendDeps & { calls: any[] } {
  const calls: any[] = over.calls ?? []
  return {
    gates: [pass],
    listSupervisors: () => ['sup-a'],
    request: async (id, msg) => { calls.push({ id, msg }); return { ok: true } },
    ...over,
    calls,
  }
}

describe('sendToCloudSession', () => {
  test('happy path sends the cloud_session.send frame', async () => {
    const d = deps()
    expect(await sendToCloudSession(req, d)).toEqual({ ok: true, supervisorId: 'sup-a' })
    expect(d.calls[0]).toEqual({ id: 'sup-a', msg: { type: 'cloud_session.send', cloud_session_id: 'cse_01ABC', content: 'hi' } })
  })
  test('a blocking cap gate stops the send before any supervisor call', async () => {
    const d = deps({ gates: [pass, block] })
    const r = await sendToCloudSession(req, d)
    expect(r).toEqual({ ok: false, error: 'gate_blocked', reason: 'over_daily_token_cap:9>=5' })
    expect(d.calls.length).toBe(0)
  })
  test('no supervisor online', async () => {
    const r = await sendToCloudSession(req, deps({ listSupervisors: () => [] }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('no_supervisor')
  })
  test('timeout on one supervisor falls through to the next', async () => {
    const calls: any[] = []
    const d = deps({
      calls,
      listSupervisors: () => ['old', 'new'],
      request: async (id) => { calls.push(id); if (id === 'old') throw new Error('supervisor request timed out'); return {} },
    })
    expect(await sendToCloudSession(req, d)).toEqual({ ok: true, supervisorId: 'new' })
    expect(calls).toEqual(['old', 'new'])
  })
  test('a CLI rejection is final (no retry on another host)', async () => {
    const calls: any[] = []
    const d = deps({
      calls,
      listSupervisors: () => ['a', 'b'],
      request: async (id) => { calls.push(id); throw new Error('Session not found: cse_01ABC') },
    })
    const r = await sendToCloudSession(req, d)
    expect(r).toEqual({ ok: false, error: 'cloud_send_failed', reason: 'Session not found: cse_01ABC' })
    expect(calls).toEqual(['a'])
  })
  test('malformed linked id never reaches a supervisor', async () => {
    const d = deps()
    const r = await sendToCloudSession({ ...req, cloudSessionId: 'nope' }, d)
    expect(r.ok).toBe(false)
    expect(d.calls.length).toBe(0)
  })
  test('default gate list carries BOTH the cost cap and the token cap', async () => {
    const { defaultCloudSendDeps } = await import('../src/cloud/send.ts')
    expect(defaultCloudSendDeps.gates.map((g) => g.name)).toEqual(['daily_cost_cap', 'daily_token_cap'])
  })
})

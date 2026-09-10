/**
 * milestone remote-update-trigger — supervisor.force_update_ack must parse on
 * the agent WS union so agent.ts can resolve the pending POST
 * /api/supervisors/:id/update request. Mirrors rescan-ack-protocol.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { AgentInbound } from '../src/ws/agent-protocol'
import { ForceUpdateAck } from '../src/ws/supervisor-protocol'

describe('supervisor.force_update_ack protocol', () => {
  test('ok ack parses on AgentInbound', () => {
    const r = AgentInbound.safeParse({ type: 'supervisor.force_update_ack', req_id: 'req_1', ok: true })
    expect(r.success).toBe(true)
  })
  test('nack ack with error parses', () => {
    const r = ForceUpdateAck.safeParse({ type: 'supervisor.force_update_ack', req_id: 'req_1', ok: false, error: 'marker_write_failed' })
    expect(r.success).toBe(true)
  })
  test('missing req_id rejected', () => {
    const r = ForceUpdateAck.safeParse({ type: 'supervisor.force_update_ack', ok: true })
    expect(r.success).toBe(false)
  })
})

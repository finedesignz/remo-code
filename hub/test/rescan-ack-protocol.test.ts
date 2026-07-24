/**
 * fix/supervisor-periodic-repo-rescan — supervisor.rescan_ack must parse on the
 * agent WS union so agent.ts can resolve the pending POST /scan request.
 */
import { describe, expect, test } from 'bun:test'
import { AgentInbound } from '../src/ws/agent-protocol'
import { RescanAck } from '../src/ws/supervisor-protocol'

describe('supervisor.rescan_ack protocol', () => {
  test('ok ack parses on AgentInbound', () => {
    const r = AgentInbound.safeParse({ type: 'supervisor.rescan_ack', req_id: 'req_1', ok: true })
    expect(r.success).toBe(true)
  })
  test('nack ack with error parses', () => {
    const r = RescanAck.safeParse({ type: 'supervisor.rescan_ack', req_id: 'req_1', ok: false, error: 'scan boom' })
    expect(r.success).toBe(true)
  })
  test('missing req_id rejected', () => {
    const r = RescanAck.safeParse({ type: 'supervisor.rescan_ack', ok: true })
    expect(r.success).toBe(false)
  })
})

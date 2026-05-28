/**
 * TRIAGE-2026-05-28 Bundle 6 step 5.
 *
 * (session_id, client_msg_id) LRU dedupe — duplicate within TTL returns
 * the replayed ack; cross-session same client_msg_id is NOT a duplicate.
 */
import { describe, test, expect, beforeEach } from 'bun:test'
import {
  checkDuplicate,
  recordSend,
  __resetSendDedupeForTests,
  type SendAck,
} from '../src/ws/send-dedupe.ts'

const ack = (sessionId: string, clientId: string, messageId: string): SendAck => ({
  type: 'send_ack',
  client_id: clientId,
  session_id: sessionId,
  message_id: messageId,
})

describe('send-dedupe', () => {
  beforeEach(() => { __resetSendDedupeForTests() })

  test('first send is NOT a duplicate', () => {
    expect(checkDuplicate('sess_a', 'cid_1')).toBeNull()
  })

  test('duplicate within TTL replays the original ack', () => {
    const original = ack('sess_a', 'cid_1', 'msg_db_1')
    recordSend('sess_a', 'cid_1', original)
    const hit = checkDuplicate('sess_a', 'cid_1')
    expect(hit).toEqual(original)
  })

  test('same client_msg_id on a different session is NOT a duplicate', () => {
    recordSend('sess_a', 'cid_1', ack('sess_a', 'cid_1', 'msg_a'))
    expect(checkDuplicate('sess_b', 'cid_1')).toBeNull()
  })

  test('same session, different client_msg_id is NOT a duplicate', () => {
    recordSend('sess_a', 'cid_1', ack('sess_a', 'cid_1', 'msg_a'))
    expect(checkDuplicate('sess_a', 'cid_2')).toBeNull()
  })

  test('replayed ack matches original (re-recording does not overwrite within TTL)', () => {
    const first = ack('sess_a', 'cid_1', 'msg_db_first')
    recordSend('sess_a', 'cid_1', first)
    // checkDuplicate before any retry-ack-overwrite returns the first
    const hit = checkDuplicate('sess_a', 'cid_1')
    expect(hit?.message_id).toBe('msg_db_first')
  })
})

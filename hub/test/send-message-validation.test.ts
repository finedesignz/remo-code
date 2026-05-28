/**
 * TRIAGE-2026-05-28 Bundle 6 step 4.
 *
 * ClientSendMessage.content must reject empty + whitespace-only payloads
 * (trim().min(1)) so the runner never gets handed a no-op prompt.
 */
import { describe, test, expect } from 'bun:test'
import { ClientSendMessage } from '../src/ws/protocol.ts'

const base = {
  type: 'send_message' as const,
  session_id: 'sess_abc',
  id: '00000000-0000-0000-0000-000000000001',
}

describe('ClientSendMessage.content validation', () => {
  test('rejects empty string', () => {
    const r = ClientSendMessage.safeParse({ ...base, content: '' })
    expect(r.success).toBe(false)
  })

  test('rejects whitespace-only', () => {
    const r = ClientSendMessage.safeParse({ ...base, content: '   \n\t  ' })
    expect(r.success).toBe(false)
  })

  test('accepts valid content', () => {
    const r = ClientSendMessage.safeParse({ ...base, content: 'hello world' })
    expect(r.success).toBe(true)
  })

  test('accepts content with surrounding whitespace (trimmed length >= 1)', () => {
    const r = ClientSendMessage.safeParse({ ...base, content: '  hi  ' })
    expect(r.success).toBe(true)
  })

  test('rejects > 1M chars', () => {
    const big = 'a'.repeat(1_000_001)
    const r = ClientSendMessage.safeParse({ ...base, content: big })
    expect(r.success).toBe(false)
  })
})

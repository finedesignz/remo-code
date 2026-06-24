/**
 * term.attach_file — schema + direction-allowlist contract.
 *
 * The browser uploads file bytes; the supervisor writes them to a host temp
 * file and types the path into the TUI. It is a client→PTY WRITE frame (gated
 * like term.input on the relay), never a server→client output frame.
 */
import { describe, test, expect } from 'bun:test'
import {
  TermFrame,
  TermAttachFile,
  isClientToHubTermType,
  isAgentToHubTermType,
} from '../src/ws/term-protocol'

describe('term.attach_file schema', () => {
  test('accepts a valid upload frame', () => {
    const r = TermFrame.safeParse({
      type: 'term.attach_file',
      session_id: 'sess-1',
      filename: 'screenshot.png',
      data_b64: Buffer.from('hello').toString('base64'),
    })
    expect(r.success).toBe(true)
  })

  test('rejects empty filename and over-long filename', () => {
    expect(TermAttachFile.safeParse({ type: 'term.attach_file', session_id: 's', filename: '', data_b64: 'AA==' }).success).toBe(false)
    expect(TermAttachFile.safeParse({ type: 'term.attach_file', session_id: 's', filename: 'x'.repeat(256), data_b64: 'AA==' }).success).toBe(false)
  })

  test('rejects payloads over the ~10MB cap', () => {
    const tooBig = 'A'.repeat(14_000_001)
    expect(TermAttachFile.safeParse({ type: 'term.attach_file', session_id: 's', filename: 'f', data_b64: tooBig }).success).toBe(false)
  })

  test('is a client→hub WRITE frame, never an agent→hub output frame', () => {
    expect(isClientToHubTermType('term.attach_file')).toBe(true)
    expect(isAgentToHubTermType('term.attach_file')).toBe(false)
  })
})

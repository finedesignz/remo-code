/**
 * term.attach_file filename sanitization.
 *
 * Uploaded names are attacker-influenced: they must never escape the per-session
 * temp dir (path separators, `..`, leading dots) or carry control chars. The
 * result is always a non-empty, bounded, conservative filename.
 */
import { describe, test, expect } from 'bun:test'
import { sanitizeAttachmentName } from '../src/runners/session-bridge'

describe('sanitizeAttachmentName', () => {
  test('strips path components and traversal', () => {
    expect(sanitizeAttachmentName('../../etc/passwd')).not.toContain('/')
    expect(sanitizeAttachmentName('../../etc/passwd')).not.toContain('..')
    expect(sanitizeAttachmentName('..\\..\\windows\\system32\\cmd.exe')).not.toContain('\\')
  })

  test('keeps a simple name + extension intact', () => {
    expect(sanitizeAttachmentName('screenshot.png')).toBe('screenshot.png')
    expect(sanitizeAttachmentName('My Report v2.PDF')).toBe('My_Report_v2.PDF')
  })

  test('never returns empty and bounds length', () => {
    expect(sanitizeAttachmentName('')).toBe('attachment')
    expect(sanitizeAttachmentName('...')).not.toBe('')
    expect(sanitizeAttachmentName('a'.repeat(500)).length).toBeLessThanOrEqual(200)
  })

  test('drops control characters and non-conservative chars', () => {
    const out = sanitizeAttachmentName('ev\x00\til.txt')
    expect(out).not.toMatch(/[\x00-\x1f]/)      // no control bytes
    expect(out).toMatch(/^[A-Za-z0-9._-]+$/)    // conservative charset only
  })
})

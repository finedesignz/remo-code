/**
 * Phase 12 W2 — supervisor root-path validation.
 *
 * Pure-unit; no DB, no env. Covers all rejection branches and the happy path.
 */
import { describe, expect, test } from 'bun:test'
import { validateRoots, isAbsolutePath } from '../src/lib/roots-validate'

describe('isAbsolutePath', () => {
  test('POSIX absolute', () => {
    expect(isAbsolutePath('/foo/bar')).toBe(true)
    expect(isAbsolutePath('/')).toBe(true)
  })
  test('Windows drive', () => {
    expect(isAbsolutePath('C:\\Users\\artic')).toBe(true)
    expect(isAbsolutePath('C:/Users/artic')).toBe(true)
    expect(isAbsolutePath('c:/foo')).toBe(true)
  })
  test('Windows UNC', () => {
    expect(isAbsolutePath('\\\\server\\share')).toBe(true)
  })
  test('relative rejected', () => {
    expect(isAbsolutePath('foo/bar')).toBe(false)
    expect(isAbsolutePath('./foo')).toBe(false)
    expect(isAbsolutePath('../foo')).toBe(false)
    expect(isAbsolutePath('')).toBe(false)
  })
})

describe('validateRoots', () => {
  test('happy path — POSIX', () => {
    const r = validateRoots(['/home/u/code', '/var/www'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.roots).toEqual(['/home/u/code', '/var/www'])
  })

  test('happy path — Windows drive paths', () => {
    const r = validateRoots(['C:\\Users\\artic\\GitHub', 'D:/projects'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.roots).toEqual(['C:\\Users\\artic\\GitHub', 'D:/projects'])
  })

  test('trims surrounding whitespace', () => {
    const r = validateRoots(['  /home/u  '])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.roots).toEqual(['/home/u'])
  })

  test('dedupes exact duplicates preserving order', () => {
    const r = validateRoots(['/a', '/b', '/a'])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.roots).toEqual(['/a', '/b'])
  })

  test('rejects non-array input', () => {
    const r = validateRoots('nope' as any)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('roots_not_array')
  })

  test('rejects too many roots', () => {
    const r = validateRoots(Array(17).fill('/x'))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('too_many_roots')
  })

  test('rejects non-string entries with index', () => {
    const r = validateRoots(['/ok', 42] as any)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('root_not_string')
      expect(r.index).toBe(1)
    }
  })

  test('rejects empty (after trim)', () => {
    const r = validateRoots(['/ok', '  '])
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBe('root_empty')
      expect(r.index).toBe(1)
    }
  })

  test('rejects > 512 chars', () => {
    const r = validateRoots(['/' + 'a'.repeat(520)])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('root_too_long')
  })

  test('rejects NUL byte', () => {
    const r = validateRoots(['/foo\0bar'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('root_has_nul')
  })

  test('rejects ../ segments (POSIX)', () => {
    const r = validateRoots(['/foo/../etc'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('root_has_parent_traversal')
  })

  test('rejects ..\\ segments (Windows)', () => {
    const r = validateRoots(['C:\\Users\\..\\evil'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('root_has_parent_traversal')
  })

  test('rejects relative path', () => {
    const r = validateRoots(['relative/path'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('root_not_absolute')
  })

  test('empty list is valid (clears roots)', () => {
    const r = validateRoots([])
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.roots).toEqual([])
  })

  test('does NOT reject paths containing ".." as a substring (only segments)', () => {
    const r = validateRoots(['/home/u/cool..code'])
    expect(r.ok).toBe(true)
  })
})

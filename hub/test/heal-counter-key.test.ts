/**
 * PTYCAP-07-01 -- the single shared heal key builder (AM-F4-1, AM-F4-2). DB-free.
 */
import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildHealKey, HealKeyError } from '../src/heal/counter-key.ts'

describe('buildHealKey', () => {
  test('github and path idents embed the user id', () => {
    expect(buildHealKey('u1', 'github://acme/app')).toBe('heal:u1:github://acme/app')
    expect(buildHealKey('u1', 'path:///home/x')).toBe('heal:u1:path:///home/x')
  })
  test('two users never share a key', () => {
    expect(buildHealKey('u1', 'github://a/b')).not.toBe(buildHealKey('u2', 'github://a/b'))
  })
  test('throws HealKeyError for a null ident and for the string "null"', () => {
    expect(() => buildHealKey('u1', null)).toThrow(HealKeyError)
    expect(() => buildHealKey('u1', 'null')).toThrow(HealKeyError)
    expect(() => buildHealKey('u1', undefined)).toThrow(HealKeyError)
  })
  test('throws for empty and non-canonical idents', () => {
    for (const bad of ['', 'acme/app', 'github://Acme/App', 'github://acme', 'path://rel', 'https://github.com/a/b']) {
      expect(() => buildHealKey('u1', bad)).toThrow(HealKeyError)
    }
  })
  test('throws for an empty user id', () => {
    expect(() => buildHealKey('', 'github://a/b')).toThrow(HealKeyError)
  })
})

describe('POST /heal prefix-compat pin (AM-F4-2)', () => {
  // The two are prefix-compatible only (heal:{userId}:), NOT necessarily the same per-repo
  // budget: POST /heal keys on the raw repo string, this builder on a canonical ident.
  test('sessions.ts still builds heal:${userId}:... and the builder shares that prefix', () => {
    const src = readFileSync(join(import.meta.dir, '..', 'src', 'api', 'sessions.ts'), 'utf8')
    expect(src).toContain('`heal:${userId}:')
    expect(buildHealKey('U', 'github://a/b').startsWith('heal:U:')).toBe(true)
  })
})

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertWithinRoots, SandboxEscapeError } from '../src/sandbox'

let TMP: string
let ROOT_A: string
let ROOT_B: string
let INSIDE: string
let OUTSIDE: string
let SYM_TO_OUTSIDE: string

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), 'remo-sandbox-'))
  ROOT_A = join(TMP, 'rootA')
  ROOT_B = join(TMP, 'rootB')
  INSIDE = join(ROOT_A, 'repoX')
  OUTSIDE = join(TMP, 'elsewhere')
  SYM_TO_OUTSIDE = join(ROOT_A, 'link-to-outside')
  mkdirSync(ROOT_A, { recursive: true })
  mkdirSync(ROOT_B, { recursive: true })
  mkdirSync(INSIDE, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  try {
    symlinkSync(OUTSIDE, SYM_TO_OUTSIDE, 'dir')
  } catch {
    // Windows without dev-mode / admin can't symlink; tests below tolerate.
  }
})

afterAll(() => {
  try { rmSync(TMP, { recursive: true, force: true }) } catch {}
})

describe('assertWithinRoots', () => {
  test('allows a path inside a configured root', () => {
    const r = assertWithinRoots(INSIDE, [ROOT_A, ROOT_B])
    expect(r.realRepo).toContain('repoX')
  })

  test('rejects a path outside every root', () => {
    expect(() => assertWithinRoots(OUTSIDE, [ROOT_A, ROOT_B])).toThrow(SandboxEscapeError)
  })

  test('rejects C:\\Windows\\System32 against a github root', () => {
    expect(() => assertWithinRoots('C:\\Windows\\System32', [ROOT_A])).toThrow(SandboxEscapeError)
  })

  test('symlink escape is rejected (realpath check)', () => {
    // Skip silently if symlink couldn't be created (no admin / dev-mode on Windows).
    try {
      // If the symlink doesn't exist, this throws — treat as skip.
      const { realpathSync } = require('fs')
      realpathSync(SYM_TO_OUTSIDE)
    } catch {
      return
    }
    expect(() => assertWithinRoots(SYM_TO_OUTSIDE, [ROOT_A])).toThrow(SandboxEscapeError)
  })

  test('rejects a non-existent path (realpath fails)', () => {
    expect(() => assertWithinRoots(join(TMP, 'does-not-exist'), [ROOT_A])).toThrow(SandboxEscapeError)
  })

  test('skips stale roots silently', () => {
    // A bogus root in the list shouldn't poison the others.
    const r = assertWithinRoots(INSIDE, [join(TMP, 'bogus'), ROOT_A])
    expect(r.realRepo).toContain('repoX')
  })
})

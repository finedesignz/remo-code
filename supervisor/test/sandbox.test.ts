import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  assertWithinRoots,
  assertTargetWithinRoots,
  SandboxEscapeError,
  SandboxCheckTimeoutError,
  __setSandboxFsImplForTests,
  __setSandboxTimeoutMsForTests,
} from '../src/sandbox'

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
  test('allows a path inside a configured root', async () => {
    const r = await assertWithinRoots(INSIDE, [ROOT_A, ROOT_B])
    expect(r.realRepo).toContain('repoX')
  })

  test('rejects a path outside every root — kind=not_under_roots', async () => {
    await expect(assertWithinRoots(OUTSIDE, [ROOT_A, ROOT_B])).rejects.toThrow(SandboxEscapeError)
    try {
      await assertWithinRoots(OUTSIDE, [ROOT_A, ROOT_B])
      throw new Error('expected rejection')
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxEscapeError)
      expect((e as SandboxEscapeError).kind).toBe('not_under_roots')
    }
  })

  test('rejects C:\\Windows\\System32 against a github root', async () => {
    // NOT asserting `.kind` here — whether this resolves as `path_missing`
    // (Linux CI, where the literal string is a bogus path) or
    // `not_under_roots` (a Windows dev box, where it's a real system dir
    // outside ROOT_A) is genuinely platform-dependent, same caveat as the
    // 2026-08-18 QC (D4) note below about the old UNC-path test. Both are
    // correctly rejected either way — that's what this test actually proves.
    await expect(assertWithinRoots('C:\\Windows\\System32', [ROOT_A])).rejects.toThrow(SandboxEscapeError)
  })

  // 2026-08-18 (repo_path placeholder investigation) — when every configured
  // root is itself broken, that's a misconfiguration distinct from a repo
  // genuinely sitting outside healthy roots, and must be tagged as such.
  test('every configured root broken — kind=roots_unresolvable', async () => {
    try {
      await assertWithinRoots(INSIDE, [join(TMP, 'bogus-root-1'), join(TMP, 'bogus-root-2')])
      throw new Error('expected rejection')
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxEscapeError)
      expect((e as SandboxEscapeError).kind).toBe('roots_unresolvable')
    }
  })

  test('symlink escape is rejected (realpath check)', async () => {
    // Skip silently if symlink couldn't be created (no admin / dev-mode on Windows).
    try {
      await realpath(SYM_TO_OUTSIDE)
    } catch {
      return
    }
    await expect(assertWithinRoots(SYM_TO_OUTSIDE, [ROOT_A])).rejects.toThrow(SandboxEscapeError)
  })

  test('rejects a non-existent path (realpath fails) — kind=path_missing', async () => {
    await expect(assertWithinRoots(join(TMP, 'does-not-exist'), [ROOT_A])).rejects.toThrow(SandboxEscapeError)
    try {
      await assertWithinRoots(join(TMP, 'does-not-exist'), [ROOT_A])
      throw new Error('expected rejection')
    } catch (e) {
      expect(e).toBeInstanceOf(SandboxEscapeError)
      expect((e as SandboxEscapeError).kind).toBe('path_missing')
    }
  })

  test('skips stale roots silently', async () => {
    // A bogus root in the list shouldn't poison the others.
    const r = await assertWithinRoots(INSIDE, [join(TMP, 'bogus'), ROOT_A])
    expect(r.realRepo).toContain('repoX')
  })
})

describe('assertTargetWithinRoots (clone target — path does not yet exist)', () => {
  test('allows a non-existent target under a root', async () => {
    await expect(assertTargetWithinRoots(join(ROOT_A, 'newRepo'), [ROOT_A])).resolves.toBeUndefined()
  })

  test('allows a deeply-nested non-existent target under a root', async () => {
    await expect(assertTargetWithinRoots(join(ROOT_A, 'a', 'b', 'c'), [ROOT_A])).resolves.toBeUndefined()
  })

  test('rejects a non-existent target outside every root', async () => {
    await expect(assertTargetWithinRoots(join(TMP, 'evil', 'foo'), [ROOT_A, ROOT_B])).rejects.toThrow(SandboxEscapeError)
  })

  test('rejects C:\\Windows\\System32\\newRepo against a github root', async () => {
    await expect(assertTargetWithinRoots('C:\\Windows\\System32\\newRepo', [ROOT_A])).rejects.toThrow(SandboxEscapeError)
  })

  test('rejects a target whose nearest existing ancestor escapes via realpath', async () => {
    // Skip silently if symlink couldn't be created.
    try {
      await realpath(SYM_TO_OUTSIDE)
    } catch {
      return
    }
    await expect(assertTargetWithinRoots(join(SYM_TO_OUTSIDE, 'newRepo'), [ROOT_A])).rejects.toThrow(SandboxEscapeError)
  })
})

/**
 * 2026-08-18 QC (D4) — the original version of this test used a bogus UNC
 * path (`\\256.256.256.256\...`). `realpath` rejects a malformed address like
 * that IMMEDIATELY (measured: whole file ran in 56ms) — the 5s timer never
 * fired, and the test would pass against the UN-fixed code too (any rejection
 * satisfies `err instanceof Error` and `<8000ms`). That proved nothing about
 * the timeout path.
 *
 * Fixed: inject a `realpath` that genuinely never resolves via the test-only
 * seam in sandbox.ts (`__setSandboxFsImplForTests`), and shrink the timeout
 * via `__setSandboxTimeoutMsForTests` so the test is fast without touching
 * the real 5s production constant. This actually reaches
 * `SandboxCheckTimeoutError` and proves the fail-closed contract: a hung
 * filesystem check must reject with that specific error, not merely "some
 * error", and must do so within the configured bound.
 */
describe('sandbox check timeout', () => {
  afterEach(() => {
    __setSandboxFsImplForTests(null)
    __setSandboxTimeoutMsForTests(null)
  })

  test('assertWithinRoots rejects with SandboxCheckTimeoutError when realpath never resolves', async () => {
    __setSandboxTimeoutMsForTests(50)
    __setSandboxFsImplForTests({ realpath: () => new Promise(() => { /* never resolves */ }) })

    const start = Date.now()
    await expect(assertWithinRoots(INSIDE, [ROOT_A])).rejects.toBeInstanceOf(SandboxCheckTimeoutError)
    // Bounded by the (shrunk) timeout, not by however long the hung call
    // would otherwise have run — proves the race actually wins.
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test('assertTargetWithinRoots rejects with SandboxCheckTimeoutError when access never resolves', async () => {
    __setSandboxTimeoutMsForTests(50)
    __setSandboxFsImplForTests({ access: () => new Promise(() => { /* never resolves */ }) })

    const start = Date.now()
    await expect(assertTargetWithinRoots(join(ROOT_A, 'newRepo'), [ROOT_A])).rejects.toBeInstanceOf(SandboxCheckTimeoutError)
    expect(Date.now() - start).toBeLessThan(2000)
  })

  test('a real (non-hanging) check still resolves normally once the injected impl is cleared', async () => {
    // Guards against the injection seam leaking between tests.
    const r = await assertWithinRoots(INSIDE, [ROOT_A, ROOT_B])
    expect(r.realRepo).toContain('repoX')
  })
})

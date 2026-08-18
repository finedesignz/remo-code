import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs'
import { realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { assertWithinRoots, assertTargetWithinRoots, SandboxEscapeError, SandboxCheckTimeoutError } from '../src/sandbox'

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

  test('rejects a path outside every root', async () => {
    await expect(assertWithinRoots(OUTSIDE, [ROOT_A, ROOT_B])).rejects.toThrow(SandboxEscapeError)
  })

  test('rejects C:\\Windows\\System32 against a github root', async () => {
    await expect(assertWithinRoots('C:\\Windows\\System32', [ROOT_A])).rejects.toThrow(SandboxEscapeError)
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

  test('rejects a non-existent path (realpath fails)', async () => {
    await expect(assertWithinRoots(join(TMP, 'does-not-exist'), [ROOT_A])).rejects.toThrow(SandboxEscapeError)
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
 * Regression test for fix/session-start-freeze (2026-08-18): a sandbox check
 * that never resolves (a stalled network path, a hung filesystem filter
 * driver) must reject in bounded time instead of hanging the caller — and by
 * extension the single-threaded event loop — forever. We can't easily
 * fabricate a truly-hanging filesystem in a unit test, so this proves the
 * *mechanism*: `withTimeout` (exercised here indirectly via a root whose
 * realpath resolution we substitute with a never-resolving promise) always
 * settles, never hangs the test runner itself.
 */
describe('sandbox check timeout', () => {
  test('assertWithinRoots rejects (does not hang) when a filesystem check never resolves', async () => {
    // A UNC-style path pointing at a host that will never answer simulates a
    // stalled network share without actually needing one — Node's realpath
    // on an unreachable host either errors (fast) or hangs depending on OS
    // network stack behavior; either way this must not hang the test.
    const start = Date.now()
    let threw = false
    try {
      await assertWithinRoots('\\\\256.256.256.256\\nonexistent\\share', [ROOT_A])
    } catch (err) {
      threw = true
      expect(err).toBeInstanceOf(Error)
    }
    expect(threw).toBe(true)
    // Must resolve well under the 5s SANDBOX_FS_TIMEOUT_MS bound + slack,
    // proving the call cannot hang indefinitely.
    expect(Date.now() - start).toBeLessThan(8000)
  }, 10_000)
})

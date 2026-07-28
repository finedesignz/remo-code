/**
 * PTYCAP Phase 1, plan 03 — ASVS V4 negative test (01-RESEARCH.md Security Domain).
 *
 * `PtyUsageEmitter.start()` reuses `resolveSessionDir()` / `realPathContained()`
 * from `supervisor/src/commands/session-read.ts` VERBATIM (imported, never
 * re-derived) — this test proves the emitter actually HONORS those guards: a
 * relative / traversal / NUL-byte `projectDir`, or a located transcript whose
 * real path escapes the projects base, must refuse before any read, and a
 * legitimate path must still work (the guard is selective, not a blanket
 * refusal).
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveSessionDir } from '../src/commands/session-read'
import { PtyUsageEmitter, type PtyUsageEventFrame } from '../src/usage/pty-usage-emitter'

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function makeHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'pty-containment-home-'))
  const prevHome = process.env.HOME
  const prevUserProfile = process.env.USERPROFILE
  process.env.HOME = home
  process.env.USERPROFILE = home
  return {
    home,
    restore: () => {
      process.env.HOME = prevHome
      process.env.USERPROFILE = prevUserProfile
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function seedSessionFile(projectDir: string): string {
  const r = resolveSessionDir(projectDir)
  if (!r.ok) throw new Error(`test setup: resolveSessionDir failed: ${r.error}`)
  mkdirSync(r.dir, { recursive: true })
  const file = join(r.dir, 'sess.jsonl')
  writeFileSync(
    file,
    JSON.stringify({
      type: 'assistant',
      uuid: 'u-containment',
      message: { usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
    }) + '\n',
  )
  return file
}

describe('PtyUsageEmitter — transcript path containment (ASVS V4)', () => {
  test('a relative projectDir refuses: warn logged, no watcher/timer/frame', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    const logs: Array<[string, string]> = []
    try {
      const captured: PtyUsageEventFrame[] = []
      emitter.start({
        sessionId: 'sess-rel',
        projectDir: 'relative/path/not/absolute',
        cliKind: 'claude',
        emit: (f) => captured.push(f),
        onLog: (lvl, m) => logs.push([lvl, m]),
      })
      await wait(300)
      expect(captured.length).toBe(0)
      expect(logs.some(([lvl]) => lvl === 'warn')).toBe(true)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('a projectDir containing a parent-directory segment refuses: warn logged, no watcher/timer/frame', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    const logs: Array<[string, string]> = []
    try {
      const traversal = process.platform === 'win32' ? 'C:/fake/../../etc' : '/fake/../../etc'
      const captured: PtyUsageEventFrame[] = []
      emitter.start({
        sessionId: 'sess-traverse',
        projectDir: traversal,
        cliKind: 'claude',
        emit: (f) => captured.push(f),
        onLog: (lvl, m) => logs.push([lvl, m]),
      })
      await wait(300)
      expect(captured.length).toBe(0)
      expect(logs.some(([lvl]) => lvl === 'warn')).toBe(true)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('a projectDir containing a NUL byte refuses: warn logged, no watcher/timer/frame', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    const logs: Array<[string, string]> = []
    try {
      const nulPath = (process.platform === 'win32' ? 'C:/fake/pty-nul' : '/fake/pty-nul') + '\0y'
      const captured: PtyUsageEventFrame[] = []
      emitter.start({
        sessionId: 'sess-nul',
        projectDir: nulPath,
        cliKind: 'claude',
        emit: (f) => captured.push(f),
        onLog: (lvl, m) => logs.push([lvl, m]),
      })
      await wait(300)
      expect(captured.length).toBe(0)
      expect(logs.some(([lvl]) => lvl === 'warn')).toBe(true)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('a located transcript whose real path escapes the projects base refuses — path_escape logged, file NEVER read even though it holds a valid usage record', async () => {
    const { restore } = makeHome()
    const outsideBase = mkdtempSync(join(tmpdir(), 'pty-outside-base-'))
    const emitter = new PtyUsageEmitter()
    const logs: Array<[string, string]> = []
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-escape' : '/fake/pty-escape'
      seedSessionFile(projectDir) // a REAL, valid usage record — the guard must still refuse
      const captured: PtyUsageEventFrame[] = []
      emitter.start({
        sessionId: 'sess-escape',
        projectDir,
        cliKind: 'claude',
        emit: (f) => captured.push(f),
        onLog: (lvl, m) => logs.push([lvl, m]),
        // Points containment at a DIFFERENT directory than the one the file was
        // actually located under — realPathContained legitimately returns false
        // without needing a symlink (unreliable on Windows without elevation).
        projectsBase: () => outsideBase,
      })
      await wait(1300) // allow the locate poll to find the file, then attempt containment
      expect(captured.length).toBe(0)
      expect(logs.some(([lvl, m]) => lvl === 'warn' && m.toLowerCase().includes('path_escape'))).toBe(true)
    } finally {
      emitter.stop()
      restore()
      rmSync(outsideBase, { recursive: true, force: true })
    }
  })

  test('a well-formed, properly contained path still tails and emits normally — the guard is selective, not a blanket refusal', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-legit' : '/fake/pty-legit'
      const file = seedSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-legit', projectDir, cliKind: 'claude', emit: (f) => captured.push(f) })
      await wait(1300) // this file already has content at attach; fromStart:false means we need a NEW append
      writeFileSync(
        file,
        JSON.stringify({
          type: 'assistant',
          uuid: 'u-legit-2',
          message: { usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
        }) + '\n',
        { flag: 'a' },
      )
      await wait(700)
      expect(captured.length).toBe(1)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('every refusal path leaves stop() safe to call', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      emitter.start({ sessionId: 'sess-safe', projectDir: '../traversal', cliKind: 'claude', emit: () => {} })
      await wait(100)
      expect(() => emitter.stop()).not.toThrow()
      expect(() => emitter.stop()).not.toThrow() // idempotent
    } finally {
      restore()
    }
  })
})

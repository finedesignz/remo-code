/**
 * PTYCAP Phase 1 (SC-1 / SC-2 / SC-3) — `pty-usage-emitter.ts` + its ported
 * `pty-transcript-tail.ts` tailer.
 *
 * Mirrors the fixture/integration style of `hub/test/transcript-adapter-claude.test.ts`.
 * Every test points `HOME`/`USERPROFILE` at a fresh temp dir (same technique as
 * `supervisor/test/session-read.test.ts`) so NOTHING here ever touches the real
 * `~/.claude/projects` — the emitter's own `resolveSessionDir` call is not
 * itself parameterizable, so this is the only way to keep it off the real home
 * directory. `projectsBase` is also passed explicitly as the documented test
 * seam for the containment check inside `start()`.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveSessionDir, claudeProjectsBase } from '../src/commands/session-read'
import {
  PtyUsageEmitter,
  extractUsage,
  resolveTranscriptPath,
  type PtyUsageEventFrame,
} from '../src/usage/pty-usage-emitter'

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

/** Point HOME/USERPROFILE at a fresh temp dir; caller MUST call restore(). */
function makeHome(): { home: string; restore: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'pty-usage-home-'))
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

/** Create the (empty) session transcript dir + file for `projectDir`, returning its path. */
function setupSessionFile(projectDir: string): string {
  const r = resolveSessionDir(projectDir)
  if (!r.ok) throw new Error(`test setup: resolveSessionDir failed: ${r.error}`)
  mkdirSync(r.dir, { recursive: true })
  const file = join(r.dir, 'sess.jsonl')
  writeFileSync(file, '')
  return file
}

const ALL_FRAME_KEYS = [
  'type',
  'session_id',
  'model',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cost_usd',
  'cost_source',
  'ts',
  'runner_type',
].sort()

describe('extractUsage — pure record extraction', () => {
  test('extracts the four buckets + model from an assistant record with usage', () => {
    const r = extractUsage({
      type: 'assistant',
      message: { model: 'claude-x', usage: { input_tokens: 5, output_tokens: 2, cache_creation_input_tokens: 1, cache_read_input_tokens: 0 } },
    })
    expect(r).toEqual({ inputTokens: 5, outputTokens: 2, cacheCreationInputTokens: 1, cacheReadInputTokens: 0, model: 'claude-x' })
  })

  test('model is null when message.model is not a string', () => {
    const r = extractUsage({ type: 'assistant', message: { usage: { input_tokens: 1 } } })
    expect(r?.model).toBeNull()
  })

  test('missing buckets coerce to 0, never NaN/undefined', () => {
    const r = extractUsage({ type: 'assistant', message: { usage: {} } })
    expect(r).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, model: null })
  })

  test('non-assistant type returns null', () => {
    expect(extractUsage({ type: 'user', message: { usage: { input_tokens: 1 } } })).toBeNull()
  })

  test('assistant record with no message.usage returns null', () => {
    expect(extractUsage({ type: 'assistant', message: {} })).toBeNull()
  })

  test('non-object / primitive record returns null, never throws', () => {
    expect(extractUsage('garbage')).toBeNull()
    expect(extractUsage(null)).toBeNull()
    expect(extractUsage(42)).toBeNull()
  })
})

describe('resolveTranscriptPath — capture-once locator (P1-D-B)', () => {
  test('picks the lowest-mtime .jsonl at/after sinceMs, skips one that is too old', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-'))
    try {
      const now = Date.now()
      const older = join(dir, 'older.jsonl')
      const newer = join(dir, 'newer.jsonl')
      writeFileSync(older, '')
      writeFileSync(newer, '')
      // Backdate `older` well before the slack window so it doesn't qualify.
      const past = new Date(now - 60_000)
      utimesSync(older, past, past)
      const found = resolveTranscriptPath(dir, now)
      expect(found).toBe(newer)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when the directory does not exist', () => {
    expect(resolveTranscriptPath(join(tmpdir(), 'does-not-exist-' + Date.now()), Date.now())).toBeNull()
  })

  test('returns null when no entry qualifies (all too old)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'locate-old-'))
    try {
      const now = Date.now()
      const f = join(dir, 'ancient.jsonl')
      writeFileSync(f, '')
      const past = new Date(now - 60_000)
      utimesSync(f, past, past)
      expect(resolveTranscriptPath(dir, now)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('PtyUsageEmitter — end-to-end mid-turn accounting (SC-1/SC-2/SC-3)', () => {
  test('a live-appended assistant usage record emits exactly one tagged frame while the file is still open', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-a' : '/fake/pty-usage-a'
      const file = setupSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({
        sessionId: 'sess-a',
        projectDir,
        cliKind: 'claude',
        emit: (f) => captured.push(f),
        projectsBase: () => claudeProjectsBase(),
      })
      await wait(200)
      writeFileSync(
        file,
        JSON.stringify({
          type: 'assistant',
          uuid: 'u-1',
          message: { model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 3 } },
        }) + '\n',
        { flag: 'a' },
      )
      await wait(700)
      expect(captured.length).toBe(1)
      const frame = captured[0]
      expect(Object.keys(frame).sort()).toEqual(ALL_FRAME_KEYS)
      expect(frame.type).toBe('usage_event')
      expect(frame.session_id).toBe('sess-a')
      expect(frame.model).toBe('claude-sonnet-5')
      expect(frame.input_tokens).toBe(100)
      expect(frame.output_tokens).toBe(20)
      expect(frame.cache_creation_input_tokens).toBe(5)
      expect(frame.cache_read_input_tokens).toBe(3)
      expect(frame.cost_usd).toBe(0)
      expect(frame.cost_source).toBe('estimated')
      expect(frame.runner_type).toBe('pty-interactive')
      expect(typeof frame.ts).toBe('string')
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('a non-assistant record and an assistant record with no usage both emit nothing', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-b' : '/fake/pty-usage-b'
      const file = setupSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-b', projectDir, cliKind: 'claude', emit: (f) => captured.push(f) })
      await wait(200)
      writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'hi' } }) + '\n', { flag: 'a' })
      writeFileSync(file, JSON.stringify({ type: 'assistant', message: {} }) + '\n', { flag: 'a' })
      await wait(700)
      expect(captured.length).toBe(0)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('a record whose four buckets are all zero emits nothing (no noise rows)', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-c' : '/fake/pty-usage-c'
      const file = setupSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-c', projectDir, cliKind: 'claude', emit: (f) => captured.push(f) })
      await wait(200)
      writeFileSync(
        file,
        JSON.stringify({ type: 'assistant', uuid: 'u-zero', message: { usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n',
        { flag: 'a' },
      )
      await wait(700)
      expect(captured.length).toBe(0)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('a malformed JSON line is skipped and does not stop the tailer — a valid record after it still emits', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-d' : '/fake/pty-usage-d'
      const file = setupSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-d', projectDir, cliKind: 'claude', emit: (f) => captured.push(f) })
      await wait(200)
      writeFileSync(file, 'this is not { valid json at all\n', { flag: 'a' })
      writeFileSync(
        file,
        JSON.stringify({ type: 'assistant', uuid: 'u-after-bad', message: { usage: { input_tokens: 7, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n',
        { flag: 'a' },
      )
      await wait(700)
      expect(captured.length).toBe(1)
      expect(captured[0].input_tokens).toBe(7)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('appending the SAME record (same uuid) twice emits once', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-e' : '/fake/pty-usage-e'
      const file = setupSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-e', projectDir, cliKind: 'claude', emit: (f) => captured.push(f) })
      await wait(200)
      const line = JSON.stringify({ type: 'assistant', uuid: 'u-dup', message: { usage: { input_tokens: 3, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n'
      writeFileSync(file, line, { flag: 'a' })
      await wait(700)
      writeFileSync(file, line, { flag: 'a' })
      await wait(700)
      expect(captured.length).toBe(1)
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('after a truncation resets the tail offset, a previously-seen uuid is NOT re-emitted', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-f' : '/fake/pty-usage-f'
      const file = setupSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-f', projectDir, cliKind: 'claude', emit: (f) => captured.push(f) })
      await wait(200)
      const line = JSON.stringify({ type: 'assistant', uuid: 'u-trunc', message: { usage: { input_tokens: 9, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n'
      writeFileSync(file, line, { flag: 'a' })
      await wait(700)
      expect(captured.length).toBe(1)
      // Truncate to 0 bytes (shorter than the tail's tracked offset) — forces
      // the ported tailer's truncation-reset path (offset=0, re-read from top).
      writeFileSync(file, '')
      await wait(700)
      // Re-write the SAME uuid'd record from scratch.
      writeFileSync(file, line, { flag: 'a' })
      await wait(700)
      expect(captured.length).toBe(1) // dedupe survives the truncation/re-read
    } finally {
      emitter.stop()
      restore()
    }
  })

  test('stop() is idempotent and no frame is emitted after it', async () => {
    const { restore } = makeHome()
    const freshEmitter = new PtyUsageEmitter()
    freshEmitter.stop() // safe to call before start()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-g' : '/fake/pty-usage-g'
      const file = setupSessionFile(projectDir)
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-g', projectDir, cliKind: 'claude', emit: (f) => captured.push(f) })
      await wait(200)
      emitter.stop()
      emitter.stop() // idempotent — must not throw
      writeFileSync(
        file,
        JSON.stringify({ type: 'assistant', uuid: 'u-after-stop', message: { usage: { input_tokens: 4, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }) + '\n',
        { flag: 'a' },
      )
      await wait(700)
      expect(captured.length).toBe(0)
    } finally {
      restore()
    }
  })

  test('a codex-backed session (cliKind "codex") is a true no-op — no timer, no watcher, no emitted frame', async () => {
    const { restore } = makeHome()
    const emitter = new PtyUsageEmitter()
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/pty-usage-h' : '/fake/pty-usage-h'
      setupSessionFile(projectDir) // dir exists, but codex must never even look
      const captured: PtyUsageEventFrame[] = []
      emitter.start({ sessionId: 'sess-h', projectDir, cliKind: 'codex', emit: (f) => captured.push(f) })
      expect(captured.length).toBe(0) // synchronous no-op — codex check runs before any timer
      await wait(1200) // past both the locate (1000ms) and tail (500ms) poll intervals
      expect(captured.length).toBe(0)
    } finally {
      emitter.stop()
      restore()
    }
  })
})

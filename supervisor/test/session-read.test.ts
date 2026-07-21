/**
 * Milestone ASK Phase 1 — the two security properties of the read surface:
 *   1. PATH TRAVERSAL is rejected (fail closed) — the hub can never make the
 *      supervisor read a file outside `~/.claude/projects/<slug>`.
 *   2. The returned payload is BYTE-CAPPED.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveSessionDir,
  capBytes,
  parseTranscriptJsonl,
  claudeProjectsBase,
  slugForProjectDir,
  runSessionMemory,
  realPathContained,
  MAX_BYTES,
} from '../src/commands/session-read'
import { sep } from 'path'

describe('resolveSessionDir — path traversal fails closed', () => {
  const bad = [
    undefined,
    '',
    '   ',
    '..',
    '../../etc/passwd',
    'relative/path',
    'C:/Users/artic/GitHub/../../../Windows/System32',
    '/etc/../../root',
    '/tmp/x\0y',
  ]
  for (const p of bad) {
    test(`rejects ${JSON.stringify(p)}`, () => {
      const r = resolveSessionDir(p as any)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(['invalid_project_dir', 'path_escape']).toContain(r.error)
    })
  }

  test('an absolute project_dir resolves INSIDE ~/.claude/projects', () => {
    const r = resolveSessionDir('C:/Users/artic/GitHub/remo-code')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.dir.startsWith(claudeProjectsBase())).toBe(true)
      expect(r.dir).toContain(slugForProjectDir('C:/Users/artic/GitHub/remo-code'))
    }
  })

  test('slug flattens every separator — a traversal cannot survive slugging', () => {
    // Even if a `..` slipped through, slugging turns it into dashes, so the
    // resolved dir is still a single child of the base. Belt AND braces.
    const slug = slugForProjectDir('/a/../../b')
    expect(slug.includes('/')).toBe(false)
    expect(slug.includes('\\')).toBe(false)
  })
})

describe('capBytes — the byte cap', () => {
  test('short input passes through untouched', () => {
    const [s, cut] = capBytes('hello')
    expect(s).toBe('hello')
    expect(cut).toBe(false)
  })

  test('oversized input is truncated to the cap, keeping the TAIL', () => {
    const big = 'x'.repeat(MAX_BYTES + 5_000) + 'TAILMARK'
    const [s, cut] = capBytes(big)
    expect(cut).toBe(true)
    expect(Buffer.byteLength(s, 'utf8')).toBeLessThanOrEqual(MAX_BYTES)
    expect(s.endsWith('TAILMARK')).toBe(true)
  })
})

describe('parseTranscriptJsonl', () => {
  test('keeps user/assistant turns, skips junk, returns only the tail', () => {
    const lines = [
      JSON.stringify({ type: 'summary', summary: 'nope' }),
      'not json at all',
      JSON.stringify({ message: { role: 'user', content: 'q1' } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'text', text: 'a1' }] } }),
      JSON.stringify({ message: { role: 'assistant', content: [{ type: 'tool_use', id: 't' }] } }),
      JSON.stringify({ message: { role: 'user', content: 'q2' } }),
    ].join('\n')
    const turns = parseTranscriptJsonl(lines, 2)
    expect(turns).toEqual([
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: 'q2' },
    ])
  })
})

describe('runSessionMemory — byte cap applies to the real read path', () => {
  test('caps a huge memory dir and flags truncated', async () => {
    // Build a fake ~/.claude/projects/<slug>/memory by pointing HOME at a tmpdir.
    const home = mkdtempSync(join(tmpdir(), 'ask-home-'))
    const prevHome = process.env.HOME
    const prevUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      const projectDir = process.platform === 'win32' ? 'C:/fake/repo' : '/fake/repo'
      const dir = join(home, '.claude', 'projects', slugForProjectDir(projectDir), 'memory')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'MEMORY.md'), 'index\n')
      writeFileSync(join(dir, 'a_big.md'), 'y'.repeat(MAX_BYTES * 2))

      const res = await runSessionMemory([projectDir])
      expect(res.exit_code).toBe(0)
      const payload = JSON.parse(res.snippet!)
      expect(payload.truncated).toBe(true)
      const total = payload.files.reduce(
        (n: number, f: any) => n + Buffer.byteLength(f.content, 'utf8'),
        0,
      )
      expect(total).toBeLessThanOrEqual(MAX_BYTES)
      expect(payload.files[0].name).toBe('MEMORY.md')
    } finally {
      process.env.HOME = prevHome
      process.env.USERPROFILE = prevUserProfile
      rmSync(home, { recursive: true, force: true })
    }
  })

  test('a traversal project_dir never reads anything', async () => {
    const res = await runSessionMemory(['../../../etc'])
    expect(res.exit_code).toBe(1)
    expect(['invalid_project_dir', 'path_escape']).toContain(res.error)
  })

  // A symlink INSIDE the jail whose real target escapes the base must NOT leak the
  // target. String-prefix containment misses this — the realpath check catches it.
  test('a symlinked memory file pointing OUTSIDE the base is not read', async () => {
    const home = mkdtempSync(join(tmpdir(), 'ask-home-sym-'))
    const outside = mkdtempSync(join(tmpdir(), 'ask-secret-'))
    const prevHome = process.env.HOME
    const prevUserProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      const secret = join(outside, 'id_rsa')
      writeFileSync(secret, 'SUPER-SECRET-KEY-MATERIAL')
      const projectDir = process.platform === 'win32' ? 'C:/fake/repo2' : '/fake/repo2'
      const dir = join(home, '.claude', 'projects', slugForProjectDir(projectDir), 'memory')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'MEMORY.md'), 'legit index\n')
      let symlinked = false
      try {
        symlinkSync(secret, join(dir, 'leak.md'))
        symlinked = true
      } catch {
        // Windows without symlink privilege — fall through to the unit assertion below.
      }

      const res = await runSessionMemory([projectDir])
      if (res.exit_code === 0) {
        const payload = JSON.parse(res.snippet!)
        const blob = JSON.stringify(payload)
        expect(blob).not.toContain('SUPER-SECRET-KEY-MATERIAL')
        expect(payload.files.some((f: any) => f.name === 'leak.md')).toBe(false)
      }
      // Unit-level proof the realpath guard rejects a real path outside the base,
      // independent of whether the FS allowed the symlink.
      expect(realPathContained(secret, claudeProjectsBase())).toBe(false)
      if (symlinked) {
        expect(realPathContained(join(dir, 'leak.md'), claudeProjectsBase())).toBe(false)
      }
      // Use the REAL base (tmpdir may itself be a symlink, e.g. /tmp→/private/tmp).
      expect(realPathContained(join(dir, 'MEMORY.md'), realpathSync(join(home, '.claude', 'projects')))).toBe(true)
      void sep
    } finally {
      process.env.HOME = prevHome
      process.env.USERPROFILE = prevUserProfile
      rmSync(home, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

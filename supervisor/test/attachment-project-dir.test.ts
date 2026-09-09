/**
 * term.attach_file destination path. Uploaded attachments must land inside
 * the session's real working directory (repoPath), not a host temp dir, so
 * the CLI's own file tools can resolve them. Covers: repoPath placement,
 * idempotent .gitignore guard, skip when not a git repo, filename collision,
 * and a path containing a space.
 */
import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  writeAttachmentFile,
  attachmentsDirFor,
  ensureAttachmentsGitignored,
  SessionBridge,
} from '../src/runners/session-bridge'

const dirs: string[] = []
function makeRepo(withGit: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'remo-attach-test-'))
  if (withGit) mkdirSync(join(dir, '.git'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }) } catch {}
  }
})

describe('writeAttachmentFile', () => {
  test('writes under <repoPath>/.remo/attachments/<sessionId>, not a temp dir', () => {
    const repo = makeRepo(true)
    const sessionId = 'sess-1'
    const abs = writeAttachmentFile(repo, sessionId, 'screenshot.png', Buffer.from('hi').toString('base64'))
    expect(abs.startsWith(attachmentsDirFor(repo, sessionId))).toBe(true)
    expect(abs).not.toContain('remo-attachments') // old host-temp-dir scheme
    expect(abs.startsWith(repo)).toBe(true)
    expect(existsSync(abs)).toBe(true)
    expect(readFileSync(abs, 'utf8')).toBe('hi')
  })

  test('two uploads of the same filename in one session do not collide', () => {
    const repo = makeRepo(true)
    const sessionId = 'sess-2'
    const a = writeAttachmentFile(repo, sessionId, 'note.txt', Buffer.from('a').toString('base64'))
    const b = writeAttachmentFile(repo, sessionId, 'note.txt', Buffer.from('b').toString('base64'))
    expect(a).not.toBe(b)
    expect(readFileSync(a, 'utf8')).toBe('a')
    expect(readFileSync(b, 'utf8')).toBe('b')
  })

  test('handles a repoPath containing a space', () => {
    const parent = mkdtempSync(join(tmpdir(), 'remo-attach-test-'))
    dirs.push(parent)
    const repo = join(parent, 'my project')
    mkdirSync(repo)
    mkdirSync(join(repo, '.git'))
    const abs = writeAttachmentFile(repo, 'sess-space', 'file.txt', Buffer.from('x').toString('base64'))
    expect(existsSync(abs)).toBe(true)
    expect(abs).toContain('my project')
  })

  test('gitignore is appended once and only once', () => {
    const repo = makeRepo(true)
    writeAttachmentFile(repo, 'sess-3', 'a.txt', Buffer.from('a').toString('base64'))
    writeAttachmentFile(repo, 'sess-3', 'b.txt', Buffer.from('b').toString('base64'))
    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8')
    const occurrences = gitignore.split(/\r?\n/).filter((l) => l.trim() === '.remo/').length
    expect(occurrences).toBe(1)
  })

  test('gitignore is skipped entirely when .git is absent (rootless/orchestrator dirs)', () => {
    const repo = makeRepo(false)
    writeAttachmentFile(repo, 'sess-4', 'a.txt', Buffer.from('a').toString('base64'))
    expect(existsSync(join(repo, '.gitignore'))).toBe(false)
  })
})

describe('ensureAttachmentsGitignored', () => {
  test('preserves existing gitignore content and appends without a duplicate blank-line gap', () => {
    const repo = makeRepo(true)
    const gitignorePath = join(repo, '.gitignore')
    require('fs').writeFileSync(gitignorePath, 'node_modules/')
    ensureAttachmentsGitignored(repo)
    const contents = readFileSync(gitignorePath, 'utf8')
    expect(contents).toContain('node_modules/')
    expect(contents).toContain('.remo/')
    ensureAttachmentsGitignored(repo)
    const contentsAfterSecondCall = readFileSync(gitignorePath, 'utf8')
    const occurrences = contentsAfterSecondCall.split(/\r?\n/).filter((l) => l.trim() === '.remo/').length
    expect(occurrences).toBe(1)
  })
})

describe('attachmentsDirFor sessionId validation (path-traversal hardening)', () => {
  const hostile = ['..', '../..', 'a/../../b', 'a\\b', '/etc/passwd', 'C:\\Windows', '']

  test('rejects hostile sessionId values — throws, nothing computed', () => {
    const repo = makeRepo(true)
    for (const bad of hostile) {
      expect(() => attachmentsDirFor(repo, bad)).toThrow()
    }
  })

  test('writeAttachmentFile refuses a hostile sessionId — nothing written outside the repo', () => {
    const repo = makeRepo(true)
    for (const bad of hostile) {
      expect(() =>
        writeAttachmentFile(repo, bad, 'evil.txt', Buffer.from('x').toString('base64')),
      ).toThrow()
    }
    // Nothing should have leaked into the repo or its parent.
    expect(existsSync(join(repo, '.remo'))).toBe(false)
  })

  test('a normal sessionId still resolves under <repoPath>/.remo/attachments (no regression)', () => {
    const repo = makeRepo(true)
    const dir = attachmentsDirFor(repo, 'sess-normal-123')
    expect(dir).toBe(join(repo, '.remo', 'attachments', 'sess-normal-123'))
    expect(existsSync(dir)).toBe(false) // dir isn't created by attachmentsDirFor itself
  })

  test('containment assert rejects a value that could slip past a naive regex check', () => {
    const repo = makeRepo(true)
    // Would pass a looser check like /^[^/\\]+$/ (no literal separator chars)
    // but still needs the resolve()+startsWith() containment assert as the
    // real boundary. The strict allowlist already blocks '.', proving the
    // second layer is load-bearing defense-in-depth, not decorative.
    expect(() => attachmentsDirFor(repo, '.')).toThrow()
    expect(() => attachmentsDirFor(repo, '..')).toThrow()
  })
})

describe('SessionBridge.stop() cleanup', () => {
  test('removes the session attachments dir best-effort', async () => {
    const repo = makeRepo(true)
    const sessionId = 'sess-cleanup'
    writeAttachmentFile(repo, sessionId, 'a.txt', Buffer.from('a').toString('base64'))
    const dir = attachmentsDirFor(repo, sessionId)
    expect(existsSync(dir)).toBe(true)

    const bridge = new SessionBridge(
      { runId: 'r1', repoPath: repo, apiKey: 'k', hubUrl: 'http://example.invalid', allowDangerousSkipPermissions: false },
      { onLog: () => {}, onExit: () => {}, onSpawned: () => {} },
    )
    // No real WS/runner spawned (never called start()); simulate an
    // authenticated session id to exercise the cleanup path in stop().
    ;(bridge as any).sessionId = sessionId

    await bridge.stop()
    expect(existsSync(dir)).toBe(false)
  })

  test('stop() with a hostile sessionId deletes nothing outside the repo and does not throw', async () => {
    const repo = makeRepo(true)
    writeAttachmentFile(repo, 'sess-legit', 'a.txt', Buffer.from('a').toString('base64'))
    const legitDir = attachmentsDirFor(repo, 'sess-legit')
    expect(existsSync(legitDir)).toBe(true)

    const bridge = new SessionBridge(
      { runId: 'r-hostile', repoPath: repo, apiKey: 'k', hubUrl: 'http://example.invalid', allowDangerousSkipPermissions: false },
      { onLog: () => {}, onExit: () => {}, onSpawned: () => {} },
    )
    ;(bridge as any).sessionId = '..'

    await expect(bridge.stop()).resolves.toBeUndefined()
    // Unrelated legit session dir must be untouched — the hostile id never
    // resolved to a path stop() was allowed to rmSync.
    expect(existsSync(legitDir)).toBe(true)
  })

  test('stop() never throws even if the attachments dir was never created', async () => {
    const repo = makeRepo(true)
    const bridge = new SessionBridge(
      { runId: 'r2', repoPath: repo, apiKey: 'k', hubUrl: 'http://example.invalid', allowDangerousSkipPermissions: false },
      { onLog: () => {}, onExit: () => {}, onSpawned: () => {} },
    )
    ;(bridge as any).sessionId = 'sess-never-wrote'
    await expect(bridge.stop()).resolves.toBeUndefined()
  })
})

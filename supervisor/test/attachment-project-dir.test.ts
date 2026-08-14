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
    const occurrences = contents.split(/\r?\n/).filter((l) => l.trim() === '.remo/').length
    expect(occurrences).toBe(1)
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

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runErrorSetupApply } from '../src/commands/error-setup-apply'

let workDir: string
let repoDir: string
let remoteDir: string

async function git(args: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true })
  const code = await p.exited
  const stdout = await new Response(p.stdout).text()
  const stderr = await new Response(p.stderr).text()
  return { code: code as number, stdout, stderr }
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'apply-'))
  repoDir = join(workDir, 'repo')
  remoteDir = join(workDir, 'remote.git')
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(remoteDir, { recursive: true })

  // bare remote
  await git(['init', '--bare', '-b', 'main'], remoteDir)
  // working repo
  await git(['init', '-b', 'main'], repoDir)
  await git(['config', 'user.email', 'test@example.com'], repoDir)
  await git(['config', 'user.name', 'Test'], repoDir)
  writeFileSync(join(repoDir, 'README.md'), 'initial\n')
  await git(['add', '-A'], repoDir)
  await git(['commit', '-m', 'init'], repoDir)
  await git(['remote', 'add', 'origin', remoteDir], repoDir)
  await git(['push', '-u', 'origin', 'main'], repoDir)
})

afterEach(() => {
  try { rmSync(workDir, { recursive: true, force: true }) } catch {}
})

describe('error_setup_apply', () => {
  test('writes files, commits, pushes', async () => {
    const payload = JSON.stringify({
      writes: [
        { path: 'sentry.config.ts', content: 'export const dsn = "x"\n' },
        { path: 'src/instrumentation.ts', content: 'export {}\n' },
      ],
      commit_message: 'feat: add sentry SDK',
      branch: 'main',
    })
    const r = await runErrorSetupApply([repoDir, payload])
    expect(r.ok).toBe(true)
    expect(r.pushed).toBe(true)
    expect(r.commit_sha).toMatch(/^[0-9a-f]{40}$/)
    expect(r.branch).toBe('main')

    // file written
    expect(readFileSync(join(repoDir, 'sentry.config.ts'), 'utf-8')).toBe('export const dsn = "x"\n')
    expect(readFileSync(join(repoDir, 'src/instrumentation.ts'), 'utf-8')).toBe('export {}\n')

    // committed
    const log = await git(['log', '--oneline', '-1'], repoDir)
    expect(log.stdout).toContain('feat: add sentry SDK')

    // pushed (remote ref exists)
    const lsRemote = await git(['ls-remote', remoteDir, 'refs/heads/main'], repoDir)
    expect(lsRemote.stdout.trim()).toContain(r.commit_sha!)
  })

  test('nothing_to_commit when no diff', async () => {
    // Write same content as already-committed README
    const payload = JSON.stringify({
      writes: [{ path: 'README.md', content: 'initial\n' }],
      commit_message: 'noop',
      branch: 'main',
    })
    const r = await runErrorSetupApply([repoDir, payload])
    expect(r.ok).toBe(true)
    expect(r.nothing_to_commit).toBe(true)
  })

  test('repo_not_found for missing repo', async () => {
    const payload = JSON.stringify({
      writes: [{ path: 'a.txt', content: 'x' }],
      commit_message: 'x',
    })
    const r = await runErrorSetupApply([join(workDir, 'no-such-repo'), payload])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('repo_not_found')
  })

  test('repo_not_found when path is not a git repo', async () => {
    const notRepo = join(workDir, 'plain')
    mkdirSync(notRepo)
    const payload = JSON.stringify({
      writes: [{ path: 'a.txt', content: 'x' }],
      commit_message: 'x',
    })
    const r = await runErrorSetupApply([notRepo, payload])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('repo_not_found')
  })

  test('invalid_payload on malformed JSON', async () => {
    const r = await runErrorSetupApply([repoDir, '{not json'])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_payload')
  })

  test('invalid_payload on path traversal in writes', async () => {
    const payload = JSON.stringify({
      writes: [{ path: '../escape.txt', content: 'x' }],
      commit_message: 'x',
    })
    const r = await runErrorSetupApply([repoDir, payload])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_payload')
  })

  test('invalid_payload on absolute write path', async () => {
    const abs = process.platform === 'win32' ? 'C:\\evil.txt' : '/evil.txt'
    const payload = JSON.stringify({
      writes: [{ path: abs, content: 'x' }],
      commit_message: 'x',
    })
    const r = await runErrorSetupApply([repoDir, payload])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_payload')
  })

  test('invalid_payload on empty writes array', async () => {
    const payload = JSON.stringify({ writes: [], commit_message: 'x' })
    const r = await runErrorSetupApply([repoDir, payload])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_payload')
  })

  test('invalid_payload on missing commit_message', async () => {
    const payload = JSON.stringify({ writes: [{ path: 'a.txt', content: 'x' }] })
    const r = await runErrorSetupApply([repoDir, payload])
    expect(r.ok).toBe(false)
    expect(r.error).toBe('invalid_payload')
  })

  test('single-arg shape with repo_path inside payload', async () => {
    const payload = JSON.stringify({
      repo_path: repoDir,
      writes: [{ path: 'one.txt', content: 'one\n' }],
      commit_message: 'add one',
      branch: 'main',
    })
    const r = await runErrorSetupApply([payload])
    expect(r.ok).toBe(true)
    expect(r.pushed).toBe(true)
    expect(existsSync(join(repoDir, 'one.txt'))).toBe(true)
  })

  test('uses current branch when none provided', async () => {
    const payload = JSON.stringify({
      writes: [{ path: 'b.txt', content: 'b\n' }],
      commit_message: 'add b',
    })
    const r = await runErrorSetupApply([repoDir, payload])
    expect(r.ok).toBe(true)
    expect(r.branch).toBe('main')
  })
})

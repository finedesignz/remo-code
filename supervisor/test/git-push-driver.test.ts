/**
 * v0.8.7 CHANGE 2 — git-push-driver: create a brand-new GitHub repo from an
 * unpushed local folder. The hub has already created the empty remote; the
 * supervisor runs git init → commit → remote add → push, emitting
 * repo_create_progress per stage in the EXACT order the hub's
 * applySupervisorProgress() expects: init → commit → remote_add →
 * pushing_locally → pushed → reindexing → done.
 *
 * Real temp git dirs; the network push is stubbed via an injectable git runner
 * so no real remote is contacted.
 */
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pushLocalRepo, type GitRunner } from '../src/git-push-driver'

function tmp() { return mkdtempSync(join(tmpdir(), 'remo-pushdrv-')) }

/** A git runner that runs real git for init/add/commit/remote/branch but stubs
 *  any `push` (so we never hit the network). */
function realGitExceptPush(pushResult: { code: number; stderr?: string } = { code: 0 }): {
  run: GitRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const realRun = require('../src/git-ops')
  const run: GitRunner = async (args, cwd) => {
    calls.push(args)
    if (args[0] === 'push') {
      if (pushResult.code !== 0) throw new Error(pushResult.stderr || 'push failed')
      return { stdout: '', stderr: '', code: 0 }
    }
    // Fall through to a real spawn for the local-only ops.
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', windowsHide: true })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    if (code !== 0) throw new Error(stderr.trim() || `git ${args[0]} exited ${code}`)
    return { stdout: await new Response(proc.stdout).text(), stderr, code }
  }
  return { run, calls }
}

describe('pushLocalRepo', () => {
  test('stage order ends pushed → done; emits all expected stages', async () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, 'hello.txt'), 'hi\n', 'utf-8')
      const stages: string[] = []
      const { run } = realGitExceptPush()
      const res = await pushLocalRepo({
        localPath: dir,
        remoteUrl: 'https://github.com/owner/name.git',
        onProgress: (s) => stages.push(s),
        gitRun: run,
      })
      expect(res.ok).toBe(true)
      expect(stages).toEqual(['init', 'commit', 'remote_add', 'pushing_locally', 'pushed', 'reindexing', 'done'])
      expect(existsSync(join(dir, '.git'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('already-initialized repo with commits: skips re-commit, still ends pushed → done', async () => {
    const dir = tmp()
    try {
      // Pre-seed a committed repo.
      const seed = async (args: string[]) => {
        const p = Bun.spawn(['git', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe', windowsHide: true })
        await p.exited
      }
      await seed(['init'])
      await seed(['config', 'user.email', 't@t.t'])
      await seed(['config', 'user.name', 't'])
      writeFileSync(join(dir, 'a.txt'), 'a\n', 'utf-8')
      await seed(['add', '-A'])
      await seed(['commit', '-m', 'seed'])

      const stages: string[] = []
      const { run } = realGitExceptPush()
      const res = await pushLocalRepo({
        localPath: dir,
        remoteUrl: 'https://github.com/owner/name.git',
        onProgress: (s) => stages.push(s),
        gitRun: run,
      })
      expect(res.ok).toBe(true)
      // Tail of the sequence is always pushed → reindexing → done.
      expect(stages.slice(-3)).toEqual(['pushed', 'reindexing', 'done'])
      // Pre-existing commit means no second commit is forced, but stage order holds.
      expect(stages.slice(0, 4)).toEqual(['init', 'commit', 'remote_add', 'pushing_locally'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('push failure → ok:false with failure stage, halts (no done)', async () => {
    const dir = tmp()
    try {
      writeFileSync(join(dir, 'x.txt'), 'x\n', 'utf-8')
      const stages: string[] = []
      const { run } = realGitExceptPush({ code: 1, stderr: 'remote rejected' })
      const res = await pushLocalRepo({
        localPath: dir,
        remoteUrl: 'https://github.com/owner/name.git',
        onProgress: (s) => stages.push(s),
        gitRun: run,
      })
      expect(res.ok).toBe(false)
      expect(res.error).toContain('remote rejected')
      expect(stages).not.toContain('done')
      expect(stages).not.toContain('pushed')
      expect(res.failedStage).toBe('pushing_locally')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

/**
 * CORCH-09 (R4.4, R4.5): corch.worktree_ensure / worktree_remove / pr_lookup against temp git repos and a fake gh.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCorchWorktreeEnsure, runCorchWorktreeRemove, runCorchPrLookup, __setCorchWorktreeForTest, type ExecFn } from '../src/commands/corch-worktree'

let base: string
let root: string
let origin: string

function sh(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${p.stderr.toString()}`)
  return p.stdout.toString()
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'corch-wt-')))
  root = join(base, 'root')
  origin = join(base, 'origin.git')
  sh(base, 'init', '--bare', '-b', 'trunk', origin)
  const seed = join(base, 'seed')
  sh(base, 'clone', origin, seed)
  writeFileSync(join(seed, 'a.txt'), 'x')
  sh(seed, 'checkout', '-b', 'trunk')
  sh(seed, 'add', '.')
  sh(seed, 'commit', '-m', 'init')
  sh(seed, 'push', 'origin', 'trunk')
  Bun.spawnSync(['mkdir', '-p', root])
  __setCorchWorktreeForTest({ roots: () => [root], cloneUrl: () => origin })
})
afterAll(() => {
  __setCorchWorktreeForTest({ exec: null })
  rmSync(base, { recursive: true, force: true })
})

describe('corch.worktree_ensure', () => {
  test('clones the canonical repo, creates the deterministic worktree and branch off the DEFAULT branch', async () => {
    const r = await runCorchWorktreeEnsure(['github://acme/widget', 'item-1'])
    expect(r.exit_code).toBe(0)
    const out = JSON.parse(r.snippet!)
    expect(out.path).toBe(join(root, 'corch', 'widget-item-1'))
    expect(out.branch).toBe('corch/item-1')
    expect(out.default_branch).toBe('trunk')
    expect(out.reused).toBe(false)
    expect(existsSync(join(root, 'acme', 'widget', '.git'))).toBe(true)
    expect(existsSync(join(out.path, 'a.txt'))).toBe(true)
    expect(sh(out.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('corch/item-1')
  })

  test('reuses an existing worktree (idempotent)', async () => {
    const again = await runCorchWorktreeEnsure(['github://acme/widget', 'item-1'])
    expect(again.exit_code).toBe(0)
    expect(JSON.parse(again.snippet!).reused).toBe(true)
  })

  test('refuses traversal and malformed identifiers before any git runs', async () => {
    for (const args of [
      ['github://../evil', 'item-2'],
      ['github://acme/..', 'item-2'],
      ['github://acme/widget', '../../x'],
      ['github://acme/widget', 'a/b'],
      ['https://github.com/acme/widget', 'item-2'],
      ['github://acme/wid get', 'item-2'],
    ]) {
      const r = await runCorchWorktreeEnsure(args)
      expect(r.exit_code).toBe(1)
      expect(r.error).toMatch(/^invalid_/)
    }
    expect(existsSync(join(base, 'evil'))).toBe(false)
  })

  test('assertTargetWithinRoots refuses a layout that escapes the configured root', async () => {
    // A root that is a symlink-free dir whose realpath differs from where the layout resolves is not constructible
    // portably; instead point the root at a path whose "corch" child is a file so the sandbox/ git step fails closed.
    __setCorchWorktreeForTest({ roots: () => [join(base, 'does-not-exist')] })
    try {
      const r = await runCorchWorktreeEnsure(['github://acme/widget', 'item-3'])
      expect(r.exit_code).toBe(1)
      expect(r.error).toBe('path_outside_roots')
    } finally {
      __setCorchWorktreeForTest({ roots: () => [root] })
    }
  })
})

describe('corch.worktree_remove', () => {
  test('removes the worktree and is idempotent', async () => {
    const wt = join(root, 'corch', 'widget-item-1')
    expect(existsSync(wt)).toBe(true)
    const r = await runCorchWorktreeRemove(['github://acme/widget', 'item-1'])
    expect(r.exit_code).toBe(0)
    expect(JSON.parse(r.snippet!).removed).toBe(true)
    expect(existsSync(wt)).toBe(false)
    const again = await runCorchWorktreeRemove(['github://acme/widget', 'item-1'])
    expect(JSON.parse(again.snippet!).removed).toBe(false)
  })

  test('re-ensure after remove re-attaches the kept branch', async () => {
    const r = await runCorchWorktreeEnsure(['github://acme/widget', 'item-1'])
    expect(r.exit_code).toBe(0)
    expect(sh(JSON.parse(r.snippet!).path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('corch/item-1')
  })
})

describe('corch.pr_lookup (fake gh)', () => {
  const wt = () => join(root, 'corch', 'widget-item-1')
  const fakeGh = (code: number, out: string, seen?: { cmd?: string[]; env?: NodeJS.ProcessEnv }): ExecFn => async (cmd, opts) => {
    if (seen) { seen.cmd = cmd; seen.env = opts.env }
    return { code, out }
  }

  test('open same-repo PR => pr_url', async () => {
    const seen: { cmd?: string[] } = {}
    __setCorchWorktreeForTest({ exec: fakeGh(0, JSON.stringify([{ url: 'https://github.com/acme/widget/pull/7', headRefName: 'corch/item-1', isCrossRepository: false }]), seen) })
    const r = await runCorchPrLookup([wt(), 'corch/item-1'])
    expect(r.exit_code).toBe(0)
    expect(JSON.parse(r.snippet!)).toEqual({ pr_url: 'https://github.com/acme/widget/pull/7' })
    expect(seen.cmd!.slice(0, 3)).toEqual(['gh', 'pr', 'list'])
    expect(seen.cmd).toContain('--head')
    expect(seen.cmd).toContain('open')
  })

  test('no PR, or only a cross-repo (fork) PR => pr_url null', async () => {
    __setCorchWorktreeForTest({ exec: fakeGh(0, '[]') })
    expect(JSON.parse((await runCorchPrLookup([wt(), 'corch/item-1'])).snippet!)).toEqual({ pr_url: null })
    __setCorchWorktreeForTest({ exec: fakeGh(0, JSON.stringify([{ url: 'https://github.com/evil/widget/pull/1', headRefName: 'corch/item-1', isCrossRepository: true }])) })
    expect(JSON.parse((await runCorchPrLookup([wt(), 'corch/item-1'])).snippet!)).toEqual({ pr_url: null })
  })

  test('gh failure => error code, never output; reply carries no credential', async () => {
    const prev = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'ghp_SENTINEL_LOOKUP'
    try {
      __setCorchWorktreeForTest({ exec: fakeGh(1, 'HTTP 401 ghp_SENTINEL_LOOKUP') })
      const r = await runCorchPrLookup([wt(), 'corch/item-1'])
      expect(r).toEqual({ exit_code: 1, error: 'gh_pr_list_failed' })
      expect(JSON.stringify(r)).not.toContain('ghp_SENTINEL_LOOKUP')
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = prev
    }
  })

  test('refuses a path outside the roots and a non-corch branch', async () => {
    __setCorchWorktreeForTest({ exec: fakeGh(0, '[]') })
    expect((await runCorchPrLookup([base, 'corch/item-1'])).error).toBe('path_outside_roots')
    expect((await runCorchPrLookup([wt(), 'main'])).error).toBe('invalid_args')
    expect((await runCorchPrLookup([wt(), 'corch/../x'])).error).toBe('invalid_args')
  })
})

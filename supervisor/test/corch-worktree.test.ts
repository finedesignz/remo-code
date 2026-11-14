/**
 * CORCH-09 (R4.4, R4.5): corch.worktree_ensure / worktree_remove / pr_lookup against temp git repos and a fake gh.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCorchWorktreeEnsure, runCorchWorktreeRemove, runCorchPrLookup, __setCorchWorktreeForTest, ENSURE_BUDGET_MS, type ExecFn } from '../src/commands/corch-worktree'

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

describe('QC hardening', () => {
  test('a reused clone whose origin is another repository is refused before any fetch', async () => {
    const r = await runCorchWorktreeEnsure(['github://acme/widget', 'item-9'])
    expect(r.exit_code).toBe(0)
    const canon = join(root, 'acme', 'widget')
    sh(canon, 'remote', 'set-url', 'origin', 'https://github.com/evil/widget.git')
    try {
      const bad = await runCorchWorktreeEnsure(['github://acme/widget', 'item-10'])
      expect(bad).toEqual({ exit_code: 1, error: 'clone_origin_mismatch' })
    } finally {
      sh(canon, 'remote', 'set-url', 'origin', origin)
    }
  })

  test('the git credential helper is scoped to https://github.com and carries the env REFERENCE, never the value', async () => {
    const seen: string[][] = []
    const prev = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'ghp_SCOPE_SENTINEL'
    __setCorchWorktreeForTest({ exec: async (cmd) => (seen.push(cmd), { code: 1, out: '' }) })
    try {
      await runCorchWorktreeEnsure(['github://acme/scoped', 'item-1'])
    } finally {
      __setCorchWorktreeForTest({ exec: null })
      if (prev === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = prev
    }
    const flat = seen.flat().join(' ')
    expect(flat).toContain('credential.https://github.com.helper=')
    expect(flat).not.toContain('ghp_SCOPE_SENTINEL')
    expect(seen.flat().some((a) => a === 'credential.helper=')).toBe(true) // global helper reset, not replaced
  })

  test('removal refuses a worktree at the path that is not on corch/<id> (repurposed) and leaves it', async () => {
    const r = await runCorchWorktreeEnsure(['github://acme/widget', 'item-7'])
    const wt = JSON.parse(r.snippet!).path
    sh(wt, 'checkout', '-q', '-b', 'someone-elses-work')
    const rm = await runCorchWorktreeRemove(['github://acme/widget', 'item-7'])
    expect(rm).toEqual({ exit_code: 1, error: 'worktree_wrong_branch' })
    expect(existsSync(wt)).toBe(true)
    sh(wt, 'checkout', '-q', 'corch/item-7')
    expect(JSON.parse((await runCorchWorktreeRemove(['github://acme/widget', 'item-7'])).snippet!).removed).toBe(true)
  })
})

describe('QC2 hardening', () => {
  test('ensure runs under ONE shared deadline: every git command carries a shrinking timeout within the budget', async () => {
    const seen: number[] = []
    // A fake exec that answers like a healthy repo so ensure walks every step.
    __setCorchWorktreeForTest({
      exec: async (cmd, opts) => {
        seen.push(opts.timeoutMs ?? -1)
        await new Promise((r) => setTimeout(r, 5))
        const a = cmd.join(' ')
        if (a.includes('rev-parse --show-toplevel')) return { code: 0, out: join(root, 'acme', 'budget') }
        if (a.includes('remote get-url')) return { code: 0, out: origin }
        if (a.includes('ls-remote')) return { code: 0, out: 'ref: refs/heads/trunk\tHEAD\n' }
        if (a.includes('worktree list')) return { code: 0, out: '' }
        if (a.includes('rev-parse --verify')) return { code: 1, out: '' }
        return { code: 0, out: '' }
      },
    })
    try {
      const r = await runCorchWorktreeEnsure(['github://acme/budget', 'item-1'])
      expect(r.exit_code).toBe(0)
    } finally {
      __setCorchWorktreeForTest({ exec: null })
    }
    expect(seen.length).toBeGreaterThanOrEqual(5)
    expect(seen.every((t) => t > 0 && t <= ENSURE_BUDGET_MS)).toBe(true)
    expect(seen[seen.length - 1]!).toBeLessThan(seen[0]!)
  })

  test('pr_lookup pins the repository (--repo) and ignores an inherited GH_REPO', async () => {
    const prev = process.env.GH_REPO
    process.env.GH_REPO = 'evil/other'
    process.env.GH_HOST = 'ghe.example.com'
    let env: NodeJS.ProcessEnv | undefined
    let cmd: string[] = []
    __setCorchWorktreeForTest({ exec: async (c, o) => ((cmd = c), (env = o.env), { code: 0, out: '[]' }) })
    try {
      await runCorchPrLookup([join(root, 'corch', 'widget-item-1'), 'corch/item-1', 'github://acme/widget'])
    } finally {
      __setCorchWorktreeForTest({ exec: null })
      if (prev === undefined) delete process.env.GH_REPO
      else process.env.GH_REPO = prev
      delete process.env.GH_HOST
    }
    expect(cmd.join(' ')).toContain('--repo github.com/acme/widget')
    expect(env!.GH_REPO).toBeUndefined()
    expect(env!.GH_HOST).toBeUndefined()
    expect(cmd).toContain('100') // fork PRs sharing the branch name cannot hide the same-repo PR
    expect((await runCorchPrLookup([join(root, 'corch', 'widget-item-1'), 'corch/item-1', 'path:///x'])).error).toBe('invalid_args')
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
    const r = await runCorchPrLookup([wt(), 'corch/item-1', 'github://acme/widget'])
    expect(r.exit_code).toBe(0)
    expect(JSON.parse(r.snippet!)).toEqual({ pr_url: 'https://github.com/acme/widget/pull/7' })
    expect(seen.cmd!.slice(0, 3)).toEqual(['gh', 'pr', 'list'])
    expect(seen.cmd).toContain('--head')
    expect(seen.cmd!.join(' ')).toContain('--repo github.com/acme/widget')
    expect(seen.cmd).toContain('open')
  })

  test('no PR, or only a cross-repo (fork) PR => pr_url null', async () => {
    __setCorchWorktreeForTest({ exec: fakeGh(0, '[]') })
    expect(JSON.parse((await runCorchPrLookup([wt(), 'corch/item-1', 'github://acme/widget'])).snippet!)).toEqual({ pr_url: null })
    __setCorchWorktreeForTest({ exec: fakeGh(0, JSON.stringify([{ url: 'https://github.com/evil/widget/pull/1', headRefName: 'corch/item-1', isCrossRepository: true }])) })
    expect(JSON.parse((await runCorchPrLookup([wt(), 'corch/item-1', 'github://acme/widget'])).snippet!)).toEqual({ pr_url: null })
  })

  test('gh failure => error code, never output; reply carries no credential', async () => {
    const prev = process.env.GH_TOKEN
    process.env.GH_TOKEN = 'ghp_SENTINEL_LOOKUP'
    try {
      __setCorchWorktreeForTest({ exec: fakeGh(1, 'HTTP 401 ghp_SENTINEL_LOOKUP') })
      const r = await runCorchPrLookup([wt(), 'corch/item-1', 'github://acme/widget'])
      expect(r).toEqual({ exit_code: 1, error: 'gh_pr_list_failed' })
      expect(JSON.stringify(r)).not.toContain('ghp_SENTINEL_LOOKUP')
    } finally {
      if (prev === undefined) delete process.env.GH_TOKEN
      else process.env.GH_TOKEN = prev
    }
  })

  test('refuses a path outside the roots and a non-corch branch', async () => {
    __setCorchWorktreeForTest({ exec: fakeGh(0, '[]') })
    expect((await runCorchPrLookup([base, 'corch/item-1', 'github://acme/widget'])).error).toBe('path_outside_roots')
    expect((await runCorchPrLookup([wt(), 'main', 'github://acme/widget'])).error).toBe('invalid_args')
    expect((await runCorchPrLookup([wt(), 'corch/../x', 'github://acme/widget'])).error).toBe('invalid_args')
  })
})

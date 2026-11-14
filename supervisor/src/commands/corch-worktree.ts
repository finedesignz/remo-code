/**
 * corch-worktree.ts - CORCH-09 (R4.4, R4.5): supervisor-native commands the central orchestrator hub drives over
 * the allowlisted `run_command` RPC on a headless slot supervisor.
 *
 *   corch.worktree_ensure  [repo_ident, work_item_id]  -> {path, branch, default_branch}
 *   corch.worktree_remove  [repo_ident, work_item_id]  -> {removed}
 *   corch.pr_lookup        [path, branch]              -> {pr_url: string | null}
 *
 * Invariants:
 *  - The worktree path and branch are DETERMINISTIC and derived here from validated identifiers, never taken
 *    from the hub as a path: `<root>/corch/<name>-<work_item_id>` on `corch/<work_item_id>`.
 *  - Every path passes the sandbox (`assertTargetWithinRoots` / `assertWithinRoots`) before git runs.
 *  - Replies carry paths, branch names and PR urls only. No env value, token or credential ever appears in a
 *    reply or an error string (git/gh output is never echoed back; errors are codes).
 *  - The git credential (GH_TOKEN / GITHUB_TOKEN of the slot) is read from this process's env and reaches git
 *    only through a credential helper that references the env var, never argv or the URL.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { sanitizeSpawnEnv } from '../runners/env-sanitize'
import { assertTargetWithinRoots, assertWithinRoots } from '../sandbox'
import type { CommandResult } from './index'

const REPO_IDENT_RE = /^github:\/\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})\/([A-Za-z0-9][A-Za-z0-9._-]{0,99})$/
const ITEM_ID_RE = /^[A-Za-z0-9-]{1,64}$/
const BRANCH_RE = /^corch\/[A-Za-z0-9-]{1,64}$/

export interface ExecResult {
  code: number
  out: string
}
export type ExecFn = (cmd: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }) => Promise<ExecResult>

/**
 * Per-command ceiling. It is BELOW the hub's RPC timeout (workspace.ts, 600s) so a stuck git/gh is killed here and
 * the hub always gets a real reply: the hub never has to give up on a command that is still mutating a worktree.
 */
export const EXEC_TIMEOUT_MS = 240_000

const REAL_EXEC: ExecFn = async (cmd, opts) => {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, env: opts.env, stdout: 'pipe', stderr: 'pipe' })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try { p.kill() } catch {}
  }, EXEC_TIMEOUT_MS)
  try {
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
    const code = await p.exited
    return { code: timedOut ? 124 : code, out: `${out}${err}` }
  } finally {
    clearTimeout(timer)
  }
}

let execImpl: ExecFn = REAL_EXEC
let rootsImpl: () => string[] = () => {
  // Lazy: loading the config must not happen at import time (tests, bundle order).
  const { loadConfig } = require('../config') as typeof import('../config')
  return loadConfig().roots ?? []
}
let cloneUrlImpl: (owner: string, name: string) => string = (o, n) => `https://github.com/${o}/${n}.git`

/** Test seams. */
export function __setCorchWorktreeForTest(o: { exec?: ExecFn | null; roots?: (() => string[]) | null; cloneUrl?: ((o: string, n: string) => string) | null }): void {
  if (o.exec !== undefined) execImpl = o.exec ?? REAL_EXEC
  if (o.roots !== undefined && o.roots !== null) rootsImpl = o.roots
  if (o.cloneUrl !== undefined && o.cloneUrl !== null) cloneUrlImpl = o.cloneUrl
}

/** The env every git/gh child gets: the supervisor's env minus provider credentials (GH_TOKEN/GITHUB_TOKEN stay). */
function childEnv(): NodeJS.ProcessEnv {
  return sanitizeSpawnEnv({ ...process.env }, { scrubDeployCredentials: true })
}

/** git args that authenticate https with the slot's GH_TOKEN/GITHUB_TOKEN by env reference (never by value). */
function authArgs(env: NodeJS.ProcessEnv): string[] {
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN) return []
  // Scoped to https://github.com ONLY: a clone whose origin points anywhere else never receives the token.
  const helper = '!f() { echo username=x-access-token; echo "password=${GH_TOKEN:-$GITHUB_TOKEN}"; }; f'
  return ['-c', 'credential.helper=', '-c', `credential.https://github.com.helper=${helper}`]
}

const git = (cwd: string | undefined, args: string[], env: NodeJS.ProcessEnv) =>
  execImpl(['git', ...authArgs(env), ...args], { cwd, env })

interface Layout {
  root: string
  owner: string
  name: string
  canonical: string
  worktree: string
  branch: string
}

function layoutFor(repoIdent: string | undefined, itemId: string | undefined): Layout | string {
  const m = REPO_IDENT_RE.exec(repoIdent ?? '')
  if (!m) return 'invalid_repo_ident'
  if (!ITEM_ID_RE.test(itemId ?? '')) return 'invalid_work_item_id'
  const [, owner, name] = m as unknown as [string, string, string]
  if (owner === '..' || name === '..' || owner === '.' || name === '.' || name.endsWith('.git')) return 'invalid_repo_ident'
  const root = rootsImpl()[0]
  if (!root) return 'no_root_configured'
  return {
    root: resolve(root),
    owner,
    name,
    canonical: join(resolve(root), owner, name),
    worktree: join(resolve(root), 'corch', `${name}-${itemId}`),
    branch: `corch/${itemId}`,
  }
}

async function sandboxCheck(path: string, existing: boolean): Promise<string | null> {
  const roots = rootsImpl()
  try {
    if (existing) await assertWithinRoots(path, roots)
    else await assertTargetWithinRoots(path, roots)
    return null
  } catch {
    return 'path_outside_roots'
  }
}

/** The remote default branch (never guessed): `git ls-remote --symref origin HEAD`. */
async function defaultBranch(cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await git(cwd, ['ls-remote', '--symref', 'origin', 'HEAD'], env)
  if (r.code !== 0) return null
  const m = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(r.out)
  return m ? m[1]! : null
}

const normUrl = (u: string): string => u.trim().replace(/\\/g, '/').replace(/\.git$/i, '').replace(/\/+$/, '').toLowerCase()

/** True when the canonical clone's root is the canonical path and its `origin` is exactly the expected remote. */
async function originMatches(lay: Layout, env: NodeJS.ProcessEnv): Promise<boolean> {
  const top = await git(lay.canonical, ['rev-parse', '--show-toplevel'], env)
  if (top.code !== 0 || normUrl(top.out) !== normUrl(lay.canonical)) return false
  const o = await git(lay.canonical, ['remote', 'get-url', 'origin'], env)
  return o.code === 0 && normUrl(o.out) === normUrl(cloneUrlImpl(lay.owner, lay.name))
}

export async function runCorchWorktreeEnsure(args: string[]): Promise<CommandResult> {
  const lay = layoutFor(args[0], args[1])
  if (typeof lay === 'string') return { exit_code: 1, error: lay }
  const env = childEnv()

  for (const p of [lay.canonical, lay.worktree]) {
    const bad = await sandboxCheck(p, false)
    if (bad) return { exit_code: 1, error: bad }
  }

  // 1. Canonical clone (https with the worker credential) when absent.
  const hasClone = (await git(lay.canonical, ['rev-parse', '--git-dir'], env).catch(() => ({ code: 1, out: '' }))).code === 0
  if (!hasClone) {
    mkdirSync(join(lay.root, lay.owner), { recursive: true })
    const c = await git(undefined, ['clone', cloneUrlImpl(lay.owner, lay.name), lay.canonical], env)
    if (c.code !== 0) return { exit_code: 1, error: 'git_clone_failed' }
  }

  // A reused clone must be THE requested repository: bind its origin before any authenticated operation.
  if (!(await originMatches(lay, env))) return { exit_code: 1, error: 'clone_origin_mismatch' }

  const fetched = await git(lay.canonical, ['fetch', 'origin', '--quiet'], env)
  if (fetched.code !== 0) return { exit_code: 1, error: 'git_fetch_failed' }
  const def = await defaultBranch(lay.canonical, env)
  if (!def) return { exit_code: 1, error: 'default_branch_unresolved' }

  // 2. Reuse an existing worktree of exactly this path on exactly this branch.
  const list = await git(lay.canonical, ['worktree', 'list', '--porcelain'], env)
  if (list.code !== 0) return { exit_code: 1, error: 'git_worktree_list_failed' }
  const block = list.out.split(/\r?\n\r?\n/).find((b) => b.split(/\r?\n/).some((l) => l === `worktree ${lay.worktree.replace(/\\/g, '/')}` || l === `worktree ${lay.worktree}`))
  if (block) {
    if (!block.split(/\r?\n/).includes(`branch refs/heads/${lay.branch}`)) return { exit_code: 1, error: 'worktree_wrong_branch' }
    return { exit_code: 0, snippet: JSON.stringify({ path: lay.worktree, branch: lay.branch, default_branch: def, reused: true }) }
  }

  // 3. Create it. A leftover local branch (worktree removed, branch kept) is attached instead of recreated.
  mkdirSync(join(lay.root, 'corch'), { recursive: true })
  const branchExists = (await git(lay.canonical, ['rev-parse', '--verify', '--quiet', `refs/heads/${lay.branch}`], env)).code === 0
  const add = branchExists
    ? await git(lay.canonical, ['worktree', 'add', lay.worktree, lay.branch], env)
    : await git(lay.canonical, ['worktree', 'add', lay.worktree, '-b', lay.branch, `origin/${def}`], env)
  if (add.code !== 0) return { exit_code: 1, error: 'git_worktree_add_failed' }
  return { exit_code: 0, snippet: JSON.stringify({ path: lay.worktree, branch: lay.branch, default_branch: def, reused: false }) }
}

export async function runCorchWorktreeRemove(args: string[]): Promise<CommandResult> {
  const lay = layoutFor(args[0], args[1])
  if (typeof lay === 'string') return { exit_code: 1, error: lay }
  const env = childEnv()
  for (const p of [lay.worktree, lay.canonical]) {
    const bad = await sandboxCheck(p, false)
    if (bad) return { exit_code: 1, error: bad }
  }
  const list = await git(lay.canonical, ['worktree', 'list', '--porcelain'], env)
  if (list.code !== 0) return { exit_code: 1, error: 'git_worktree_list_failed' }
  const norm = lay.worktree.replace(/\\/g, '/')
  const block = list.out
    .split(/\r?\n\r?\n/)
    .find((b) => b.split(/\r?\n/).some((l) => l === `worktree ${norm}` || l === `worktree ${lay.worktree}`))
  if (!block) return { exit_code: 0, snippet: JSON.stringify({ removed: false }) } // idempotent
  // Only a worktree on exactly corch/<id> is ours to force-remove; anything else was repurposed and is left alone.
  if (!block.split(/\r?\n/).includes(`branch refs/heads/${lay.branch}`)) return { exit_code: 1, error: 'worktree_wrong_branch' }
  const rm = await git(lay.canonical, ['worktree', 'remove', '--force', lay.worktree], env)
  if (rm.code !== 0) return { exit_code: 1, error: 'git_worktree_remove_failed' }
  return { exit_code: 0, snippet: JSON.stringify({ removed: true }) }
}

export async function runCorchPrLookup(args: string[]): Promise<CommandResult> {
  const [path, branch] = args
  if (!path || !BRANCH_RE.test(branch ?? '')) return { exit_code: 1, error: 'invalid_args' }
  const bad = await sandboxCheck(path, true)
  if (bad) return { exit_code: 1, error: bad }
  const env = childEnv()
  const r = await execImpl(
    ['gh', 'pr', 'list', '--head', branch!, '--state', 'open', '--json', 'url,headRefName,isCrossRepository', '--limit', '5'],
    { cwd: path, env },
  )
  if (r.code !== 0) return { exit_code: 1, error: 'gh_pr_list_failed' }
  let rows: Array<{ url?: unknown; headRefName?: unknown; isCrossRepository?: unknown }>
  try {
    rows = JSON.parse(r.out)
  } catch {
    return { exit_code: 1, error: 'gh_output_unparseable' }
  }
  if (!Array.isArray(rows)) return { exit_code: 1, error: 'gh_output_unparseable' }
  const hit = rows.find((x) => x.headRefName === branch && x.isCrossRepository === false && typeof x.url === 'string')
  return { exit_code: 0, snippet: JSON.stringify({ pr_url: hit ? (hit.url as string) : null }) }
}

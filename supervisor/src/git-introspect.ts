// supervisor/src/git-introspect.ts
//
// Phase 08: deterministic git introspection. SECURITY: every subprocess call
// uses execFile with an arg-vector — never shell:true, never string
// concatenation of `cwd`. `cwd` is passed via the `-C` flag (still as a
// separate argv entry), so even pathological paths (spaces, ampersands,
// backticks) cannot inject. Wrapped in try/catch — failures yield null/false
// defaults; this module never throws.
//
// 2026-08-18 (fix/session-start-freeze) — was `spawnSync`. `scanRoots()`
// calls this once per candidate directory with no yield in between; against
// a real ~300-directory roots tree that meant 300 * ~5 spawnSync calls =
// minutes of the single-threaded supervisor process being fully unable to do
// anything else (verified live: the loopback status HTTP server stopped
// answering entirely, session_inventory's push never got a chance to start,
// and an inbound `session.start` WS frame sat unprocessed until the scan
// finished). `execFile` hands the actual subprocess wait to libuv's thread
// pool instead of blocking the JS main thread, so the event loop stays
// genuinely free between (and during) these calls — not merely yielded
// cooperatively. This is the root-cause fix; a `setImmediate` yield in the
// caller's loop was a starvation-bound mitigation on top of the same
// underlying blocking calls and is no longer needed once the calls
// themselves are non-blocking.

import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { parseGitRemote, type GitOriginGithub } from '../../hub/src/lib/repo-key'

const execFileAsync = promisify(execFile)

export type GitIntrospection = {
  is_git_repo: boolean
  is_worktree: boolean
  worktree_parent_path: string | null
  git_remote: string | null
  git_origin_github: GitOriginGithub | null
  /** Current branch name (e.g. `main`, `feat/foo`) or null when detached/unknown. */
  branch: string | null
}

async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    // NEVER shell:true. NEVER concatenate args.
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    })
    return { ok: true, stdout: stdout ?? '' }
  } catch {
    // Non-zero exit, spawn failure, or missing git — all treated as "no answer".
    return { ok: false, stdout: '' }
  }
}

export async function introspect(cwd: string): Promise<GitIntrospection> {
  const out: GitIntrospection = {
    is_git_repo: false,
    is_worktree: false,
    worktree_parent_path: null,
    git_remote: null,
    git_origin_github: null,
    branch: null,
  }

  // 1. Is a git repo?
  const gd = await runGit(cwd, ['rev-parse', '--git-dir'])
  if (!gd.ok) return out
  out.is_git_repo = true

  // 2. Is a worktree? Canonical: compare --git-dir to --git-common-dir.
  try {
    const gitDirRes = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])
    const commonRes = await runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (gitDirRes.ok && commonRes.ok) {
      const gitDirAbs = gitDirRes.stdout.trim()
      const commonAbs = commonRes.stdout.trim()
      if (gitDirAbs && commonAbs && gitDirAbs !== commonAbs) {
        out.is_worktree = true
        // common is `.../<repo>/.git` → parent is `.../<repo>`
        out.worktree_parent_path = dirname(commonAbs)
      }
    }
  } catch {
    /* fall through to file-sniff */
  }

  // 3. Backup: sniff <cwd>/.git as a file with `gitdir:` prefix.
  if (!out.is_worktree) {
    try {
      const dotGit = join(cwd, '.git')
      if (existsSync(dotGit)) {
        const st = statSync(dotGit)
        if (st.isFile()) {
          const txt = readFileSync(dotGit, 'utf8').trim()
          if (txt.startsWith('gitdir:')) {
            const target = txt.slice('gitdir:'.length).trim()
            if (target.includes('/.git/worktrees/') || target.includes('\\.git\\worktrees\\')) {
              out.is_worktree = true
              // `.../<repo>/.git/worktrees/<name>` → parent (3 dirnames up) is `.../<repo>`
              out.worktree_parent_path = dirname(dirname(dirname(target)))
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 4. Origin URL.
  const remote = await runGit(cwd, ['remote', 'get-url', 'origin'])
  if (remote.ok) {
    const url = remote.stdout.trim()
    if (url) out.git_remote = url
  }

  // 5. Parse → github origin (or null).
  out.git_origin_github = parseGitRemote(out.git_remote)

  // 6. Current branch name. `symbolic-ref --short HEAD` returns the branch on
  //    success and exits non-zero on detached-HEAD — runGit swallows that and
  //    we leave `branch` as null.
  const br = await runGit(cwd, ['symbolic-ref', '--short', 'HEAD'])
  if (br.ok) {
    const name = br.stdout.trim()
    if (name) out.branch = name
  }

  return out
}

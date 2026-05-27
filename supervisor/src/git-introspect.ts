// supervisor/src/git-introspect.ts
//
// Phase 08: deterministic git introspection. Pure, synchronous. SECURITY:
// every subprocess call uses spawnSync with an arg-vector — never shell:true,
// never string concatenation of `cwd`. `cwd` is passed via the `-C` flag (still
// as a separate argv entry), so even pathological paths (spaces, ampersands,
// backticks) cannot inject. Wrapped in try/catch — failures yield null/false
// defaults; this module never throws.

import { spawnSync } from 'child_process'
import { existsSync, readFileSync, statSync } from 'fs'
import { dirname, join } from 'path'
import { parseGitRemote, type GitOriginGithub } from '../../hub/src/lib/repo-key'

export type GitIntrospection = {
  is_git_repo: boolean
  is_worktree: boolean
  worktree_parent_path: string | null
  git_remote: string | null
  git_origin_github: GitOriginGithub | null
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  try {
    const r = spawnSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      // NEVER shell:true. NEVER concatenate args.
      shell: false,
      windowsHide: true,
    })
    if (r.error) return { ok: false, stdout: '' }
    if (typeof r.status === 'number' && r.status !== 0) return { ok: false, stdout: '' }
    return { ok: true, stdout: (r.stdout ?? '').toString() }
  } catch {
    return { ok: false, stdout: '' }
  }
}

export function introspect(cwd: string): GitIntrospection {
  const out: GitIntrospection = {
    is_git_repo: false,
    is_worktree: false,
    worktree_parent_path: null,
    git_remote: null,
    git_origin_github: null,
  }

  // 1. Is a git repo?
  const gd = runGit(cwd, ['rev-parse', '--git-dir'])
  if (!gd.ok) return out
  out.is_git_repo = true

  // 2. Is a worktree? Canonical: compare --git-dir to --git-common-dir.
  try {
    const gitDirRes = runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-dir'])
    const commonRes = runGit(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
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
  const remote = runGit(cwd, ['remote', 'get-url', 'origin'])
  if (remote.ok) {
    const url = remote.stdout.trim()
    if (url) out.git_remote = url
  }

  // 5. Parse → github origin (or null).
  out.git_origin_github = parseGitRemote(out.git_remote)

  return out
}

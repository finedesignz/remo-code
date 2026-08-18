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
// finished). `execFile` hands each subprocess WAIT to libuv's thread pool
// instead of blocking the JS main thread, so the event loop is free while a
// git call is in flight — measured worst-case event-loop lag against the
// real ~300-candidate roots tree dropped from "the whole scan" (4m07s) to
// 596ms (the still-synchronous directory walk + per-candidate stat calls in
// repo-scanner.ts, not this file). Not "genuinely free" in an absolute sense
// — there is still synchronous work elsewhere in the scan path — but the
// multi-minute total-lockout defect this file caused is gone. A `setImmediate`
// yield in the caller's loop was tried first as a starvation-bound mitigation
// on top of the same underlying blocking calls; superseded by this fix.

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

// 2026-08-18 QC (D3) — `spawnSync` had no timeout either, so a hung git was
// never a NEW hazard, but the consequence changed: before, a hang blocked the
// loop visibly; now it silently holds one of `mapWithConcurrency`'s 8 slots
// forever, `scanRoots()` never resolves, and `sendRepoInventory()`'s callers
// only `.catch()` — the inventory silently stops updating for the rest of the
// process's life and the child leaks. Symmetric with the sandbox-check half
// of this fix (SANDBOX_FS_TIMEOUT_MS in sandbox.ts): bound every git spawn.
const GIT_SPAWN_TIMEOUT_MS = 5_000

async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    // NEVER shell:true. NEVER concatenate args.
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
      timeout: GIT_SPAWN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    })
    return { ok: true, stdout: stdout ?? '' }
  } catch {
    // Non-zero exit, spawn failure, timeout, or missing git — all treated as
    // "no answer". A timed-out call still resolves (rejects) within
    // GIT_SPAWN_TIMEOUT_MS, so this never blocks past that bound.
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

/**
 * 2026-08-18 QC (D1) — cheap, git-spawn-free resolution of which on-disk
 * files determine whether a cached `introspect()` result for `cwd` might be
 * stale. Used by `repo-scanner.ts`'s cache key. Deliberately mirrors the same
 * `.git`-file worktree sniff as step 3 of `introspect()` above (same target
 * pattern, same `dirname` chain) so the two can't drift apart — this is the
 * single source of truth for "which files, if touched, mean this result is
 * no longer trustworthy":
 *
 *   - `.git` is a directory (canonical / non-worktree checkout): HEAD lives at
 *     `.git/HEAD`, remotes at `.git/config`. Both live directly under `.git`.
 *   - `.git` is a `gitdir:` file pointing at `<repo>/.git/worktrees/<name>`
 *     (a worktree): that directory holds this worktree's OWN `HEAD` (branch
 *     switches inside the worktree do NOT touch the top-level worktree
 *     directory's mtime, and do NOT touch `.git` since it's a plain file that
 *     never changes) — but NOT its own `config`; remotes are shared via the
 *     canonical repo's config two `dirname()`s up, same derivation
 *     `introspect()` uses for `worktree_parent_path`.
 *   - Anything else (non-repo, unreadable, unrecognized `gitdir:` shape):
 *     both paths come back null — the caller must treat this as "no reliable
 *     staleness signal", not "nothing ever changes here".
 *
 * Never spawns git; only stats/reads `.git` itself, so it's safe to call
 * before deciding whether `introspect()` (which does spawn git) is needed.
 */
export interface GitCacheKeyPaths {
  headPath: string | null
  configPath: string | null
}

export function resolveGitCacheKeyPaths(cwd: string): GitCacheKeyPaths {
  const dotGit = join(cwd, '.git')
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(dotGit)
  } catch {
    return { headPath: null, configPath: null }
  }

  if (st.isDirectory()) {
    return { headPath: join(dotGit, 'HEAD'), configPath: join(dotGit, 'config') }
  }

  if (st.isFile()) {
    try {
      const txt = readFileSync(dotGit, 'utf8').trim()
      if (txt.startsWith('gitdir:')) {
        const target = txt.slice('gitdir:'.length).trim()
        if (target.includes('/.git/worktrees/') || target.includes('\\.git\\worktrees\\')) {
          // `.../<repo>/.git/worktrees/<name>` → up two levels is `.../<repo>/.git`,
          // where the shared (canonical) config lives.
          const commonGitDir = dirname(dirname(target))
          return { headPath: join(target, 'HEAD'), configPath: join(commonGitDir, 'config') }
        }
      }
    } catch {
      /* fall through to null below */
    }
  }

  // Unrecognized shape — no trustworthy signal.
  return { headPath: null, configPath: null }
}

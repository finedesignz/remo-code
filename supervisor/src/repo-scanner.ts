import { readdirSync, statSync, existsSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { introspect } from './git-introspect'
import type { ScanSettings } from './config'

export interface ScannedRepo {
  path: string
  name: string
  remote: string | null
  branch: string | null
  dirty: boolean
  last_commit: string | null
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory() } catch { return false }
}

function readRemote(repoPath: string): string | null {
  try {
    const cfgPath = join(repoPath, '.git', 'config')
    if (!existsSync(cfgPath)) return null
    const cfg = readFileSync(cfgPath, 'utf-8')
    const m = cfg.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/m)
    return m ? m[1].trim() : null
  } catch { return null }
}

function readBranch(repoPath: string): string | null {
  try {
    const headPath = join(repoPath, '.git', 'HEAD')
    if (!existsSync(headPath)) return null
    const head = readFileSync(headPath, 'utf-8').trim()
    if (head.startsWith('ref: refs/heads/')) return head.slice('ref: refs/heads/'.length)
    return head.slice(0, 12)
  } catch { return null }
}

// Note: deliberately avoiding `git status` / `git log` here — spawning git for every repo
// makes scan O(N) slow on Windows (~200ms per spawn). dirty/last_commit can be loaded
// lazily on demand if needed; for the picker we only need name, remote, branch.

export function scanRoot(root: string): ScannedRepo[] {
  const out: ScannedRepo[] = []
  if (!isDir(root)) return out
  let entries: string[] = []
  try { entries = readdirSync(root) } catch { return out }
  for (const entry of entries) {
    if (entry.startsWith('.')) continue
    const path = join(root, entry)
    if (!isDir(path)) continue
    if (!existsSync(join(path, '.git'))) continue
    out.push({
      path: path.replace(/\\/g, '/'),
      name: basename(path),
      remote: readRemote(path),
      branch: readBranch(path),
      dirty: false,
      last_commit: null,
    })
  }
  return out
}

export function scanAll(roots: string[]): ScannedRepo[] {
  const all: ScannedRepo[] = []
  const seen = new Set<string>()
  for (const r of roots) {
    for (const repo of scanRoot(r)) {
      if (seen.has(repo.path)) continue
      seen.add(repo.path)
      all.push(repo)
    }
  }
  return all.sort((a, b) => a.name.localeCompare(b.name))
}

// ============================================================================
// Phase 08 §15 — full git-introspection scan with worktree grouping.
//
// `scanRoots(cfg)` walks each root up to `cfg.scan.max_depth`, runs the shared
// `introspect()` per candidate dir, builds `RepoEntry[]`, deduplicates worktrees
// that share the same GitHub `origin`, and stamps the canonical entry. This is
// the contract consumed by the hub (see `SupervisorRepoInventory` in
// `hub/src/ws/supervisor-protocol.ts`).
//
// Why a second scanner: the existing `scanAll`/`scanRoot` above is the legacy
// Phase 07 picker that returns `ScannedRepo` (name/remote/branch shape used by
// `repo.scan` over WS). Phase 08 needs introspection metadata (worktree
// parent, github origin parse, canonical flag) — different shape, different
// consumers. Both coexist; we'll retire the legacy one when Phase 09 deletes
// the picker.
// ============================================================================

export interface RepoEntry {
  /** Absolute local path, forward-slash normalized for cross-platform parity. */
  local_path: string
  is_git_repo: boolean
  is_worktree: boolean
  worktree_parent_path: string | null
  git_remote: string | null
  git_origin_github: { owner: string; repo: string } | null
  /** Current branch (null when detached or unreadable). */
  branch: string | null
  /**
   * True for the canonical entry within a GitHub-keyed worktree group:
   * non-worktree wins; tiebreak by shorter `local_path.length`. Always `true`
   * for entries that have no `git_origin_github` (each is its own group).
   */
  canonical: boolean
}

// --- minimal glob matcher (no extra deps) -----------------------------------
// Supports the patterns we actually ship in DEFAULT_SCAN_SETTINGS:
//   `**/segment/**` — match any path containing `/segment/`
//   `segment`       — match if a path segment equals `segment` (rare case)
// Match is performed against the forward-slash normalized absolute path. This
// is intentionally a strict subset of picomatch; the defaults exercise only
// the `**/x/**` shape so the surface stays tiny + audit-friendly.
function compileIgnoreGlob(pattern: string): RegExp {
  // Normalize to forward slashes (matches the paths we feed in).
  const p = pattern.replace(/\\/g, '/')
  if (/^\*\*\/[^/*]+\/\*\*$/.test(p)) {
    const seg = p.slice(3, p.length - 3)
    const esc = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`/${esc}(/|$)`)
  }
  // Generic fallback: convert `**` → `.*`, `*` → `[^/]*`, escape the rest.
  const re = p
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLESTAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/__DOUBLESTAR__/g, '.*')
  return new RegExp(`(?:^|/)${re}(?:/|$)`)
}

function shouldIgnore(absPath: string, compiledGlobs: RegExp[]): boolean {
  const norm = absPath.replace(/\\/g, '/')
  for (const re of compiledGlobs) if (re.test(norm)) return true
  return false
}

function isDirSafe(p: string, followSymlinks: boolean): boolean {
  try {
    const st = followSymlinks ? statSync(p) : statSync(p, { throwIfNoEntry: false } as any)
    if (!st) return false
    if (!followSymlinks) {
      // statSync follows symlinks by default; use lstat semantics via a second call.
      try {
        const ls = (require('fs') as typeof import('fs')).lstatSync(p)
        if (ls.isSymbolicLink()) return false
      } catch {}
    }
    return st.isDirectory()
  } catch {
    return false
  }
}

/**
 * Build the candidate-directory list for a single root.
 *
 * Depth semantics (matches ARCHITECTURE §15: "repos are at depth 1, worktree
 * siblings at depth 0/1"):
 *   - The root itself is treated as a candidate too (a root may itself BE a
 *     repo).
 *   - Each child directory at depth 1..max_depth is a candidate.
 *   - Ignored globs prune both the candidate and its descendants.
 */
function walkRoot(root: string, settings: ScanSettings, compiledGlobs: RegExp[]): string[] {
  const out: string[] = []
  const norm = (p: string) => p.replace(/\\/g, '/')
  if (!isDirSafe(root, settings.follow_symlinks)) return out

  // Include the root itself as a candidate at depth 0.
  out.push(norm(root))

  function visit(dir: string, depth: number) {
    if (depth >= settings.max_depth) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      if (name === '.git') continue // never recurse into .git itself
      const child = join(dir, name)
      if (shouldIgnore(child, compiledGlobs)) continue
      if (!isDirSafe(child, settings.follow_symlinks)) continue
      out.push(norm(child))
      visit(child, depth + 1)
    }
  }
  visit(root, 0)
  return out
}

/**
 * Scan all configured roots → flat list of `RepoEntry`. Per ARCHITECTURE §15:
 *   1. Walk roots up to `max_depth`, honoring `ignore_globs`.
 *   2. Run `introspect(dir)` on each candidate.
 *   3. Group entries sharing `git_origin_github`; stamp one `canonical: true`
 *      per group (non-worktree > shorter path).
 *   4. Local-only / non-git dirs ARE returned (the hub upserts them into
 *      `pending_local_repos`); each is its own canonical=true group.
 *   5. Dirs where introspection finds no `.git` AND they're not a root are
 *      dropped — we don't want to flood the hub with every workspace folder.
 */
export async function scanRoots(cfg: {
  roots: string[]
  scan: ScanSettings
}): Promise<RepoEntry[]> {
  const compiled = cfg.scan.ignore_globs.map(compileIgnoreGlob)
  const candidatesPerRoot = cfg.roots.map((r) => walkRoot(r, cfg.scan, compiled))

  // Dedupe candidate paths across roots (overlapping roots are common).
  const seen = new Set<string>()
  const allCandidates: string[] = []
  for (const list of candidatesPerRoot) {
    for (const p of list) {
      if (seen.has(p)) continue
      seen.add(p)
      allCandidates.push(p)
    }
  }

  // Introspect. Synchronous spawnSync per dir — fine for the scale we target
  // (hundreds of dirs at depth≤2). We wrap in Promise.resolve to keep the API
  // async for future I/O concurrency.
  const rootSet = new Set(cfg.roots.map((r) => r.replace(/\\/g, '/')))
  const entries: RepoEntry[] = []
  for (const path of allCandidates) {
    const gi = introspect(path)
    if (!gi.is_git_repo) {
      // Only emit non-repo entries that ARE a configured root — those become
      // pending_local_repos. Skipping every other plain workspace folder.
      if (!rootSet.has(path)) continue
    }
    entries.push({
      local_path: path,
      is_git_repo: gi.is_git_repo,
      is_worktree: gi.is_worktree,
      worktree_parent_path: gi.worktree_parent_path,
      git_remote: gi.git_remote,
      git_origin_github: gi.git_origin_github,
      branch: gi.branch,
      canonical: true, // overwritten below for grouped entries
    })
  }

  // Group by github origin (owner/repo, lower-cased per `parseGitRemote`).
  const groups = new Map<string, RepoEntry[]>()
  for (const e of entries) {
    if (!e.git_origin_github) continue
    const key = `${e.git_origin_github.owner}/${e.git_origin_github.repo}`.toLowerCase()
    const arr = groups.get(key) ?? []
    arr.push(e)
    groups.set(key, arr)
  }

  for (const arr of groups.values()) {
    if (arr.length <= 1) continue
    // canonical pick: non-worktree wins; tiebreak shorter path.
    arr.sort((a, b) => {
      if (a.is_worktree !== b.is_worktree) return a.is_worktree ? 1 : -1
      return a.local_path.length - b.local_path.length
    })
    for (let i = 0; i < arr.length; i++) arr[i].canonical = i === 0
  }

  return entries
}


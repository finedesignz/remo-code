import { readdirSync, statSync, existsSync, readFileSync } from 'fs'
import { join, basename } from 'path'
import { introspect, resolveGitCacheKeyPaths, type GitIntrospection } from './git-introspect'
import type { ScanSettings } from './config'

/** Cap on concurrent `introspect()` calls during a `scanRoots()` pass. Each
 *  call spawns up to 5 git subprocesses via `execFile` (off the JS thread via
 *  libuv), so this bounds concurrent child-process/file-handle pressure
 *  rather than event-loop time. */
const INTROSPECT_CONCURRENCY = 8

/**
 * 2026-08-18 QC (D6) — hard cap on cache size. Entries are only ever added
 * for paths that produced a trustworthy (non -1) key, so the cache tracks
 * roughly the live candidate set (a few hundred here) — this cap is a
 * backstop against unbounded growth if a long-lived process scans many
 * different roots over its lifetime (scratch dirs, temp clones, etc.), not a
 * bound expected to bind in normal operation.
 *
 * D6-R2 (QC round 2, comment correction) — eviction below is FIFO by FIRST
 * INSERTION, not "oldest by use": `Map.set()` on an already-present key does
 * NOT move it in iteration order, only replaces its value, so a refreshed
 * hot entry keeps its original position and can be evicted before a colder
 * entry inserted later. Purely cosmetic at the scale this actually runs at
 * (cache size never approaches this cap — see above), but the eviction
 * policy is FIFO, not LRU; don't rely on it behaving like the latter.
 */
const INTROSPECT_CACHE_MAX_ENTRIES = 2_000

/**
 * 2026-08-18 (fix/session-start-freeze) — per-path introspection cache.
 * Process-lifetime — cleared implicitly on supervisor restart, which is
 * fine: a restart already pays a fresh scan, same as before this change.
 *
 * 2026-08-18 QC (D1) — the cache key USED TO BE just `mtime('.git/HEAD')`
 * (falling back to the directory's own mtime). Proven stale two ways on live
 * git repos:
 *   (a) Worktrees: `.git` is a FILE there, so `stat('<path>/.git/HEAD')`
 *       always threw ENOENT and the key silently degraded to the worktree
 *       directory's own mtime — which a branch switch inside the worktree
 *       does NOT change. Every worktree reported its first-scan branch for
 *       the rest of the process's life.
 *   (b) `git remote add` / `git remote set-url` write `.git/config`, which
 *       touches neither `.git/HEAD` nor the directory — so `git_remote` and
 *       `git_origin_github` (the grouping/dedup key for the whole
 *       worktree-canonical computation below) went permanently stale too.
 *
 * Fixed: the key now folds in BOTH `HEAD` and `config` mtimes, resolved via
 * `resolveGitCacheKeyPaths()` (git-introspect.ts) — the single source of
 * truth for "which files does introspect() actually depend on", including
 * the worktree case (own `HEAD`, but the canonical repo's SHARED `config`
 * two levels up). When neither path can be trusted (non-repo, unreadable,
 * unrecognized `gitdir:` shape), the key is `-1` and `introspectCached`
 * treats that as DO-NOT-CACHE — always re-introspect, never store under `-1`
 * (an unreadable key isn't a valid cache entry; storing it just accumulates
 * dead weight, which was D6 the first time around).
 */
const introspectCache = new Map<string, { key: number; result: GitIntrospection }>()

function introspectCacheKey(path: string): number {
  const { headPath, configPath } = resolveGitCacheKeyPaths(path)
  if (!headPath && !configPath) {
    // No git structure recognized at all (plain non-repo candidate, or an
    // unrecognized `.git` shape) — fall back to the directory's own mtime.
    // Valid enough for `is_git_repo:false`: that only flips if a `.git`
    // appears, which touches the directory.
    try {
      return statSync(path).mtimeMs
    } catch {
      return -1
    }
  }
  let headMtime = -1
  let configMtime = -1
  if (headPath) {
    try {
      headMtime = statSync(headPath).mtimeMs
    } catch {
      headMtime = -1
    }
  }
  if (configPath) {
    try {
      configMtime = statSync(configPath).mtimeMs
    } catch {
      configMtime = -1
    }
  }
  if (headMtime === -1 && configMtime === -1) return -1
  // Combine into one comparable number. These are independent timestamps —
  // collision requires both to change by exactly offsetting amounts between
  // scans, which is acceptable for a staleness heuristic (not a security
  // boundary; the worst case is one extra re-introspect, not a wrong result).
  return (headMtime === -1 ? 0 : headMtime) + (configMtime === -1 ? 0 : configMtime)
}

async function introspectCached(path: string): Promise<GitIntrospection> {
  const key = introspectCacheKey(path)
  if (key === -1) {
    // No trustworthy staleness signal — never cache, always fresh. (D1/D6)
    return introspect(path)
  }
  const cached = introspectCache.get(path)
  if (cached && cached.key === key) {
    return cached.result
  }
  const result = await introspect(path)
  if (introspectCache.size >= INTROSPECT_CACHE_MAX_ENTRIES && !introspectCache.has(path)) {
    // FIFO eviction by first-insertion order — see D6-R2 note above.
    const oldest = introspectCache.keys().next().value
    if (oldest !== undefined) introspectCache.delete(oldest)
  }
  introspectCache.set(path, { key, result })
  return result
}

/** Bounded-concurrency `Promise.all`-style map — runs at most `limit` calls
 *  to `fn` at once, preserving input order in the returned array. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

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

/**
 * `.git` as a FILE (not directory) means this is a git WORKTREE attached to
 * another canonical repo. We filter those out of the picker so worktrees like
 * `remo-code-fix-ui-cleanups-post-phase08` don't show up alongside the canonical
 * `remo-code`. Cheap FS-only check (no git spawn) — keeps the legacy picker hot.
 */
function isWorktreeMarker(repoPath: string): boolean {
  try {
    const dotGit = join(repoPath, '.git')
    const st = statSync(dotGit)
    return st.isFile()
  } catch { return false }
}

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
    if (isWorktreeMarker(path)) continue // skip git worktrees — canonical repo will be listed separately
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
      // Descent guard: if `child` is itself a git repo or worktree (has `.git`
      // as a dir or a file), record it as a candidate but DO NOT recurse into
      // its subdirs. Otherwise the walker walks into `.github`, `.planning`,
      // `.turbo`, `src/`, etc., and `introspect()` reports each as a separate
      // repo (with the same origin) — producing hundreds of phantom entries.
      // The repo itself is the boundary.
      if (existsSync(join(child, '.git'))) continue
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
/**
 * 2026-08-18 QC (D7, revised after D7-R2) — `scanRoots()` is re-entrant now
 * that it no longer blocks: `hub-client.ts` fires `void this.sendRepoInventory()`
 * from three separate call sites (initial `auth_ok`, config-change re-emit,
 * rescan request) with no coordination between them. Before this PR, the
 * previous blocking implementation serialized overlapping calls BY ACCIDENT
 * — one scan monopolized the process, so a second couldn't even start until
 * the first returned. Now two overlapping reconnects could otherwise run two
 * full scans concurrently (16 git children instead of 8).
 *
 * D7-R2 (QC round 2, BLOCKER): the first version of this guard returned the
 * SAME in-flight promise for ANY call while one was running, without
 * comparing `cfg` — so a `set_roots` call landing mid-scan got back the
 * FIRST caller's (stale) roots, silently. That's exactly the case this guard
 * must not break: `set_roots`/rescan exist precisely because the cached
 * answer is not good enough anymore. On `main` this could not happen — the
 * blocking scan serialized overlapping calls, so a second call always ran
 * fresh once the first returned.
 *
 * Fixed: the guard is now keyed on `cfg` (roots + scan settings).
 *   - A call whose cfg matches the in-flight scan's cfg shares that promise
 *     (the dedup this guard exists for).
 *   - A call with a DIFFERENT cfg while a scan is running does NOT start a
 *     second concurrent scan (that would defeat the guard's purpose) —
 *     instead it queues behind the current one. At most one scan is queued;
 *     a further call while one is already queued merges into it (only the
 *     LATEST cfg is actually scanned — an intermediate cfg is moot once a
 *     newer one has superseded it), and every caller that queued gets
 *     settled from that one follow-up scan's result.
 *   - The guard clears in `.finally()`, so a failed/rejected scan can never
 *     wedge it — the queued follow-up (if any) still runs.
 *
 * CONTRACT — "latest cfg wins": when several distinct-cfg calls queue behind
 * one in-flight scan, only the LAST one queued is actually scanned; every
 * caller that queued (including ones whose own cfg got superseded) is
 * settled from that single follow-up's result, not from a scan of their own
 * specific cfg. This is correct for every current call site: all of
 * `hub-client.ts`'s callers read off the ONE mutating `SupervisorClient`
 * config, so "the latest cfg" and "MY cfg" are the same object by the time
 * the follow-up runs. It would be WRONG if a second, independently-configured
 * `SupervisorClient` (or any caller with genuinely different, still-relevant
 * roots) ever coexisted in the same process — a superseded caller's cfg would
 * silently never be honored. There is no such caller today; if one is ever
 * added, this guard needs a keyed queue (one pending slot per distinct cfg),
 * not a single one.
 */
interface QueuedScanRoots {
  cfg: { roots: string[]; scan: ScanSettings }
  key: string
  resolvers: Array<(p: Promise<RepoEntry[]>) => void>
}

let scanRootsInFlight: { key: string; promise: Promise<RepoEntry[]> } | null = null
let scanRootsQueued: QueuedScanRoots | null = null

function scanRootsCfgKey(cfg: { roots: string[]; scan: ScanSettings }): string {
  return JSON.stringify({ roots: cfg.roots, scan: cfg.scan })
}

export function scanRoots(cfg: { roots: string[]; scan: ScanSettings }): Promise<RepoEntry[]> {
  const key = scanRootsCfgKey(cfg)

  if (!scanRootsInFlight) {
    return startScanRoots(cfg, key)
  }
  if (scanRootsInFlight.key === key) {
    return scanRootsInFlight.promise
  }

  // Different cfg while a scan is running — queue exactly one follow-up
  // (using the latest cfg), settle every queued caller from its result.
  return new Promise<RepoEntry[]>((resolve, reject) => {
    const resolver = (p: Promise<RepoEntry[]>) => p.then(resolve, reject)
    if (scanRootsQueued) {
      scanRootsQueued.cfg = cfg
      scanRootsQueued.key = key
      scanRootsQueued.resolvers.push(resolver)
    } else {
      scanRootsQueued = { cfg, key, resolvers: [resolver] }
    }
  })
}

function startScanRoots(cfg: { roots: string[]; scan: ScanSettings }, key: string): Promise<RepoEntry[]> {
  const p = scanRootsInner(cfg).finally(() => {
    scanRootsInFlight = null
    if (scanRootsQueued) {
      const next = scanRootsQueued
      scanRootsQueued = null
      const nextPromise = startScanRoots(next.cfg, next.key)
      for (const resolver of next.resolvers) resolver(nextPromise)
    }
  })
  scanRootsInFlight = { key, promise: p }
  return p
}

async function scanRootsInner(cfg: {
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

  // 2026-08-18 (fix/session-start-freeze) — ROOT CAUSE (not a mitigation):
  // introspect() used to run 3-5 `spawnSync` git calls per candidate
  // directory. spawnSync blocks Bun's single main thread for the full
  // subprocess wait; called from a plain for-loop with no `await` inside, a
  // 303-candidate scan of a real roots tree (C:\Users\artic\GitHub) live-
  // reproduced as 4m07s of UNINTERRUPTED blocking — the loopback status
  // server stopped answering HTTP entirely, session_inventory's 10s push
  // never got a chance to start, and an inbound `session.start` WS frame
  // landing mid-scan sat unprocessed until the scan finished. This fires
  // unconditionally on every hub reconnect (sendRepoInventory, called right
  // after `hello`), so every reconnect froze the process.
  //
  // Fixed at the source in git-introspect.ts: `introspect()` now uses
  // `execFile` (libuv thread pool) instead of blocking on every git spawn. A
  // `setImmediate` yield between candidates was tried first but is a
  // starvation-bound mitigation on top of the same blocking calls, not a fix
  // — removed now that the calls themselves don't block. NOT a claim that the
  // event loop is fully free during a scan: `walkRoot` below (readdirSync/
  // statSync over the whole tree) plus one `statSync`-based cache-key check
  // per candidate are still synchronous. Measured worst-case event-loop lag
  // against the real roots tree: 596ms (vs. the pre-fix 4m07s total lockout)
  // — the multi-minute freeze is gone; brief synchronous stat bursts remain.
  //
  // Also cached (see `introspectCached`/`introspectCacheKey` above), keyed by
  // path + the mtimes of the files that actually determine `introspect()`'s
  // output (`.git/HEAD` and `.git/config`, worktree-aware). An unchanged key
  // means a re-scan can reuse the prior result and skip every git spawn for
  // that path — a reconnect against an unchanged roots tree costs a couple of
  // `stat()` calls per candidate instead of up to 5 subprocess spawns.
  const rootSet = new Set(cfg.roots.map((r) => r.replace(/\\/g, '/')))
  const entries: RepoEntry[] = []
  const introResults = await mapWithConcurrency(allCandidates, INTROSPECT_CONCURRENCY, introspectCached)
  for (let i = 0; i < allCandidates.length; i++) {
    const path = allCandidates[i]
    const gi = introResults[i]
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


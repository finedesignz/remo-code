import { realpathSync, existsSync } from 'fs'
import { dirname, resolve, sep } from 'path'

export class SandboxEscapeError extends Error {
  readonly repoPath: string
  readonly realPath: string | null
  readonly allowedRoots: string[]
  constructor(repoPath: string, realPath: string | null, allowedRoots: string[]) {
    super(`sandbox_escape: ${repoPath} is not within any allowed root`)
    this.name = 'SandboxEscapeError'
    this.repoPath = repoPath
    this.realPath = realPath
    this.allowedRoots = allowedRoots
  }
}

/**
 * Verify `repoPath` resolves (after symlink resolution) to a location inside at
 * least one configured root. Throws `SandboxEscapeError` on rejection.
 *
 * Roots are also realpath-resolved so a root configured as a symlink still works.
 * Missing roots are silently skipped (a stale root in config shouldn't kill startup).
 */
export function assertWithinRoots(repoPath: string, roots: string[]): { realRepo: string; matchedRoot: string } {
  let realRepo: string
  try {
    realRepo = realpathSync(repoPath)
  } catch {
    throw new SandboxEscapeError(repoPath, null, roots)
  }
  for (const root of roots) {
    let realRoot: string
    try {
      realRoot = realpathSync(root)
    } catch {
      continue
    }
    if (realRepo === realRoot || realRepo.startsWith(realRoot + sep)) {
      return { realRepo, matchedRoot: realRoot }
    }
  }
  throw new SandboxEscapeError(repoPath, realRepo, roots)
}

/**
 * Like `assertWithinRoots`, but for a path that does NOT yet exist (e.g. a
 * clone target). Walks up to the nearest existing ancestor, realpath-resolves
 * THAT, and verifies it sits inside an allowed root. The unresolved tail is
 * then joined back on. This blocks `..` traversal and absolute escape (e.g.
 * `C:\Windows\System32`) while still allowing first-time clones.
 *
 * Throws `SandboxEscapeError` on rejection.
 */
export function assertTargetWithinRoots(targetPath: string, roots: string[]): void {
  const abs = resolve(targetPath)
  // Walk up until we find an existing ancestor (parent dir, grandparent, ...).
  let cursor = abs
  while (cursor && !existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) break // hit filesystem root
    cursor = parent
  }
  if (!existsSync(cursor)) {
    throw new SandboxEscapeError(targetPath, null, roots)
  }
  let realAncestor: string
  try { realAncestor = realpathSync(cursor) } catch {
    throw new SandboxEscapeError(targetPath, null, roots)
  }
  // The realpath-resolved tail equals realAncestor + (abs - cursor). Since
  // the tail does not exist, no symlinks can swap it; we can safely string-
  // concat.
  const tail = abs.slice(cursor.length)
  const realTarget = realAncestor + tail
  for (const root of roots) {
    let realRoot: string
    try { realRoot = realpathSync(root) } catch { continue }
    if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
      return
    }
  }
  throw new SandboxEscapeError(targetPath, realTarget, roots)
}

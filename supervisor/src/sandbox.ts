import { realpathSync } from 'fs'
import { sep } from 'path'

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

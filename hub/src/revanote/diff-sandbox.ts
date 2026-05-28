/**
 * Diff sandbox / output gate (Phase 5).
 *
 * Runs after the agent finishes in the sandbox worktree. Reads the unified
 * diff, hard-rejects anything that touches host secrets / deploy config /
 * CI files, and soft-flags risky-but-not-forbidden changes (dep bumps,
 * lockfile churn) so the risk classifier escalates them.
 *
 * Cross-side contract: the boolean `ok` here drives `merge_decision='blocked'`
 * on the outbound callback. `softFlags` feed the classifier — they do not by
 * themselves block.
 *
 * Pure function over a diff string + summary metadata. The actual `git diff`
 * shell-out lives in `getSandboxDiff()` which uses the sandbox-stripped env.
 */
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { getSandboxEnv } from './sandbox.ts'

export interface DiffAnalysis {
  ok: boolean
  blockedReasons: string[]
  softFlags: string[]
  diffText: string
  diffHash: string
  fileSummary: { files: string[]; totalAdded: number; totalRemoved: number; truncated: boolean }
}

/**
 * Path globs that block the merge outright. Tested against every "diff --git"
 * file path in the diff body. Case-insensitive.
 */
export const BLOCKED_PATH_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)\.github\//i,
  /(^|\/)Dockerfile/i,
  /(^|\/)docker-compose/i,
  /(^|\/)coolify/i,
  /(^|\/)[^/]*secret[^/]*/i,
  /(^|\/)[^/]*credential[^/]*/i,
  /(^|\/)\.aws\//i,
  /(^|\/)\.ssh\//i,
]

/**
 * Content-level regex run against the entire diff body (case-insensitive).
 */
export const BLOCKED_CONTENT_PATTERNS: RegExp[] = [
  /AWS[_-]?(ACCESS|SECRET)/i,
  /API[_-]?KEY/i,
  /SECRET[_-]?KEY/i,
  /(BEARER|ACCESS|REFRESH|PRIVATE)[_-]?TOKEN/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]

const MAX_DIFF_FILES_IN_SUMMARY = 20
const SOFT_FLAG_LOCKFILE_LINES = 50

/**
 * Extract one entry per `diff --git a/<path> b/<path>` header, ignoring
 * binary diffs gracefully.
 */
function extractDiffFiles(diff: string): string[] {
  const files: string[] = []
  const rx = /^diff --git a\/(\S+) b\/(\S+)$/gm
  let m: RegExpExecArray | null
  while ((m = rx.exec(diff)) !== null) {
    // Prefer the b-side path (post-rename target).
    files.push(m[2] || m[1])
  }
  return files
}

/**
 * Per-file +/- counts via `@@ ` hunks. Fast-and-loose; good enough for the
 * 50-line lockfile threshold and the summary.
 */
function countHunks(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  const lines = diff.split('\n')
  for (const ln of lines) {
    if (ln.startsWith('+++') || ln.startsWith('---')) continue
    if (ln.startsWith('+')) added++
    else if (ln.startsWith('-')) removed++
  }
  return { added, removed }
}

/** Per-file added/removed split. */
function perFileCounts(diff: string): Map<string, { added: number; removed: number }> {
  const map = new Map<string, { added: number; removed: number }>()
  const sections = diff.split(/^diff --git /gm).slice(1)
  for (const section of sections) {
    const firstLine = section.split('\n', 1)[0]
    const m = /a\/(\S+) b\/(\S+)/.exec(firstLine)
    if (!m) continue
    const path = m[2] || m[1]
    const counts = countHunks('diff --git ' + section)
    map.set(path, counts)
  }
  return map
}

function isLockfile(path: string): boolean {
  return /(^|\/)(package-lock\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock)$/.test(path)
}

function isPackageJson(path: string): boolean {
  return /(^|\/)package\.json$/.test(path)
}

/**
 * Detect dependency-block edits inside a package.json diff. Looks for
 * `+` / `-` lines that fall inside a `"dependencies"` or `"devDependencies"`
 * object. Not bulletproof — JSON-mode aware would need a proper parser — but
 * good enough to flag the common case.
 */
function packageJsonDepsChanged(diff: string, path: string): boolean {
  const sections = diff.split(/^diff --git /gm).slice(1)
  for (const section of sections) {
    const firstLine = section.split('\n', 1)[0]
    if (!firstLine.includes(`b/${path}`)) continue
    const body = section
    let inDeps = false
    for (const ln of body.split('\n')) {
      if (/"(dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/.test(ln)) {
        inDeps = true
        continue
      }
      // crude block exit: top-level closing brace at start of line
      if (inDeps && /^[+\- ]\s*\}/.test(ln) && !/^[+\- ]\s{2,}/.test(ln)) inDeps = false
      if (inDeps && (ln.startsWith('+') || ln.startsWith('-')) && !ln.startsWith('+++') && !ln.startsWith('---')) {
        return true
      }
    }
  }
  return false
}

/**
 * Pure-function diff analyzer. Tested directly; runtime caller is
 * `analyzeDiff(getSandboxDiff(sandboxDir, base))`.
 */
export function analyzeDiff(diffText: string): DiffAnalysis {
  const blockedReasons: string[] = []
  const softFlags: string[] = []
  const files = extractDiffFiles(diffText)

  // (1) Path-glob block.
  for (const f of files) {
    for (const rx of BLOCKED_PATH_PATTERNS) {
      if (rx.test(f)) {
        blockedReasons.push(`blocked_path:${f}`)
        break
      }
    }
  }

  // (2) Content-regex block (run once over the diff body).
  for (const rx of BLOCKED_CONTENT_PATTERNS) {
    const m = rx.exec(diffText)
    if (m) {
      blockedReasons.push(`blocked_content:${m[0].slice(0, 40)}`)
    }
  }

  // (3) Soft flags.
  const perFile = perFileCounts(diffText)
  for (const f of files) {
    if (isLockfile(f)) {
      const counts = perFile.get(f)
      const total = (counts?.added ?? 0) + (counts?.removed ?? 0)
      if (total > SOFT_FLAG_LOCKFILE_LINES) {
        softFlags.push(`lockfile_churn:${f}(+${counts?.added ?? 0}/-${counts?.removed ?? 0})`)
      }
    }
    if (isPackageJson(f) && packageJsonDepsChanged(diffText, f)) {
      softFlags.push(`dependency_change:${f}`)
    }
  }

  const { added: totalAdded, removed: totalRemoved } = countHunks(diffText)
  const truncated = files.length > MAX_DIFF_FILES_IN_SUMMARY
  const fileSummary = {
    files: files.slice(0, MAX_DIFF_FILES_IN_SUMMARY),
    totalAdded,
    totalRemoved,
    truncated,
  }

  const diffHash = createHash('sha256').update(diffText).digest('hex')

  return {
    ok: blockedReasons.length === 0,
    blockedReasons,
    softFlags,
    diffText,
    diffHash,
    fileSummary,
  }
}

/**
 * Shell out to `git diff` inside a sandbox. Compares working tree (+ staged)
 * against `baseRef` (default: `HEAD`).
 *
 * For a clone-and-edit flow, the agent commits or stages its changes; we diff
 * against HEAD which is the cloned tip. For local_path worktree-add, the new
 * branch is rooted at the source HEAD, so diff-vs-HEAD captures all edits.
 */
export function getSandboxDiff(
  repoDir: string,
  baseRef: string = 'HEAD',
  gitBin: string = 'git',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      gitBin,
      ['-C', repoDir, 'diff', '--no-color', baseRef],
      { env: getSandboxEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { err += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git diff failed (code ${code}): ${err.slice(0, 400)}`))
        return
      }
      resolve(out)
    })
  })
}

export function summarizeForCallback(a: DiffAnalysis): string {
  const head = `${a.fileSummary.files.length}${a.fileSummary.truncated ? '+' : ''} files, ` +
    `+${a.fileSummary.totalAdded}/-${a.fileSummary.totalRemoved} lines`
  const list = a.fileSummary.files.join(', ')
  return `${head}: ${list}`
}

// Test-only.
export const _internals = {
  extractDiffFiles,
  countHunks,
  perFileCounts,
  isLockfile,
  isPackageJson,
  packageJsonDepsChanged,
}

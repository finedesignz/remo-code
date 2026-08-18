import { realpath as realpathAsync, access } from 'fs/promises'
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
 * Thrown when a sandbox filesystem check (realpath/access) doesn't resolve
 * within SANDBOX_FS_TIMEOUT_MS. Distinct from SandboxEscapeError so callers
 * can tell "this path is disallowed" from "we couldn't tell in time" —
 * both are treated as a hard reject, but the reason differs.
 */
export class SandboxCheckTimeoutError extends Error {
  readonly path: string
  readonly timeoutMs: number
  constructor(path: string, timeoutMs: number) {
    super(`sandbox_check_timeout: filesystem check on ${path} did not resolve within ${timeoutMs}ms`)
    this.name = 'SandboxCheckTimeoutError'
    this.path = path
    this.timeoutMs = timeoutMs
  }
}

/**
 * 2026-08-18 (fix/session-start-freeze) — every sandbox check below used to
 * run through the SYNCHRONOUS fs API (realpathSync/existsSync) directly on
 * `session.start`'s hot path (ProcessManager.start → assertWithinRoots is the
 * very FIRST thing it does, before the writeAudit call that's supposed to
 * make every start attempt observable). A sync fs call blocks Bun's single
 * main thread for as long as the underlying syscall takes — for a local path
 * that's sub-millisecond, but for a path that resolves through a stalled
 * network share, a disconnected mapped drive, a cloud-sync placeholder
 * (OneDrive/Dropbox "files on demand"), or a filesystem filter driver doing a
 * blocking AV scan on first access, it can hang for a long time with NO
 * timeout and no way to observe it: the event loop stops entirely, so the
 * 10s session_inventory push stops firing, incoming WS frames stop being
 * processed, and writeAudit() — which sits after this check — never runs. A
 * bad/slow path must not be able to freeze the whole supervisor process.
 *
 * Fix: use the async fs/promises API and race every check against a hard
 * timeout. A stalled filesystem now fails (loudly, via
 * SandboxCheckTimeoutError — logged and audited same as sandbox_escape) in
 * bounded time instead of hanging forever, and the event loop stays free to
 * keep servicing the hub connection throughout.
 */
// Per-fs-call budget, not a total-call budget — `assertWithinRoots` with N
// roots can make up to N+1 checks (repo + each root), so worst case is
// ~(N+1) * this value, not a flat 5s ceiling.
const DEFAULT_SANDBOX_FS_TIMEOUT_MS = 5_000

// 2026-08-18 QC (D4) — test-only injection seam. Production code always goes
// through the real `fs/promises` functions and the real timeout; tests can
// swap either to deterministically exercise the timeout/fail-closed path
// without waiting out a real 5s timer or needing an actually-stalled
// filesystem (which isn't reproducible portably in CI). Never used outside
// `test/sandbox.test.ts`.
let _realpath: typeof realpathAsync = realpathAsync
let _access: typeof access = access
let _timeoutMs: number = DEFAULT_SANDBOX_FS_TIMEOUT_MS

export function __setSandboxFsImplForTests(impl: { realpath?: typeof realpathAsync; access?: typeof access } | null): void {
  _realpath = impl?.realpath ?? realpathAsync
  _access = impl?.access ?? access
}

export function __setSandboxTimeoutMsForTests(ms: number | null): void {
  _timeoutMs = ms ?? DEFAULT_SANDBOX_FS_TIMEOUT_MS
}

async function withTimeout<T>(path: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutMs = _timeoutMs
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SandboxCheckTimeoutError(path, timeoutMs)), timeoutMs)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

async function tryRealpath(path: string): Promise<string | null> {
  try {
    return await withTimeout(path, _realpath(path))
  } catch (err) {
    if (err instanceof SandboxCheckTimeoutError) throw err
    return null
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await withTimeout(path, _access(path))
    return true
  } catch (err) {
    if (err instanceof SandboxCheckTimeoutError) throw err
    return false
  }
}

/**
 * Verify `repoPath` resolves (after symlink resolution) to a location inside at
 * least one configured root. Throws `SandboxEscapeError` on rejection, or
 * `SandboxCheckTimeoutError` if a filesystem check hangs past the deadline.
 *
 * Roots are also realpath-resolved so a root configured as a symlink still works.
 * Missing roots are silently skipped (a stale root in config shouldn't kill startup).
 */
export async function assertWithinRoots(repoPath: string, roots: string[]): Promise<{ realRepo: string; matchedRoot: string }> {
  const realRepo = await tryRealpath(repoPath)
  if (realRepo === null) {
    throw new SandboxEscapeError(repoPath, null, roots)
  }
  for (const root of roots) {
    const realRoot = await tryRealpath(root)
    if (realRoot === null) continue
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
 * Throws `SandboxEscapeError` on rejection, or `SandboxCheckTimeoutError` if a
 * filesystem check hangs past the deadline.
 */
export async function assertTargetWithinRoots(targetPath: string, roots: string[]): Promise<void> {
  const abs = resolve(targetPath)
  // Walk up until we find an existing ancestor (parent dir, grandparent, ...).
  let cursor = abs
  while (cursor && !(await pathExists(cursor))) {
    const parent = dirname(cursor)
    if (parent === cursor) break // hit filesystem root
    cursor = parent
  }
  if (!(await pathExists(cursor))) {
    throw new SandboxEscapeError(targetPath, null, roots)
  }
  const realAncestor = await tryRealpath(cursor)
  if (realAncestor === null) {
    throw new SandboxEscapeError(targetPath, null, roots)
  }
  // The realpath-resolved tail equals realAncestor + (abs - cursor). Since
  // the tail does not exist, no symlinks can swap it; we can safely string-
  // concat.
  const tail = abs.slice(cursor.length)
  const realTarget = realAncestor + tail
  for (const root of roots) {
    const realRoot = await tryRealpath(root)
    if (realRoot === null) continue
    if (realTarget === realRoot || realTarget.startsWith(realRoot + sep)) {
      return
    }
  }
  throw new SandboxEscapeError(targetPath, realTarget, roots)
}

/**
 * local_path sandbox stash hardening (Phase 6).
 *
 * Before the agent spawn on a `repo_kind='local_path'` repo, rename any
 * top-level secret files/dirs in the user's source repo so the agent can't
 * read them even via worktree-shared inodes. Restore on finally.
 *
 * Patterns moved (top-level only — recursive secrets are out-of-scope for
 * the stash; the run-wrapper deny marker is the second layer of defense):
 *   .env, .env.*, secrets/, .aws/, .ssh/
 *
 * Names become `<original>.revanote-sandbox-stash-<runId>`.
 *
 * Failure modes:
 *   - Existing `.revanote-sandbox-stash-*` at start → interrupted prior run.
 *     Abort with `RevanoteStashAbortError`; caller must alert + refuse to
 *     dispatch (we DO NOT auto-unstash someone else's stash).
 *   - Restore failure in `finally` → write `revanote-sandbox-critical.log`
 *     in the source repo root + throw `RevanoteStashRestoreError`. Caller
 *     MUST mark run failed and NOT mark complete.
 */
import { readdir, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class RevanoteStashAbortError extends Error {
  constructor(public readonly conflictingPath: string) {
    super(`refusing to stash: previous run state present at ${conflictingPath}`)
    this.name = 'RevanoteStashAbortError'
  }
}

export class RevanoteStashRestoreError extends Error {
  constructor(public readonly failures: { from: string; to: string; err: string }[]) {
    super(`stash restore failed for ${failures.length} entries; critical log written`)
    this.name = 'RevanoteStashRestoreError'
  }
}

const STASH_SUFFIX = '.revanote-sandbox-stash-'
const SECRET_TOP_LEVEL_RX = [
  /^\.env(\..+)?$/i,
  /^secrets$/i,
  /^\.aws$/i,
  /^\.ssh$/i,
]

export interface StashedEntry {
  original: string
  stashed: string
}

export interface StashHandle {
  repoRoot: string
  runId: string
  entries: StashedEntry[]
  restored: boolean
}

function looksLikeSecret(name: string): boolean {
  return SECRET_TOP_LEVEL_RX.some((rx) => rx.test(name))
}

/**
 * Scan repoRoot for an existing stash marker from a previous (interrupted)
 * run. Throws RevanoteStashAbortError on hit.
 */
export async function assertNoPriorStash(repoRoot: string): Promise<void> {
  const entries = await readdir(repoRoot).catch(() => [] as string[])
  const hit = entries.find((e) => e.includes(STASH_SUFFIX))
  if (hit) {
    throw new RevanoteStashAbortError(join(repoRoot, hit))
  }
}

/**
 * Move every top-level secret into a stashed name. Returns a handle the
 * caller must `restoreStash()` on, no matter what.
 */
export async function stashSecrets(repoRoot: string, runId: string): Promise<StashHandle> {
  await assertNoPriorStash(repoRoot)
  const handle: StashHandle = { repoRoot, runId, entries: [], restored: false }
  const all = await readdir(repoRoot)
  for (const name of all) {
    if (!looksLikeSecret(name)) continue
    const from = join(repoRoot, name)
    const stashedName = `${name}${STASH_SUFFIX}${runId}`
    const to = join(repoRoot, stashedName)
    try {
      // Confirm the source exists (race-safe-enough).
      await stat(from)
      await rename(from, to)
      handle.entries.push({ original: from, stashed: to })
    } catch (err: any) {
      // If rename failed and we already moved some, attempt to undo them
      // before throwing — leaving a half-stashed repo is worse than the
      // original problem.
      const restoreFailures: { from: string; to: string; err: string }[] = []
      for (const ent of handle.entries.reverse()) {
        try { await rename(ent.stashed, ent.original) } catch (e: any) {
          restoreFailures.push({ from: ent.stashed, to: ent.original, err: e?.message ?? String(e) })
        }
      }
      if (restoreFailures.length > 0) {
        await writeCriticalLog(repoRoot, runId, restoreFailures)
      }
      throw new Error(`stashSecrets failed at ${name}: ${err?.message ?? err}`)
    }
  }
  return handle
}

/**
 * Restore every stashed entry. Idempotent (no-op if already restored). On
 * any rename failure, writes a critical log + throws so caller can refuse
 * to mark the run complete.
 */
export async function restoreStash(handle: StashHandle): Promise<void> {
  if (handle.restored) return
  const failures: { from: string; to: string; err: string }[] = []
  // Reverse order so nested paths restore last-in-first-out (though we only
  // stash top-level entries today, this is future-proof).
  for (const ent of [...handle.entries].reverse()) {
    try {
      await rename(ent.stashed, ent.original)
    } catch (err: any) {
      failures.push({ from: ent.stashed, to: ent.original, err: err?.message ?? String(err) })
    }
  }
  handle.restored = true
  if (failures.length > 0) {
    await writeCriticalLog(handle.repoRoot, handle.runId, failures)
    throw new RevanoteStashRestoreError(failures)
  }
}

async function writeCriticalLog(
  repoRoot: string,
  runId: string,
  failures: { from: string; to: string; err: string }[],
): Promise<void> {
  const logPath = join(repoRoot, 'revanote-sandbox-critical.log')
  const lines = [
    `=== revanote sandbox critical failure ${new Date().toISOString()} ===`,
    `runId: ${runId}`,
    `repoRoot: ${repoRoot}`,
    `Manual restore required for the following:`,
    ...failures.map((f) => `  mv "${f.from}" "${f.to}"   # error: ${f.err}`),
    '',
  ].join('\n')
  try {
    await writeFile(logPath, lines, { flag: 'a', encoding: 'utf-8' })
  } catch (err: any) {
    console.error(`[revanote.local-path-stash] failed to write critical log to ${logPath}: ${err?.message ?? err}`)
    console.error(`[revanote.local-path-stash] critical failures:\n${lines}`)
  }
}

/**
 * Convenience wrapper: stash, run `fn`, always restore. Re-throws stash or
 * restore errors so the caller can route to the right failure handler.
 */
export async function withStashedSecrets<T>(
  repoRoot: string,
  runId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const handle = await stashSecrets(repoRoot, runId)
  try {
    return await fn()
  } finally {
    await restoreStash(handle)
  }
}

export const _internals = { looksLikeSecret, STASH_SUFFIX, SECRET_TOP_LEVEL_RX, writeCriticalLog }

/**
 * auto-dev P5 — Coolify deploy-failure fingerprint + dedupe window.
 *
 * The Coolify webhook carries no error text we can hash reliably, so the
 * fingerprint is a COARSE signal off the stable payload fields plus a time
 * bucket: `sha256(application_uuid|git_repository|commit_sha|bucket)` where
 * `bucket = floor(now / DEDUPE_WINDOW)`. Effect:
 *   - 50 `deployment.failed` for the SAME (app, repo, commit) inside one window
 *     hash identically → ONE fix dispatch (the storm collapses).
 *   - A genuinely new failure (different commit, or the same commit re-failing
 *     in a LATER window) hashes differently → a fresh fix dispatch is allowed.
 *
 * The window is a deliberate balance: tight enough that a real re-deploy after
 * the user pushes a new commit is not suppressed (commit_sha changes), loose
 * enough that a crash-loop emitting bursts doesn't fan out.
 */
import { createHash } from 'node:crypto'

/** Storm-collapse window. Failures of the same deploy signal inside this window
 *  produce a single fix dispatch. */
export const DEPLOY_DEDUPE_WINDOW_MS = 15 * 60 * 1000 // 15 min

export interface DeployFingerprintInput {
  application_uuid: string
  git_repository?: string | null
  commit_sha?: string | null
}

/**
 * Coarse fingerprint for a deploy failure. `nowMs` is injectable for tests.
 */
export function deployFailureFingerprint(
  input: DeployFingerprintInput,
  nowMs: number = Date.now(),
): string {
  const bucket = Math.floor(nowMs / DEPLOY_DEDUPE_WINDOW_MS)
  const parts = [
    input.application_uuid,
    input.git_repository ?? '',
    input.commit_sha ?? '',
    String(bucket),
  ]
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

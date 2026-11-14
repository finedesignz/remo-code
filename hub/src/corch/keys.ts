// hub/src/corch/keys.ts
//
// CORCH-01 (LD-3): the only builders of CORCH identity strings. Pure, no imports.

export const CORCH_ACTOR = 'corch'

const RUN_TOKEN_PREFIX = 'corch-run:'

/** Lifetime-counter key for a work item. The ONLY builder (counter-key-assignment-guard). */
export function buildCorchKey(workItemId: string): string {
  return `corch:${workItemId}`
}

/** Dispatch token / reservation token for one run. */
export function buildCorchRunToken(runId: string): string {
  return `${RUN_TOKEN_PREFIX}${runId}`
}

/** Inverse of buildCorchRunToken; null for any other shape. */
export function runIdFromToken(token: string): string | null {
  if (!token.startsWith(RUN_TOKEN_PREFIX)) return null
  const id = token.slice(RUN_TOKEN_PREFIX.length)
  return id.length > 0 ? id : null
}

/** Work branch for an item. */
export function corchBranch(workItemId: string): string {
  return `corch/${workItemId}`
}

/** Advisory-lock key string for the per-user claim transaction. */
export function corchUserLockKey(userId: string): string {
  return `corch:user:${userId}`
}

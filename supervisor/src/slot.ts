/**
 * slot.ts - CORCH-09 (R4.1, R4.2): the per-account slot identity of a headless Linux supervisor.
 *
 * A supervisor is a CORCH slot ONLY when `REMO_ACCOUNT_SLOT` is set (one container per Claude account).
 * Without it (every desktop MSI) nothing in this module has any effect: no `account_slot` is advertised,
 * no token is injected, no CLAUDE_CONFIG_DIR is set.
 *
 * The OAuth token is supervisor-ephemeral: it is read from this process's env and handed ONLY to the spawned
 * `claude` child. It is never placed in any hub frame, log line or error message (names only).
 */

/** Same shape the hub validates (`supervisor-protocol.ts` account_slot). */
const SLOT_RE = /^[A-Za-z0-9_-]{1,64}$/

export class SlotConfigError extends Error {
  constructor(public readonly code: 'slot_invalid' | 'slot_token_missing' | 'slot_config_dir_missing') {
    super(code)
    this.name = 'SlotConfigError'
  }
}

/**
 * The advertised account slot, or null when this supervisor is not a slot. A set-but-malformed value is
 * treated as "not a slot" for the hello (the hub would reject it anyway) and is reported by `slotSpawnEnv`.
 */
export function accountSlot(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.REMO_ACCOUNT_SLOT?.trim()
  if (!raw) return null
  return SLOT_RE.test(raw) ? raw : null
}

/** True when REMO_ACCOUNT_SLOT is set to anything at all (even malformed): the spawn must then fail closed. */
export function slotRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.REMO_ACCOUNT_SLOT?.trim()
}

/**
 * Apply the per-slot spawn env on top of an ALREADY SANITIZED env (`sanitizeSpawnEnv`). Returns `sanitized`
 * unchanged when no slot is configured. With a slot: sets CLAUDE_CODE_OAUTH_TOKEN (from this process) and
 * CLAUDE_CONFIG_DIR (from REMO_SLOT_CLAUDE_CONFIG_DIR); both are REQUIRED (fail closed, never a spawn that
 * silently falls back to another account's login). ANTHROPIC_API_KEY is deleted again here as a belt.
 * Throws SlotConfigError with a code only; the message never carries a value.
 */
export function slotSpawnEnv(sanitized: NodeJS.ProcessEnv, processEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!slotRequested(processEnv)) return sanitized
  if (accountSlot(processEnv) === null) throw new SlotConfigError('slot_invalid')
  const token = processEnv.CLAUDE_CODE_OAUTH_TOKEN
  if (!token) throw new SlotConfigError('slot_token_missing')
  const configDir = processEnv.REMO_SLOT_CLAUDE_CONFIG_DIR?.trim()
  if (!configDir) throw new SlotConfigError('slot_config_dir_missing')
  const out: NodeJS.ProcessEnv = { ...sanitized }
  out.CLAUDE_CODE_OAUTH_TOKEN = token
  out.CLAUDE_CONFIG_DIR = configDir
  delete out.ANTHROPIC_API_KEY
  return out
}

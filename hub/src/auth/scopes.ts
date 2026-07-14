/**
 * Milestone SKEY — API-key scopes.
 *
 * `api_keys.scopes` is ADDITIVE and NULLABLE (the same column milestone ASK /
 * feat/session-ask introduces):
 *
 *   scopes IS NULL (or empty)  → LEGACY full access. Every key minted before this
 *                                milestone keeps working with ZERO migration,
 *                                including /ws/agent and /api/plugin.
 *   scopes = {'agent'}         → may authenticate a supervisor/agent socket + /api/plugin
 *   scopes = {'ext:read'}      → may read the external /api/ext surface
 *   scopes = {'ext:ask'}       → may spend tokens via POST /api/ext/…/ask
 *
 * SECURITY: the whole point of the milestone is that a Claude-Desktop-style
 * external consumer gets an `ext:*`-only key and therefore CANNOT spawn CLI
 * processes on a host — that power lives behind the `agent` scope alone.
 */

export const SCOPE_AGENT = 'agent'
export const SCOPE_EXT_READ = 'ext:read'
export const SCOPE_EXT_ASK = 'ext:ask'

export const ALL_SCOPES = [SCOPE_AGENT, SCOPE_EXT_READ, SCOPE_EXT_ASK] as const
export type Scope = (typeof ALL_SCOPES)[number]

export function isScope(s: unknown): s is Scope {
  return typeof s === 'string' && (ALL_SCOPES as readonly string[]).includes(s)
}

/**
 * NULL / empty scopes == all scopes (legacy). A non-empty array is an allowlist.
 */
export function hasScope(scopes: string[] | null | undefined, scope: string): boolean {
  if (scopes == null) return true
  if (!Array.isArray(scopes) || scopes.length === 0) return true
  return scopes.includes(scope)
}

/** Normalize a caller-supplied scope list. Returns null (= legacy full) for empty. */
export function normalizeScopes(input: unknown): { ok: true; scopes: string[] | null } | { ok: false; error: string } {
  if (input == null) return { ok: true, scopes: null }
  if (!Array.isArray(input)) return { ok: false, error: 'scopes must be an array' }
  const out: string[] = []
  for (const s of input) {
    if (!isScope(s)) return { ok: false, error: `unknown scope: ${String(s)}` }
    if (!out.includes(s)) out.push(s)
  }
  return { ok: true, scopes: out.length ? out : null }
}

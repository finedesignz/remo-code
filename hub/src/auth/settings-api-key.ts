/**
 * Settings via API key (`settings:read` / `settings:write`).
 *
 * Lets a scripted consumer (e.g. an agent holding REMO_API_KEY) read and change the
 * user's Settings without a browser cookie. `authMiddleware` hands any
 * `Authorization: Bearer remokey_…` request here.
 *
 * SECURITY — the gate is an ALLOWLIST of settings routes, not the scope alone:
 *   - Both scopes are EXPLICIT-only (`hasExplicitScope`). A legacy NULL-scopes key
 *     (incl. the supervisor's own spawn key) never picks up settings authority.
 *   - `settings:write` implies `settings:read`.
 *   - Any path NOT listed below is 403 for an api key, whatever its scopes. That is
 *     what keeps `/api/api-keys` cookie-only (an api key must NEVER mint an api key),
 *     and keeps webhook secrets, prompt files, skip-permissions and admin out of reach.
 *   - Because the key had to be minted by a fresh cookie login and carries an explicit
 *     scope, `requireRecentAuth` lets an allowlisted settings WRITE through for it
 *     (see `isSettingsApiKeyRequest`). The step-up exists to blunt a stolen cookie; a
 *     deliberately-scoped key is its own grant.
 */
import type { Context } from 'hono'
import { hashToken } from '../lib/crypto'
import { verifyApiKeyForExt } from '../db/ask-dal.ts'
import { hasExplicitScope, SCOPE_SETTINGS_READ, SCOPE_SETTINGS_WRITE } from './scopes.ts'

export const API_KEY_AUTH_METHOD = 'api_key_settings'

type Access = 'read' | 'write'
interface SettingsRoute { method: string; path: RegExp; access: Access }

const ID = '[A-Za-z0-9_-]+'
const r = (p: string) => new RegExp(`^${p}/?$`)

/** The ONLY routes an api key may reach through the cookie-auth catch-all. */
export const SETTINGS_ROUTES: readonly SettingsRoute[] = [
  // Profile: display name, timezone, avatar, system prompt, programmatic halt.
  { method: 'GET', path: r('/api/profile'), access: 'read' },
  { method: 'PATCH', path: r('/api/profile'), access: 'write' },
  { method: 'PATCH', path: r('/api/users/me/profile'), access: 'write' },
  { method: 'PATCH', path: r('/api/users/me/preferred-supervisor'), access: 'write' },
  // Usage + cost controls.
  { method: 'GET', path: r('/api/usage/summary'), access: 'read' },
  { method: 'GET', path: r('/api/account/usage'), access: 'read' },
  { method: 'GET', path: r('/api/account/claude-thresholds'), access: 'read' },
  { method: 'PUT', path: r('/api/account/claude-thresholds'), access: 'write' },
  { method: 'PUT', path: r('/api/account/revanote-budget-pct'), access: 'write' },
  // Notifications + Coolify triage prefs (NOT the webhook secrets).
  { method: 'GET', path: r('/api/account/notify-channels'), access: 'read' },
  { method: 'PATCH', path: r('/api/account/notify-channels'), access: 'write' },
  { method: 'PATCH', path: r('/api/account/coolify-auto-triage'), access: 'write' },
  { method: 'GET', path: r('/api/account/coolify-webhook-allowed-ips'), access: 'read' },
  { method: 'PUT', path: r('/api/account/coolify-webhook-allowed-ips'), access: 'write' },
  // Connections: supervisors + scan roots, orchestrator prefs, per-session auto-nudge.
  { method: 'GET', path: r('/api/supervisors'), access: 'read' },
  { method: 'PATCH', path: r(`/api/supervisors/${ID}/roots`), access: 'write' },
  { method: 'GET', path: r('/api/orchestrator'), access: 'read' },
  { method: 'PUT', path: r('/api/orchestrator'), access: 'write' },
  { method: 'PATCH', path: r(`/api/sessions/${ID}/auto-nudge`), access: 'write' },
]

export function matchSettingsRoute(method: string, path: string): SettingsRoute | null {
  const m = method.toUpperCase()
  return SETTINGS_ROUTES.find((rt) => rt.method === m && rt.path.test(path)) ?? null
}

export function settingsScopeAllows(scopes: string[] | null | undefined, access: Access): boolean {
  if (hasExplicitScope(scopes, SCOPE_SETTINGS_WRITE)) return true
  return access === 'read' && hasExplicitScope(scopes, SCOPE_SETTINGS_READ)
}

/** True when this request was authenticated by a settings-scoped key on an allowlisted route. */
export function isSettingsApiKeyRequest(c: Context): boolean {
  return c.get('authMethod') === API_KEY_AUTH_METHOD && matchSettingsRoute(c.req.method, c.req.path) != null
}

/**
 * Authenticate a `Bearer remokey_…` request against the settings allowlist.
 * Returns a Response to short-circuit with, or null after setting the auth vars.
 * FAILS CLOSED on any lookup error.
 */
export async function authenticateSettingsApiKey(c: Context, rawKey: string): Promise<Response | null> {
  if (!/^remokey_[A-Za-z0-9_-]+$/.test(rawKey)) return c.json({ error: 'Unauthorized' }, 401)

  let key: Awaited<ReturnType<typeof verifyApiKeyForExt>> = null
  try {
    key = await verifyApiKeyForExt(await hashToken(rawKey))
  } catch (err: any) {
    console.warn(`[settings-auth] key lookup failed: ${err?.message ?? err}`)
    return c.json({ error: 'Unauthorized' }, 401)
  }
  if (!key) return c.json({ error: 'Unauthorized' }, 401)

  const route = matchSettingsRoute(c.req.method, c.req.path)
  if (!route) return c.json({ error: 'api_key_not_allowed', message: 'API keys may only reach settings endpoints here' }, 403)

  if (!settingsScopeAllows(key.scopes, route.access)) {
    const required = route.access === 'write' ? SCOPE_SETTINGS_WRITE : SCOPE_SETTINGS_READ
    return c.json({ error: 'insufficient_scope', required }, 403)
  }

  c.set('userId', key.user_id)
  c.set('apiKeyId', key.id)
  c.set('authMethod', API_KEY_AUTH_METHOD)
  return null
}

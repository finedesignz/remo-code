/**
 * env-sanitize.ts — Phase 19 / 19-03 (R-PTY-23 / R-PTY-36, threat T-19-03 / H9).
 *
 * SINGLE shared scrubber applied to EVERY runner spawn env (Claude PTY, Codex
 * PTY, Gemini stub). Deletes all known provider credential envs PLUS any var
 * matching the credential-class patterns — from the RESOLVED spawn env, so an
 * INHERITED key (present only in the supervisor's own process.env) is deleted,
 * not only an explicitly-set one.
 *
 * HARD INVARIANT: no provider API key / auth token ever reaches an interactive
 * CLI. The fallback is a backend-CLI swap on the PTY surface (Codex via ChatGPT
 * sign-in, Gemini future) — NEVER the API platform. No API-key path exists.
 *
 * DECISION (NH-5): keep an EXPLICIT named denylist for the known keys AND add an
 * anchored PATTERN sweep for the credential CLASS. Not a pure allowlist: an
 * interactive CLI inherits a large, undocumented, OS-/tool-specific env (PATH,
 * HOME, locale, terminal, tmux, node-pty deps) a fixed allowlist would brittly
 * break across hosts. The pattern-denylist gives allowlist-grade coverage of the
 * credential class (named + future + aliased) without enumerating benign vars.
 */

/** Explicit named provider-credential envs (single source the tests import). */
export const PROVIDER_KEY_DENYLIST: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  // setup-token-derived credentials are PROHIBITED on the interactive path until
  // their billing class is verified (T-19-03b). Scrubbed from every spawn env.
  'CLAUDE_SETUP_TOKEN',
  'ANTHROPIC_SETUP_TOKEN',
  'SETUP_TOKEN',
] as const

/**
 * Anchored credential-class patterns (single source the tests import). Anchored
 * with `$` so a benign var like MY_API_KEYBOARD_LAYOUT survives (no over-strip).
 * Case-insensitive.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /_API_KEY$/i,
  /_AUTH_TOKEN$/i,
  /_ACCESS_TOKEN$/i,
  /_API_TOKEN$/i,
  /_SETUP_TOKEN$/i,
] as const

const DENY_SET = new Set(PROVIDER_KEY_DENYLIST.map((k) => k.toUpperCase()))

/** True when `name` is a provider credential env (named OR pattern-matched). */
export function isCredentialEnvName(name: string): boolean {
  if (DENY_SET.has(name.toUpperCase())) return true
  return CREDENTIAL_PATTERNS.some((re) => re.test(name))
}

/**
 * Return a COPY of `baseEnv` with every provider-credential env removed. Operates
 * on the resolved env (caller passes `{ ...process.env, ...overrides }`), so an
 * inherited key is deleted.
 */
export function sanitizeSpawnEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(baseEnv)) {
    if (isCredentialEnvName(k)) continue
    out[k] = v
  }
  return out
}

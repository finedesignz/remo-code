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

/**
 * DEPLOY-credential envs (milestone WORK). Scrubbed from every CLI spawn env so that
 * "do not publish" is TRUE rather than merely REQUESTED: an agent that has been
 * prompt-injected into trying to deploy has no credential to deploy WITH.
 *
 * Deliberately does NOT include GITHUB_TOKEN / GH_TOKEN: the work contract requires the
 * agent to PUSH A BRANCH, and a branch push is not a publish. The publish path (merge +
 * deploy) runs in the hub / in `work_publish`, not in the agent's process.
 */
export const DEPLOY_KEY_DENYLIST: readonly string[] = [
  'COOLIFY_TOKEN',
  'COOLIFY_API_KEY',
  'COOLIFY_URL',
  'VERCEL_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'FTP_PASSWORD',
  'SSH_DEPLOY_KEY',
  'DEPLOY_KEY',
  'DEPLOY_TOKEN',
  'RENDER_API_KEY',
  'FLY_API_TOKEN',
] as const

/** Anchored deploy-credential-class patterns. */
export const DEPLOY_PATTERNS: readonly RegExp[] = [
  /^COOLIFY_/i,
  /^VERCEL_/i,
  /^NETLIFY_/i,
  /_DEPLOY_TOKEN$/i,
  /_DEPLOY_KEY$/i,
] as const

/**
 * GIT-PUSH credential envs (milestone WORK, option (a)). Scrubbed from the WORK session
 * env so the agent cannot push ANYWHERE — least authority. The agent commits locally on
 * `work/<nonce>`; the SUPERVISOR (a hub-commanded run_command the agent cannot invoke)
 * pushes that branch. Removing these makes "the agent does not push" structural.
 *
 * CAVEAT (documented in docs/remo-work.md): env scrubbing stops a token PASSED IN THE
 * ENV. On a host whose git credentials come from the OS credential manager, an SSH agent,
 * or a remote URL with embedded creds, git can still authenticate without an env var. The
 * enforceable backstop is server-side BRANCH PROTECTION on the client repo's default
 * branch — see the runbook.
 */
export const GIT_PUSH_KEY_DENYLIST: readonly string[] = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GIT_ASKPASS',
  'GIT_TOKEN',
  'GITHUB_PAT',
] as const

export const GIT_PUSH_PATTERNS: readonly RegExp[] = [/^GITHUB_.*TOKEN$/i, /^GH_.*TOKEN$/i] as const

const DENY_SET = new Set(PROVIDER_KEY_DENYLIST.map((k) => k.toUpperCase()))
const DEPLOY_DENY_SET = new Set(DEPLOY_KEY_DENYLIST.map((k) => k.toUpperCase()))
const GIT_PUSH_DENY_SET = new Set(GIT_PUSH_KEY_DENYLIST.map((k) => k.toUpperCase()))

/** True when `name` is a provider credential env (named OR pattern-matched). */
export function isCredentialEnvName(name: string): boolean {
  if (DENY_SET.has(name.toUpperCase())) return true
  return CREDENTIAL_PATTERNS.some((re) => re.test(name))
}

/** True when `name` is a DEPLOY/publish credential env (named OR pattern-matched). */
export function isDeployCredentialEnvName(name: string): boolean {
  if (DEPLOY_DENY_SET.has(name.toUpperCase())) return true
  return DEPLOY_PATTERNS.some((re) => re.test(name))
}

/** True when `name` is a GIT-PUSH credential env (named OR pattern-matched). */
export function isGitPushCredentialEnvName(name: string): boolean {
  if (GIT_PUSH_DENY_SET.has(name.toUpperCase())) return true
  return GIT_PUSH_PATTERNS.some((re) => re.test(name))
}

/**
 * Return a COPY of `baseEnv` with every provider-credential env removed. Operates
 * on the resolved env (caller passes `{ ...process.env, ...overrides }`), so an
 * inherited key is deleted.
 */
export function sanitizeSpawnEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
  opts: { scrubDeployCredentials?: boolean; scrubGitPush?: boolean } = {},
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(baseEnv)) {
    if (isCredentialEnvName(k)) continue
    if (opts.scrubDeployCredentials && isDeployCredentialEnvName(k)) continue
    if (opts.scrubGitPush && isGitPushCredentialEnvName(k)) continue
    out[k] = v
  }
  return out
}

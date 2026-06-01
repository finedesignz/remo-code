/**
 * Supervisor-side Anthropic OAuth usage poll (P1 of the usage-monitoring spec).
 *
 * Ports the proven endpoint + window parsing from the third-party `ClaudeUsage`
 * PowerShell module (github.com/backmind/ClaudeUsage, `ClaudeUsage.psm1`) into
 * the supervisor. Emits all four limit windows (5h / 7d / 7d-Opus /
 * 7d-OAuth-apps) so the hub's existing `usage_report` → `subscription_usage`
 * flow can render them.
 *
 * HARD INVARIANT: the OAuth access token lives ONLY on the dev machine
 * (`~/.claude/.credentials.json`) and is read ONLY here. It is NEVER serialized
 * to the hub — only the parsed, non-secret utilization snapshot is sent.
 */
import { readFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** Poll cadence — 5 min, matching the hub store/threshold comments. */
export const USAGE_POLL_INTERVAL_MS = 5 * 60_000

/** Headers ported verbatim from ClaudeUsage.psm1:117-124 (minus Authorization,
 *  which is added per-request from the credentials file). */
export const OAUTH_USAGE_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'User-Agent': 'claude-code/2.0.15',
  'anthropic-beta': 'oauth-2025-04-20',
}

export interface UsageWindow {
  utilization: number
  resets_at: string
}

/**
 * Phase 18 (R-PTY-17): the post-June-15-2026 Agent-SDK programmatic credit pool.
 *
 * Unlike the four subscription windows (a 0-100 utilization %), this is a monthly
 * DOLLAR credit (Pro $20 / Max-5x $100 / Max-20x $200, full API list rates, no
 * rollover, claimed once). It therefore has its OWN shape — a dollar bucket, not
 * a util% window — carried ADDITIVELY on `UsagePayload`.
 *
 * `claimed:false` (or the whole bucket being null/absent) is the explicit
 * pre-claim / unclaimed empty state. The parser NEVER fabricates a dollar number.
 */
export interface ProgrammaticCredit {
  used_usd: number
  limit_usd: number
  resets_at: string
  claimed: boolean
}

/** Shape that maps 1:1 onto the hub's `AgentUsageReport.usage`
 *  (`hub/src/ws/agent-protocol.ts:146-155`). Opus + oauth-apps are optional.
 *  Phase 18 adds the optional, nullable `programmatic_credit` second bucket —
 *  additive, so an un-upgraded hub/client (and a pre-claim account) still
 *  validates and renders the four windows. */
export interface UsagePayload {
  five_hour: UsageWindow
  seven_day: UsageWindow
  seven_day_opus?: UsageWindow | null
  seven_day_oauth_apps?: UsageWindow | null
  programmatic_credit?: ProgrammaticCredit | null
}

function credentialsPath(): string {
  return join(homedir(), '.claude', '.credentials.json')
}

/** Read the OAuth access token from `~/.claude/.credentials.json`.
 *  Returns null (with a one-line reason) when missing/expired/malformed so the
 *  caller can skip the poll without crashing. Expiry uses `expiresAt` in unix
 *  **milliseconds** (psm1:88-99). */
export function readAccessToken(
  now: number = Date.now(),
  path: string = credentialsPath(),
): { token: string } | { token: null; reason: string } {
  if (!existsSync(path)) {
    return { token: null, reason: 'credentials_file_not_found' }
  }
  let parsed: any
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err: any) {
    return { token: null, reason: `credentials_parse_error: ${err?.message ?? err}` }
  }
  const oauth = parsed?.claudeAiOauth
  const token = oauth?.accessToken
  if (typeof token !== 'string' || token.length === 0) {
    return { token: null, reason: 'no_access_token' }
  }
  const expiresAt = oauth?.expiresAt
  if (typeof expiresAt === 'number' && now > expiresAt) {
    return { token: null, reason: 'token_expired_run_claude_setup_token' }
  }
  return { token }
}

/** Validate a single window object from the API response. Returns null when the
 *  window is absent or malformed (optional windows simply aren't present). */
export function parseWindow(raw: any): UsageWindow | null {
  if (!raw || typeof raw !== 'object') return null
  const utilization = raw.utilization
  const resets_at = raw.resets_at
  if (typeof utilization !== 'number' || !Number.isFinite(utilization)) return null
  if (typeof resets_at !== 'string' || resets_at.length === 0) return null
  return { utilization, resets_at }
}

/**
 * Phase 18 (R-PTY-17): parse the Agent-SDK programmatic credit pool out of the
 * usage body, returning `null` (the explicit empty state) for any body that does
 * NOT carry a usable dollar balance. It NEVER fabricates a number.
 *
 * Endpoint reality is an OPEN ITEM (RESEARCH §2): whether `/api/oauth/usage` was
 * extended to include the credit pool, or a sibling endpoint carries it, is
 * UNCONFIRMED until captured on a live post-claim account after June 15 2026.
 * Until then this parser is provisional — it defensively recognises the
 * documented dollar shape under a small set of candidate keys and degrades to
 * `null` otherwise. We deliberately do NOT add a second network call; we parse
 * whatever the existing `/api/oauth/usage` body offers first.
 *
 * Recognised shape (any of `programmatic_credit` / `agent_sdk_credit` /
 * `credit_pool`, Claude's discretion — first match wins):
 *   { used_usd|used, limit_usd|limit, resets_at, claimed? }
 *
 * Fail-safe rules:
 *  - body absent / not an object                       => null
 *  - no recognised credit container                    => null
 *  - container present but used/limit not finite numbers => null (NO fabrication)
 *  - container present + valid numbers + claimed:false  => returns the bucket
 *    with claimed=false (explicit "claimed=false" empty state, still no fake $)
 */
export function parseProgrammaticCredit(body: any): ProgrammaticCredit | null {
  if (!body || typeof body !== 'object') return null
  const raw =
    body.programmatic_credit ??
    body.agent_sdk_credit ??
    body.credit_pool ??
    null
  if (!raw || typeof raw !== 'object') return null

  // Accept either *_usd or bare field names; both must be finite numbers or we
  // bail (never default to 0/limit — that would fabricate a balance).
  const used_usd = pickFiniteNumber(raw.used_usd, raw.used)
  const limit_usd = pickFiniteNumber(raw.limit_usd, raw.limit)
  if (used_usd === null || limit_usd === null) return null

  const resets_at =
    typeof raw.resets_at === 'string' && raw.resets_at.length > 0
      ? raw.resets_at
      : ''
  // `claimed` is optional in the wire shape; if the credit container exists with
  // valid numbers we treat presence as claimed unless explicitly told otherwise.
  const claimed = typeof raw.claimed === 'boolean' ? raw.claimed : true

  return { used_usd, limit_usd, resets_at, claimed }
}

/** First finite number among the candidates, else null. */
function pickFiniteNumber(...candidates: any[]): number | null {
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
  }
  return null
}

/**
 * Parse the `/api/oauth/usage` JSON body into a `UsagePayload`.
 *
 * `five_hour` is the primary window and is required; if it's missing/malformed
 * we return null (nothing to report). `seven_day` is required by the hub schema
 * — if absent we mirror `five_hour`'s reset but flag util 0 so older Max-only
 * accounts still type-check. Opus + oauth-apps are passed through only when
 * present (Max-only / optional).
 */
export function parseUsageResponse(body: any): UsagePayload | null {
  const five_hour = parseWindow(body?.five_hour)
  if (!five_hour) return null

  // seven_day is required by the hub schema. Real Max/Pro accounts always
  // include it; if a response omits it, fall back to the five_hour reset with
  // zero utilization so the payload still validates rather than dropping the
  // whole report.
  const seven_day = parseWindow(body?.seven_day) ?? {
    utilization: 0,
    resets_at: five_hour.resets_at,
  }

  const seven_day_opus = parseWindow(body?.seven_day_opus)
  const seven_day_oauth_apps = parseWindow(body?.seven_day_oauth_apps)

  const payload: UsagePayload = { five_hour, seven_day }
  if (seven_day_opus) payload.seven_day_opus = seven_day_opus
  if (seven_day_oauth_apps) payload.seven_day_oauth_apps = seven_day_oauth_apps

  // Phase 18 (R-PTY-17): additive second bucket. Absent/unrecognised credit body
  // => omitted (explicit empty state). The token is NEVER read here — only the
  // already-fetched, non-secret JSON body is parsed.
  const programmatic_credit = parseProgrammaticCredit(body)
  if (programmatic_credit) payload.programmatic_credit = programmatic_credit

  return payload
}

export type PollResult =
  | { ok: true; usage: UsagePayload }
  | { ok: false; reason: string }

/**
 * Read the token, hit the endpoint, parse all four windows. Never throws — all
 * failure modes (missing/expired token, network error, non-2xx, empty body)
 * return `{ ok:false, reason }` so the caller logs and moves on.
 *
 * The token is read locally and used only as the request Authorization header;
 * it is never returned, logged, or sent to the hub.
 */
export async function pollUsage(opts?: {
  now?: number
  fetchImpl?: typeof fetch
  credentialsPathOverride?: string
}): Promise<PollResult> {
  const now = opts?.now ?? Date.now()
  const fetchImpl = opts?.fetchImpl ?? fetch
  const cred = readAccessToken(now, opts?.credentialsPathOverride ?? credentialsPath())
  if (cred.token === null) {
    return { ok: false, reason: cred.reason }
  }
  let res: Response
  try {
    res = await fetchImpl(OAUTH_USAGE_URL, {
      method: 'GET',
      headers: {
        ...OAUTH_USAGE_HEADERS,
        Authorization: `Bearer ${cred.token}`,
      },
      signal: AbortSignal.timeout(15_000),
    })
  } catch (err: any) {
    return { ok: false, reason: `network_error: ${err?.message ?? err}` }
  }
  if (res.status === 401) {
    return { ok: false, reason: 'unauthorized_401_token_invalid' }
  }
  if (!res.ok) {
    return { ok: false, reason: `http_${res.status}` }
  }
  let body: any
  try {
    body = await res.json()
  } catch (err: any) {
    return { ok: false, reason: `body_parse_error: ${err?.message ?? err}` }
  }
  const usage = parseUsageResponse(body)
  if (!usage) {
    return { ok: false, reason: 'no_usable_windows' }
  }
  return { ok: true, usage }
}

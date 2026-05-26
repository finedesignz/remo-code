// Polls Anthropic's Claude subscription quota endpoint and reports back via a
// callback. Reads the OAuth access token from ~/.claude/.credentials.json on
// EVERY tick — Claude Code refreshes it on its own and we never want to cache.
//
// Errors (missing creds file, 401, network, malformed JSON) are non-fatal:
// log a warning and try again next interval. The agent must keep running.

import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'
const USER_AGENT = 'claude-code/2.0.15'
const ANTHROPIC_BETA = 'oauth-2025-04-20'

export interface UsageWindow {
  utilization: number
  resets_at: string
}

export interface UsagePayload {
  five_hour: UsageWindow
  seven_day: UsageWindow
  seven_day_opus?: UsageWindow | null
  seven_day_oauth_apps?: UsageWindow | null
}

interface CredentialsFile {
  claudeAiOauth?: { accessToken?: string }
}

function isUsageWindow(v: unknown): v is UsageWindow {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.utilization === 'number' && typeof o.resets_at === 'string'
}

function isNullableUsageWindow(v: unknown): v is UsageWindow | null | undefined {
  return v == null || isUsageWindow(v)
}

export function parseUsagePayload(raw: unknown): UsagePayload | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!isUsageWindow(o.five_hour)) return null
  if (!isUsageWindow(o.seven_day)) return null
  if (!isNullableUsageWindow(o.seven_day_opus)) return null
  if (!isNullableUsageWindow(o.seven_day_oauth_apps)) return null
  return {
    five_hour: o.five_hour,
    seven_day: o.seven_day,
    seven_day_opus: (o.seven_day_opus as UsageWindow | null | undefined) ?? null,
    seven_day_oauth_apps: (o.seven_day_oauth_apps as UsageWindow | null | undefined) ?? null,
  }
}

export function readAccessToken(path?: string): string | null {
  const credPath = path ?? join(homedir(), '.claude', '.credentials.json')
  try {
    const raw = readFileSync(credPath, 'utf8')
    const parsed = JSON.parse(raw) as CredentialsFile
    const tok = parsed?.claudeAiOauth?.accessToken
    return typeof tok === 'string' && tok.length > 0 ? tok : null
  } catch {
    return null
  }
}

export interface PollDeps {
  fetchFn?: typeof fetch
  readToken?: () => string | null
  logger?: (msg: string) => void
}

/** Performs ONE poll cycle. Resolves with payload or null on any failure. */
export async function pollOnce(deps: PollDeps = {}): Promise<UsagePayload | null> {
  const fetchFn = deps.fetchFn ?? fetch
  const readToken = deps.readToken ?? (() => readAccessToken())
  const log = deps.logger ?? ((m) => console.warn(`[usage-poll] ${m}`))

  const token = readToken()
  if (!token) {
    log('no access token in ~/.claude/.credentials.json (skipping)')
    return null
  }

  let res: Response
  try {
    res = await fetchFn(QUOTA_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': ANTHROPIC_BETA,
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain, */*',
        'Content-Type': 'application/json',
      },
    })
  } catch (err: any) {
    log(`network error: ${err?.message ?? err}`)
    return null
  }

  if (!res.ok) {
    log(`HTTP ${res.status} (token may be expired; will retry)`)
    return null
  }

  let body: unknown
  try {
    body = await res.json()
  } catch (err: any) {
    log(`malformed JSON: ${err?.message ?? err}`)
    return null
  }

  const parsed = parseUsagePayload(body)
  if (!parsed) {
    log('payload failed schema validation')
    return null
  }
  return parsed
}

export interface PollerHandle {
  stop: () => void
  trigger: () => Promise<void>
}

/**
 * Start a poller that fires immediately + every `intervalMs` (default 5m).
 * `onUsage` is invoked with each successful payload. Failures are silent
 * (logged via logger) so callers stay simple.
 */
export function startUsagePoller(
  onUsage: (u: UsagePayload) => void,
  opts: PollDeps & { intervalMs?: number } = {},
): PollerHandle {
  const intervalMs = opts.intervalMs ?? 5 * 60 * 1000
  let stopped = false

  const tick = async () => {
    if (stopped) return
    const payload = await pollOnce(opts)
    if (!stopped && payload) onUsage(payload)
  }

  // Fire immediately, then on interval.
  void tick()
  const handle = setInterval(() => { void tick() }, intervalMs)

  return {
    stop: () => { stopped = true; clearInterval(handle) },
    trigger: tick,
  }
}

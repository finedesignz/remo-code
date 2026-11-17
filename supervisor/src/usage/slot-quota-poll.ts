/**
 * slot-quota-poll.ts - CORCH-14: the built-in account quota source of a slot supervisor.
 *
 * A slot (REMO_ACCOUNT_SLOT set) holds a long-lived setup-token. That token lacks the `user:profile` scope, so
 * `/api/oauth/usage` (oauth-poll.ts) answers 403 for it. The account's usage is instead read from the unified
 * rate-limit headers of a minimal `max_tokens: 1` inference call made with the same token: utilization is a 0..1
 * fraction, reset is unix seconds. Only the parsed windows leave this module.
 *
 * HARD INVARIANT: the token is read from this process's env and used only as the Authorization header. It is
 * never returned, logged or placed in a hub frame. The response body is never read.
 */
import { accountSlot } from '../slot'

export const SLOT_QUOTA_URL = 'https://api.anthropic.com/v1/messages'
export const SLOT_QUOTA_PROBE_MODEL = 'claude-haiku-4-5'
export const SLOT_QUOTA_DEFAULT_INTERVAL_MS = 5 * 60_000
const SLOT_QUOTA_MIN_INTERVAL_MS = 60_000

export interface SlotQuotaReport {
  account_slot: string
  /** 0..100 */
  five_h_pct: number
  /** 0..100 */
  seven_d_pct: number
  resets_5h: string | null
  resets_7d: string | null
  fetched_at: string
}

export type SlotQuotaResult = { ok: true; report: SlotQuotaReport } | { ok: false; reason: string }

/** Poll cadence from REMO_SLOT_QUOTA_INTERVAL_MS (default 5 min, never below 1 min). */
export function slotQuotaIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.REMO_SLOT_QUOTA_INTERVAL_MS)
  if (!Number.isFinite(n) || n <= 0) return SLOT_QUOTA_DEFAULT_INTERVAL_MS
  return Math.max(SLOT_QUOTA_MIN_INTERVAL_MS, Math.floor(n))
}

/** True only for a slot supervisor that also holds its account token. */
export function slotQuotaEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return accountSlot(env) !== null && !!env.CLAUDE_CODE_OAUTH_TOKEN
}

function pct(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null
  const v = Number(raw)
  if (!Number.isFinite(v) || v < 0 || v > 1) return null
  return v * 100
}

function resetIso(raw: string | null): string | null {
  if (raw === null || raw.trim() === '') return null
  const secs = Number(raw)
  if (!Number.isFinite(secs) || secs <= 0) return null
  const d = new Date(secs * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Both utilization headers are required and must be 0..1; a missing or malformed reset is null. */
export function parseUnifiedHeaders(
  headers: Headers,
): { five_h_pct: number; seven_d_pct: number; resets_5h: string | null; resets_7d: string | null } | null {
  const five_h_pct = pct(headers.get('anthropic-ratelimit-unified-5h-utilization'))
  const seven_d_pct = pct(headers.get('anthropic-ratelimit-unified-7d-utilization'))
  if (five_h_pct === null || seven_d_pct === null) return null
  return {
    five_h_pct,
    seven_d_pct,
    resets_5h: resetIso(headers.get('anthropic-ratelimit-unified-5h-reset')),
    resets_7d: resetIso(headers.get('anthropic-ratelimit-unified-7d-reset')),
  }
}

/** One probe. Never throws; every failure is `{ ok:false, reason }` with a code only (no value, no body). */
export async function pollSlotQuota(opts?: {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => Date
}): Promise<SlotQuotaResult> {
  const env = opts?.env ?? process.env
  const slot = accountSlot(env)
  if (slot === null) return { ok: false, reason: 'not_a_slot' }
  const token = env.CLAUDE_CODE_OAUTH_TOKEN
  if (!token) return { ok: false, reason: 'slot_token_missing' }
  let res: Response
  try {
    res = await (opts?.fetchImpl ?? fetch)(SLOT_QUOTA_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.0.15',
      },
      body: JSON.stringify({ model: SLOT_QUOTA_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (err: any) {
    return { ok: false, reason: `network_error: ${err?.name ?? 'error'}` }
  }
  if (!res.ok) return { ok: false, reason: `http_${res.status}` }
  const windows = parseUnifiedHeaders(res.headers)
  if (!windows) return { ok: false, reason: 'usage_headers_unavailable' }
  return { ok: true, report: { account_slot: slot, ...windows, fetched_at: (opts?.now?.() ?? new Date()).toISOString() } }
}

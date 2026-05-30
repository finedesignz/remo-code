/**
 * P2 usage ledger — model → list-price table, FALLBACK ONLY.
 *
 * IMPORTANT: the supervisor reports the SDK's authoritative `total_cost_usd`
 * per turn (`cost_source: 'sdk'`). That value is the source of truth and is
 * NEVER recomputed here. This table is consulted ONLY when the SDK did not
 * supply a cost (`cost_source: 'estimated'`) — e.g. an older CLI or an error
 * result — so the ledger still has a best-effort dollar figure.
 *
 * All figures are Anthropic public LIST prices and represent a *subscription
 * list-price equivalent ESTIMATE*, not billed dollars. A Claude Code Max/Pro
 * subscriber is not charged per token; this is a usage-equivalence number.
 *
 * Rates are USD per 1,000,000 tokens.
 *
 *   ┌─────────────────────────────────────────────────────────────────────┐
 *   │ TO UPDATE PRICES: edit PRICES below. Source of truth is the Anthropic │
 *   │ pricing page → https://www.anthropic.com/pricing (API tab) and the   │
 *   │ model docs. Match on the longest model-id prefix. Last reviewed:     │
 *   │ 2026-05-30 (Opus/Sonnet/Haiku 4.x).                                  │
 *   └─────────────────────────────────────────────────────────────────────┘
 */

export interface ModelRates {
  /** USD per 1M input tokens. */
  input: number
  /** USD per 1M output tokens. */
  output: number
  /** USD per 1M cache-WRITE (creation) tokens. */
  cache_write: number
  /** USD per 1M cache-READ tokens. */
  cache_read: number
}

// Keyed by model-id PREFIX. Resolution matches the longest prefix that the
// incoming model id starts with, so "claude-opus-4-1-20250930" → "claude-opus-4".
// Cache-write is the standard 5m-TTL rate (1.25× input); cache-read is 0.1× input.
export const PRICES: Record<string, ModelRates> = {
  // Opus 4.x — $15 in / $75 out per 1M
  'claude-opus-4': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  // Sonnet 4.x — $3 in / $15 out per 1M
  'claude-sonnet-4': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  // Haiku 4.x — $1 in / $5 out per 1M (3.5 Haiku was $0.80/$4; 4.x bumped)
  'claude-haiku-4': { input: 1, output: 5, cache_write: 1.25, cache_read: 0.1 },
  // Legacy 3.5 fallbacks (in case an older CLI reports them)
  'claude-3-5-sonnet': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
}

// Conservative default when a model id doesn't match any prefix — use Sonnet
// rates so an unknown model yields a non-zero, plausible estimate.
export const DEFAULT_RATES: ModelRates = PRICES['claude-sonnet-4']!

export function ratesForModel(model: string | null | undefined): ModelRates {
  if (!model) return DEFAULT_RATES
  let best: ModelRates | null = null
  let bestLen = -1
  for (const prefix in PRICES) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = PRICES[prefix]!
      bestLen = prefix.length
    }
  }
  return best ?? DEFAULT_RATES
}

export interface TokenCounts {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

/**
 * Fallback cost estimate (USD) from token counts + model list price.
 * ONLY used when the SDK didn't supply total_cost_usd. Returns a number
 * rounded to 6 decimals. This is a list-price ESTIMATE, not billed dollars.
 */
export function estimateCostUsd(model: string | null | undefined, t: TokenCounts): number {
  const r = ratesForModel(model)
  const usd =
    (t.input_tokens * r.input +
      t.output_tokens * r.output +
      t.cache_creation_input_tokens * r.cache_write +
      t.cache_read_input_tokens * r.cache_read) /
    1_000_000
  return Math.round(usd * 1e6) / 1e6
}

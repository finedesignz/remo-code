/**
 * LLM risk escalator (Phase 6).
 *
 * Implements the `LlmEscalator` interface declared in `risk-classifier.ts`.
 * Trigger (set by the classifier, not here): heuristic says `minor` AND diff
 * is large (>200 lines OR >5 files). When triggered, ask Claude to
 * re-classify; cache by `diff_hash` for 1h. Parse failure → `major`.
 *
 * No existing Anthropic client lives in this repo — the master plan said
 * "if not trivially reusable, write a thin stub and document." This is that
 * stub. Uses the raw HTTPS Messages API with `ANTHROPIC_API_KEY`.
 *
 * Env:
 *   ANTHROPIC_API_KEY     required
 *   ANTHROPIC_MODEL       default 'claude-3-5-haiku-latest'
 *                         (cheap+fast; classification is a 1-token reply)
 *   ANTHROPIC_BASE_URL    default 'https://api.anthropic.com'
 *   LLM_ESCALATOR_CACHE_TTL_MS  default 3_600_000 (1h)
 */
import { createHash } from 'node:crypto'
import type { RiskClass } from './risk-classifier.ts'

const VALID_CLASSES: RiskClass[] = ['minor', 'major', 'breaking']
const MAX_DIFF_CHARS = 8000

const PROMPT_TEMPLATE = `You are a senior reviewer. Classify this diff as minor, major, or breaking.
- minor: cosmetic only (CSS, copy, README); no API or schema or behavior change.
- major: behavior change, refactor, new feature, lockfile shift.
- breaking: API contract change, schema migration, removed function, env var add/remove.
Reply with exactly one word: minor | major | breaking.
<diff>{DIFF}</diff>`

interface CacheEntry {
  result: RiskClass
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

export interface CreateLlmEscalatorOpts {
  /** Test seam — inject HTTP. */
  fetcher?: typeof fetch
  /** Test seam — override clock. */
  now?: () => number
  /** Test seam — override cache TTL. */
  cacheTtlMs?: number
  /** Test seam — preset cache. */
  cacheRef?: Map<string, CacheEntry>
}

export interface LlmEscalator {
  classify(diff: string): Promise<RiskClass | null>
}

/**
 * Build an LlmEscalator. Returns `null` from `classify` when:
 *   - ANTHROPIC_API_KEY missing (caller falls back to heuristic).
 * Returns `'major'` (safe default) when:
 *   - API call fails non-retryably.
 *   - Response can't be parsed into one of the three classes.
 */
export function createLlmEscalator(opts: CreateLlmEscalatorOpts = {}): LlmEscalator {
  const f = opts.fetcher ?? (globalThis.fetch as typeof fetch)
  const now = opts.now ?? (() => Date.now())
  const ttl = opts.cacheTtlMs ?? Number(process.env.LLM_ESCALATOR_CACHE_TTL_MS ?? 3_600_000)
  const cacheStore = opts.cacheRef ?? cache

  return {
    async classify(diff: string): Promise<RiskClass | null> {
      const apiKey = process.env.ANTHROPIC_API_KEY
      if (!apiKey) return null

      const model = process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest'
      const baseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '')

      const truncated = diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) : diff
      const hash = sha256(truncated)

      // Cache hit?
      const hit = cacheStore.get(hash)
      if (hit && hit.expiresAt > now()) return hit.result

      const prompt = PROMPT_TEMPLATE.replace('{DIFF}', truncated)
      try {
        const res = await f(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(20_000),
        })
        if (!res.ok) {
          console.warn(`[llm-escalator] non-2xx ${res.status}; defaulting to major`)
          return cacheAndReturn(cacheStore, hash, 'major', now() + ttl)
        }
        const data: any = await res.json()
        const text = extractText(data)
        const parsed = parseClass(text)
        const result: RiskClass = parsed ?? 'major'
        return cacheAndReturn(cacheStore, hash, result, now() + ttl)
      } catch (err: any) {
        console.warn(`[llm-escalator] threw (${err?.message ?? err}); defaulting to major`)
        return cacheAndReturn(cacheStore, hash, 'major', now() + ttl)
      }
    },
  }
}

function extractText(data: any): string {
  if (!data || !Array.isArray(data.content)) return ''
  const text = data.content.find((c: any) => c?.type === 'text')
  return (text?.text ?? '').trim()
}

function parseClass(reply: string): RiskClass | null {
  const word = reply.toLowerCase().trim().split(/\s+/)[0]?.replace(/[^a-z]/g, '') ?? ''
  return VALID_CLASSES.find((c) => c === word) ?? null
}

function cacheAndReturn(store: Map<string, CacheEntry>, hash: string, result: RiskClass, expiresAt: number): RiskClass {
  store.set(hash, { result, expiresAt })
  return result
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

// Test helpers.
export const _internals = { parseClass, extractText, sha256, PROMPT_TEMPLATE, MAX_DIFF_CHARS }
export function _resetCache(): void { cache.clear() }

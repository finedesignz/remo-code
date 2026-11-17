// hub/src/corch/quota-death.ts
//
// CORCH-02 (LD-Q10): classify the end text of a run as a subscription-usage-limit death. Pure: no DB, no
// clock. Anchored on the CLI signal established in CORCH-02-RESEARCH.md Q1: the WHOLE trimmed text must match
// and be at most 500 chars, so a long assistant message that merely mentions a usage limit is NOT a death
// (worst case of a false positive is a requeue with no attempt consumed, T-CORCH02-08).
//
// Two CLI forms are recognised:
//   legacy   `Claude AI usage limit reached|<epoch seconds>`           -> exact reset instant
//   current  `You've hit your <session|weekly|Opus|Sonnet> limit · resets <local time>` -> the reset is
//            a human string, deliberately NOT parsed; the window is reported so the store can fall back to
//            that window's reset from the CUG reading.
// Spend / credit / team-budget limits ("monthly spend limit", "shared budget") are not window quota and never match.

export type QuotaWindow = '5h' | '7d'

export interface QuotaDeath {
  /** The reset instant when the signal carries an unambiguous one (legacy epoch), else null. */
  resetAt: Date | null
  /** Which CUG window the limit belongs to, when the signal names it. */
  window: QuotaWindow | null
}

const MAX_LEN = 500
const LEGACY = /^Claude AI usage limit reached\|(\d{9,11})$/
const CURRENT = /^You[’']ve hit your (session|weekly|Opus|Sonnet) limit(?:[ \t]*[·|\-][^\n]*)?\.?$/

export function classifyQuotaDeath(text: string | null | undefined): QuotaDeath | null {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (t.length === 0 || t.length > MAX_LEN) return null

  const legacy = LEGACY.exec(t)
  if (legacy) {
    const ms = Number(legacy[1]) * 1000
    const d = new Date(ms)
    return { resetAt: Number.isFinite(d.getTime()) ? d : null, window: null }
  }

  const current = CURRENT.exec(t)
  if (current) return { resetAt: null, window: current[1] === 'session' ? '5h' : '7d' }
  return null
}

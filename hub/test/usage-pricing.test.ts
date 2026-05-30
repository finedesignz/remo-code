import { describe, it, expect } from 'bun:test'
import { ratesForModel, estimateCostUsd, PRICES, DEFAULT_RATES } from '../src/usage/pricing.ts'

describe('pricing fallback (P2)', () => {
  it('matches the longest model-id prefix', () => {
    expect(ratesForModel('claude-opus-4-1-20250930')).toBe(PRICES['claude-opus-4']!)
    expect(ratesForModel('claude-sonnet-4-20250514')).toBe(PRICES['claude-sonnet-4']!)
    expect(ratesForModel('claude-haiku-4-20250101')).toBe(PRICES['claude-haiku-4']!)
  })

  it('falls back to default rates for unknown / null model', () => {
    expect(ratesForModel('gpt-4o')).toBe(DEFAULT_RATES)
    expect(ratesForModel(null)).toBe(DEFAULT_RATES)
  })

  it('computes list-price estimate from token buckets', () => {
    // Opus: $15 in, $75 out, $18.75 cache-write, $1.50 cache-read per 1M
    // 1M in + 1M out + 1M cc + 1M cr = 15 + 75 + 18.75 + 1.5 = 110.25
    const cost = estimateCostUsd('claude-opus-4-1', {
      input_tokens: 1_000_000,
      output_tokens: 1_000_000,
      cache_creation_input_tokens: 1_000_000,
      cache_read_input_tokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(110.25, 6)
  })

  it('scales linearly and rounds to 6 decimals', () => {
    // Sonnet $3/1M input: 1000 input tokens => $0.003
    const cost = estimateCostUsd('claude-sonnet-4', {
      input_tokens: 1000,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    })
    expect(cost).toBe(0.003)
  })
})

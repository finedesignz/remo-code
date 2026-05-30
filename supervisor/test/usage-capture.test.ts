import { describe, it, expect } from 'bun:test'
import { parseUsageFromResult } from '../src/runners/claude-runner'

describe('parseUsageFromResult (P2 capture)', () => {
  it('extracts token buckets + SDK cost from a result event', () => {
    const sample = {
      type: 'result',
      subtype: 'success',
      result: 'done',
      duration_ms: 1234,
      total_cost_usd: 0.0421,
      usage: {
        input_tokens: 1500,
        output_tokens: 800,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 12000,
      },
    }
    const out = parseUsageFromResult(sample, 'claude-opus-4-1-20250930')
    expect(out.cost).toBe(0.0421)
    expect(out.cost_from_sdk).toBe(true)
    expect(out.model).toBe('claude-opus-4-1-20250930')
    expect(out.usage).toEqual({
      input_tokens: 1500,
      output_tokens: 800,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 12000,
    })
  })

  it('flags cost_from_sdk=false when total_cost_usd is absent', () => {
    const out = parseUsageFromResult(
      { type: 'result', usage: { input_tokens: 10, output_tokens: 5 } },
      'claude-sonnet-4-20250514',
    )
    expect(out.cost).toBe(0)
    expect(out.cost_from_sdk).toBe(false)
    expect(out.usage?.input_tokens).toBe(10)
    expect(out.usage?.cache_creation_input_tokens).toBe(0)
  })

  it('returns null usage when the result has no usage object', () => {
    const out = parseUsageFromResult(
      { type: 'result', subtype: 'error', total_cost_usd: 0 },
      null,
    )
    expect(out.usage).toBeNull()
  })

  it('prefers explicit result.model, else modelUsage key, else fallback', () => {
    expect(parseUsageFromResult({ model: 'm-explicit', usage: {} }, 'fb').model).toBe('m-explicit')
    expect(
      parseUsageFromResult({ modelUsage: { 'm-breakdown': {} }, usage: {} }, 'fb').model,
    ).toBe('m-breakdown')
    expect(parseUsageFromResult({ usage: {} }, 'm-fallback').model).toBe('m-fallback')
  })
})

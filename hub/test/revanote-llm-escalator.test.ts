import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { createLlmEscalator, _internals, _resetCache } from '../src/revanote/llm-escalator'

const savedEnv = { ...process.env }

beforeEach(() => {
  _resetCache()
})

afterEach(() => {
  process.env = { ...savedEnv }
})

describe('parseClass', () => {
  test('extracts class word from messy replies', () => {
    expect(_internals.parseClass('minor')).toBe('minor')
    expect(_internals.parseClass('  MAJOR\n')).toBe('major')
    expect(_internals.parseClass('breaking.')).toBe('breaking')
    expect(_internals.parseClass('breaking — schema migration')).toBe('breaking')
  })

  test('rejects unknown words', () => {
    expect(_internals.parseClass('safe')).toBeNull()
    expect(_internals.parseClass('')).toBeNull()
  })
})

describe('createLlmEscalator.classify', () => {
  test('returns null when ANTHROPIC_API_KEY missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const esc = createLlmEscalator({ fetcher: (async () => { throw new Error('should not call') }) as any })
    const out = await esc.classify('diff body')
    expect(out).toBeNull()
  })

  test('parses single-word reply', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const fetcher = (async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'major' }],
    }), { status: 200 })) as unknown as typeof fetch
    const esc = createLlmEscalator({ fetcher })
    const out = await esc.classify('any diff')
    expect(out).toBe('major')
  })

  test('non-2xx → defaults to major', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const fetcher = (async () => new Response('rate limit', { status: 429 })) as unknown as typeof fetch
    const esc = createLlmEscalator({ fetcher })
    const out = await esc.classify('diff')
    expect(out).toBe('major')
  })

  test('parse failure → defaults to major', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const fetcher = (async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: 'I think this could be either' }],
    }), { status: 200 })) as unknown as typeof fetch
    const esc = createLlmEscalator({ fetcher })
    const out = await esc.classify('diff')
    expect(out).toBe('major')
  })

  test('cache hit by diff_hash — second call doesnt fetch', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'breaking' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const esc = createLlmEscalator({ fetcher })
    const a = await esc.classify('SAME-DIFF-BODY')
    const b = await esc.classify('SAME-DIFF-BODY')
    expect(a).toBe('breaking')
    expect(b).toBe('breaking')
    expect(calls).toBe(1)
  })

  test('cache expiry refreshes the call', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    let calls = 0
    const fetcher = (async () => {
      calls++
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'minor' }] }), { status: 200 })
    }) as unknown as typeof fetch
    let nowVal = 1000
    const esc = createLlmEscalator({ fetcher, now: () => nowVal, cacheTtlMs: 100 })
    await esc.classify('XX')
    nowVal = 2000
    await esc.classify('XX')
    expect(calls).toBe(2)
  })

  test('truncates very large diffs to MAX_DIFF_CHARS in prompt', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    let captured = ''
    const fetcher = (async (_url: any, init: any) => {
      captured = init?.body ?? ''
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'minor' }] }), { status: 200 })
    }) as unknown as typeof fetch
    const esc = createLlmEscalator({ fetcher })
    const huge = 'x'.repeat(_internals.MAX_DIFF_CHARS + 5000)
    await esc.classify(huge)
    // prompt body had truncated diff
    const parsed = JSON.parse(captured)
    const promptText = parsed.messages[0].content as string
    // Should contain at most MAX_DIFF_CHARS x's between <diff> tags
    const m = /<diff>(.*?)<\/diff>/s.exec(promptText)
    expect(m).not.toBeNull()
    expect(m![1].length).toBeLessThanOrEqual(_internals.MAX_DIFF_CHARS)
  })
})

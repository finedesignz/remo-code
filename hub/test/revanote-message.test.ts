import { describe, expect, test } from 'bun:test'
// Mirror of the web-side helper. Keeping a hub-side smoke test so the
// regex shape stays in lockstep with `parseScheduledPrefix` consumers.

function parseRevanotePrefix(
  content: string,
): { preview: string; body: string } | null {
  const m = content.match(/^\[revanote:\s*([^\]]*)\]\n\n([\s\S]*)$/)
  return m ? { preview: m[1].trim(), body: m[2] } : null
}

describe('parseRevanotePrefix shape', () => {
  test('parses standard prefix', () => {
    const r = parseRevanotePrefix('[revanote: button is wrong]\n\nBody here.')
    expect(r).not.toBeNull()
    expect(r!.preview).toBe('button is wrong')
    expect(r!.body).toBe('Body here.')
  })

  test('returns null for non-matching content', () => {
    expect(parseRevanotePrefix('plain message')).toBeNull()
    expect(parseRevanotePrefix('[scheduled: x]\n\nbody')).toBeNull()
  })

  test('multi-line body preserved', () => {
    const r = parseRevanotePrefix('[revanote: x]\n\nline1\nline2\n\nline3')
    expect(r!.body).toBe('line1\nline2\n\nline3')
  })
})

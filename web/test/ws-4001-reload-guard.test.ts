import { describe, expect, test } from 'bun:test'
import { shouldReloadNow, RELOAD_GUARD_WINDOW_MS } from '../src/lib/reload-guard'

function mem() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}

describe('4001 reload guard', () => {
  test('first reload allowed, immediate repeat refused, allowed after the window', () => {
    const s = mem()
    expect(shouldReloadNow(s, 1_000_000)).toBe(true)
    expect(shouldReloadNow(s, 1_000_000 + 5_000)).toBe(false)
    expect(shouldReloadNow(s, 1_000_000 + RELOAD_GUARD_WINDOW_MS + 1)).toBe(true)
  })
  test('no storage => never reload', () => {
    expect(shouldReloadNow(null, 1)).toBe(false)
  })
})

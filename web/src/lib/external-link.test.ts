import { describe, test, expect } from 'bun:test'
import { shouldOpenExternally } from './external-link'

const PAGE = 'https://app.remo-code.com'

function click(over: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; defaultPrevented: boolean }> = {}) {
  return { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, ...over }
}

describe('shouldOpenExternally', () => {
  test('returns null outside the mobile app', () => {
    expect(shouldOpenExternally(click(), { href: 'https://example.com/', target: '_blank', origin: 'https://example.com' }, PAGE, false)).toBeNull()
  })

  test('intercepts target=_blank cross-origin in mobile', () => {
    expect(shouldOpenExternally(click(), { href: 'https://example.com/x', target: '_blank', origin: 'https://example.com' }, PAGE, true)).toBe('https://example.com/x')
  })

  test('intercepts cross-origin without _blank in mobile', () => {
    expect(shouldOpenExternally(click(), { href: 'https://example.com/y', target: '', origin: 'https://example.com' }, PAGE, true)).toBe('https://example.com/y')
  })

  test('passes through same-origin internal links', () => {
    expect(shouldOpenExternally(click(), { href: `${PAGE}/grid`, target: '', origin: PAGE }, PAGE, true)).toBeNull()
  })

  test('intercepts same-origin _blank (user explicitly asked for new window)', () => {
    expect(shouldOpenExternally(click(), { href: `${PAGE}/docs`, target: '_blank', origin: PAGE }, PAGE, true)).toBe(`${PAGE}/docs`)
  })

  test('ignores modifier-key clicks', () => {
    expect(shouldOpenExternally(click({ metaKey: true }), { href: 'https://example.com/', target: '_blank', origin: 'https://example.com' }, PAGE, true)).toBeNull()
    expect(shouldOpenExternally(click({ ctrlKey: true }), { href: 'https://example.com/', target: '_blank', origin: 'https://example.com' }, PAGE, true)).toBeNull()
  })

  test('ignores non-primary mouse buttons', () => {
    expect(shouldOpenExternally(click({ button: 1 }), { href: 'https://example.com/', target: '_blank', origin: 'https://example.com' }, PAGE, true)).toBeNull()
  })

  test('ignores defaultPrevented events', () => {
    expect(shouldOpenExternally(click({ defaultPrevented: true }), { href: 'https://example.com/', target: '_blank', origin: 'https://example.com' }, PAGE, true)).toBeNull()
  })

  test('ignores javascript: and fragment-only hrefs', () => {
    expect(shouldOpenExternally(click(), { href: 'javascript:void(0)', target: '_blank', origin: '' }, PAGE, true)).toBeNull()
    expect(shouldOpenExternally(click(), { href: '#section', target: '_blank', origin: '' }, PAGE, true)).toBeNull()
  })

  test('returns null when anchor is missing', () => {
    expect(shouldOpenExternally(click(), null, PAGE, true)).toBeNull()
  })
})

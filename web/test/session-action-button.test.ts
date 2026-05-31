// SessionActionButton contract — correct icon per kind, accessible label,
// adequate hit area, blue accent for play, danger for stop/disconnect.
// Uses React.createElement (no JSX) so bun:test needs no jsx-dev-runtime.
import { describe, expect, test } from 'bun:test'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { SessionActionButton } from '../src/components/SessionActionButton'

const render = (props: Parameters<typeof SessionActionButton>[0]): string =>
  renderToStaticMarkup(h(SessionActionButton, props))

describe('SessionActionButton', () => {
  test('play renders a triangle glyph, blue accent + default label', () => {
    const html = render({ kind: 'play', onClick: () => {} })
    expect(html).toContain('aria-label="Start session"')
    expect(html).toContain('title="Start session"')
    expect(html).toContain('M6 4l10 6-10 6V4z') // play path
    expect(html).toContain('text-blue-400')
  })

  test('stop renders a square glyph with danger tone', () => {
    const html = render({ kind: 'stop', onClick: () => {} })
    expect(html).toContain('aria-label="Stop session"')
    expect(html).toContain('<rect') // stop square
    expect(html).toContain('text-red-400')
  })

  test('disconnect uses an unplug glyph + danger tone', () => {
    const html = render({ kind: 'disconnect', onClick: () => {} })
    expect(html).toContain('aria-label="Disconnect session"')
    expect(html).toContain('text-red-400')
  })

  test('hit area is >= 44px and carries an accent focus ring', () => {
    const html = render({ kind: 'play', onClick: () => {} })
    expect(html).toContain('min-w-[44px]')
    expect(html).toContain('min-h-[44px]')
    expect(html).toContain('focus-visible:ring-blue-500')
  })

  test('custom label overrides the default; loading marks aria-busy + disabled', () => {
    const html = render({ kind: 'stop', label: 'Stop orchestrator session', loading: true, onClick: () => {} })
    expect(html).toContain('aria-label="Stop orchestrator session"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('disabled')
    expect(html).toContain('motion-reduce:animate-none') // reduced-motion safe spinner
  })
})

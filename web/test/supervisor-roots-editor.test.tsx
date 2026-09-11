/**
 * web/test/supervisor-roots-editor.test.tsx
 * fix/connections-compact-header — SupervisorRootsEditor collapse/expand.
 *
 * Coverage (per QC panel finding 4, 2026-09-10):
 *   1. Zero roots -> renders EXPANDED regardless of any stored localStorage state.
 *   2. >=1 root, no stored preference -> renders COLLAPSED (icon + count badge).
 *   3. Clicking the collapsed icon expands the panel inline.
 *   4. Expand state is persisted to localStorage keyed by supervisor id, and a
 *      localStorage that throws (private browsing / quota) does not crash the
 *      component (try/catch contract).
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (!(globalThis as any).document) GlobalRegistrator.register()
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

mock.module('../src/lib/api', () => ({
  hubFetch: async () => ({ ok: true, applied: 'live', roots: [], supervisor_error: null }),
  HubFetchError: class HubFetchError extends Error {
    status: number
    body: any
    constructor(status: number, body: any) {
      super('hub fetch error')
      this.status = status
      this.body = body
    }
  },
}))

const { SupervisorRootsEditor } = await import('../src/components/SupervisorRootsEditor')

afterAll(() => {
  mock.restore()
})

let root: any
let host: HTMLDivElement

beforeEach(() => {
  try { window.localStorage.clear() } catch {}
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(async () => {
  const { act } = await import('react')
  if (root) await act(async () => { root.unmount() })
  host.remove()
  root = null
})

async function render(props: { supervisorId: string; roots: string[] }) {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const React = await import('react')
  root = createRoot(host)
  await act(async () => {
    root.render(
      React.createElement(SupervisorRootsEditor, {
        token: 'test-token',
        supervisorId: props.supervisorId,
        roots: props.roots,
        online: true,
      }),
    )
  })
}

describe('SupervisorRootsEditor — collapse/expand', () => {
  test('zero roots renders expanded (first-run affordance) with no stored state', async () => {
    await render({ supervisorId: 'sup-zero', roots: [] })
    expect(host.textContent).toContain('Root folders')
    expect(host.querySelector('input')).not.toBeNull()
  })

  test('zero roots renders expanded even when a stale "collapsed" preference is stored', async () => {
    window.localStorage.setItem('remo:rootsEditor:expanded:sup-zero-stale', '0')
    await render({ supervisorId: 'sup-zero-stale', roots: [] })
    expect(host.textContent).toContain('Root folders')
    expect(host.querySelector('input')).not.toBeNull()
  })

  test('>=1 root with no stored preference renders collapsed (icon + count badge, no visible list)', async () => {
    await render({ supervisorId: 'sup-one', roots: ['C:\\Users\\artic\\GitHub'] })
    const btn = host.querySelector('button[aria-label="Root folders (1)"]')
    expect(btn).not.toBeNull()
    expect(btn?.textContent).toContain('1')
    // No "Root folders" list panel is visible — the only place that text
    // appears is the styled Tooltip's `role="tooltip"` span (hidden via
    // opacity until hover/focus/tap), not a rendered list heading.
    const withoutTooltips = host.cloneNode(true) as HTMLElement
    withoutTooltips.querySelectorAll('[role="tooltip"]').forEach((t) => t.remove())
    expect(withoutTooltips.textContent).not.toContain('Root folders')
  })

  test('clicking the collapsed icon expands the panel inline', async () => {
    await render({ supervisorId: 'sup-two', roots: ['D:\\ClientWork'] })
    const btn = host.querySelector('button[aria-label="Root folders (1)"]') as HTMLButtonElement
    expect(btn).not.toBeNull()

    const { act } = await import('react')
    await act(async () => { btn.click() })

    expect(host.textContent).toContain('Root folders')
    expect(host.textContent).toContain('D:\\ClientWork')
  })

  test('expand state persists to localStorage keyed by supervisor id', async () => {
    await render({ supervisorId: 'sup-three', roots: ['D:\\ClientWork'] })
    const btn = host.querySelector('button[aria-label="Root folders (1)"]') as HTMLButtonElement
    const { act } = await import('react')
    await act(async () => { btn.click() })

    expect(window.localStorage.getItem('remo:rootsEditor:expanded:sup-three')).toBe('1')

    // Re-render fresh (simulates a page reload) — should come up expanded now.
    await act(async () => { root.unmount() })
    root = null
    host.remove()
    host = document.createElement('div')
    document.body.appendChild(host)
    await render({ supervisorId: 'sup-three', roots: ['D:\\ClientWork'] })
    expect(host.textContent).toContain('Root folders')
  })

  test('a throwing localStorage does not crash render or the toggle click', async () => {
    const real = window.localStorage
    const throwing: Storage = {
      getItem() { throw new Error('storage disabled') },
      setItem() { throw new Error('storage disabled') },
      removeItem() { throw new Error('storage disabled') },
      clear() { throw new Error('storage disabled') },
      key() { throw new Error('storage disabled') },
      length: 0,
    }
    Object.defineProperty(window, 'localStorage', { value: throwing, configurable: true })
    try {
      await render({ supervisorId: 'sup-throw', roots: ['E:\\Repo'] })
      const btn = host.querySelector('button[aria-label="Root folders (1)"]') as HTMLButtonElement
      expect(btn).not.toBeNull()
      const { act } = await import('react')
      await act(async () => { btn.click() })
      expect(host.textContent).toContain('Root folders') // expanded without throwing
    } finally {
      Object.defineProperty(window, 'localStorage', { value: real, configurable: true })
    }
  })
})

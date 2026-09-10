/**
 * web/test/supervisor-page-icon-toolbar.test.tsx
 * feat/connections-icon-toolbar — Connections top card + filter bar compaction.
 *
 * Verifies the icon-only toolbar controls (machine pill, update, add
 * installation, running badge, filter/type segmented controls, search,
 * refresh, launch selected, groups, group by) each carry an `aria-label`
 * and that none of their old visible text labels render on the page.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (!(globalThis as any).document) GlobalRegistrator.register()
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

mock.module('../src/hooks/useSessions', () => ({
  useSessions: () => ({ sessions: [], loading: false, error: null }),
}))

mock.module('../src/hooks/useSupervisors', () => ({
  useSupervisors: () => ({
    supervisors: [
      {
        id: 'sup-1',
        hostname: 'TitaniumTower',
        version: '0.14.5',
        os: 'windows',
        roots: ['C:\\Users\\artic\\GitHub'],
        state: 'starting',
        current_run_id: null,
        last_seen_at: new Date().toISOString(),
        online: true,
      },
    ],
    refetch: () => {},
  }),
}))

mock.module('../src/hooks/useWebSocket', () => ({
  useWebSocketContext: () => ({ subscribe: () => () => {}, connectionId: 1 }),
}))

mock.module('../src/hooks/useRepoGroups', () => ({
  useRepoGroups: () => ({
    groups: [],
    collapsed: new Set(),
    groupView: false,
    setGroupView: () => {},
    isCollapsed: () => false,
    toggleCollapsed: () => {},
    loading: false,
    error: null,
  }),
}))

mock.module('../src/lib/api', () => ({
  hubFetch: async () => ({ ok: true }),
  HubFetchError: class HubFetchError extends Error {
    status: number
    body: any
    constructor(status: number, body: any) {
      super('hub fetch error')
      this.status = status
      this.body = body
    }
  },
  readCookie: () => null,
}))

// apiFetch (defined inline in SupervisorPage.tsx) calls the global fetch
// directly for /api/github/installations, /api/github/repos, /api/supervisors/*/scan.
const originalFetch = globalThis.fetch
function installFetchStub() {
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    if (url.includes('/api/github/installations')) {
      return new Response(JSON.stringify({ configured: true, installations: [{ installation_id: 1, account: 'finedesignz' }] }), { status: 200 })
    }
    if (url.includes('/api/github/repos')) {
      return new Response(JSON.stringify({ repos: [] }), { status: 200 })
    }
    if (url.includes('/scan')) {
      return new Response(JSON.stringify({ repos: [] }), { status: 200 })
    }
    return new Response(JSON.stringify({}), { status: 200 })
  }) as any
}

const { SupervisorPage } = await import('../src/components/SupervisorPage')

afterAll(() => {
  mock.restore()
  globalThis.fetch = originalFetch
})

let root: any
let host: HTMLDivElement

beforeEach(() => {
  installFetchStub()
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(async () => {
  const { act } = await import('react')
  if (root) await act(async () => { root.unmount() })
  host.remove()
  root = null
})

async function render() {
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react')
  const React = await import('react')
  root = createRoot(host)
  await act(async () => {
    root.render(React.createElement(SupervisorPage, { token: 'test-token', embedded: true }))
  })
  // Flush the async loadGitHub()/scan() effects.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

/** Visible label text on a button, excluding its nested styled-tooltip span
 * (role="tooltip" content is intentionally in the DOM for a11y but hidden
 * via opacity, not "visible" in the icon-only sense this test checks). */
function visibleButtonText(el: Element): string {
  const clone = el.cloneNode(true) as Element
  clone.querySelectorAll('[role="tooltip"]').forEach((t) => t.remove())
  return (clone.textContent || '').trim()
}

describe('SupervisorPage — compact icon-only toolbar', () => {
  test('icon-only toolbar buttons render no visible label text (tooltip text excluded)', async () => {
    await render()
    const expectedLabels = [
      'Update supervisor to the latest signed release',
      'Add installation',
      'Refresh repos',
      'Manage repo groups',
      'Group repos by your groups',
      'Launch selected',
      'All statuses',
      'Running',
      'Idle',
      'All types',
      'Repos',
      'Folders',
    ]
    for (const label of expectedLabels) {
      const el = host.querySelector(`[aria-label="${label}"]`)
      expect(el).not.toBeNull()
      expect(visibleButtonText(el as Element)).toBe('')
    }
  })

  test('machine and installation selects carry an aria-label instead of a text label', async () => {
    await render()
    expect(host.querySelector('[aria-label="Machine"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="GitHub installation"]')).not.toBeNull()
    expect(host.textContent).not.toContain('Machine:')
    expect(host.textContent).not.toContain('Install:')
  })

  test('search collapses to a tooltipped icon trigger with its own aria-label', async () => {
    await render()
    const trigger = host.querySelector('[aria-label="Search repos"]')
    expect(trigger).not.toBeNull()
  })

  test('status-filter "All" and type-filter "All" carry distinct aria-labels (no duplicate)', async () => {
    await render()
    expect(host.querySelector('[aria-label="All statuses"]')).not.toBeNull()
    expect(host.querySelector('[aria-label="All types"]')).not.toBeNull()
    expect(host.querySelectorAll('[aria-label="All"]').length).toBe(0)
  })
})

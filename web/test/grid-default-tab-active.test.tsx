/**
 * fix/ui-session-nav — "the grid view doesn't currently load sessions" (owner,
 * 2026-07-16).
 *
 * The grid's virtual Default tab computes membership from
 * `allSessions.filter(s => s.active)` (GridPage.tsx), while the sidebar / List
 * View filters on `status` — which is why List View kept working and ONLY the
 * grid went empty.
 *
 * `active` is DERIVED (not a `sessions` column). `GET /api/sessions` derives it;
 * the WS `session_list` broadcasts sent RAW DAL rows with no `active`. Since
 * `useSessions` REPLACES its whole list on every `session_list` frame — and the
 * hub pushes one immediately on client WS auth — the good REST rows were
 * clobbered within milliseconds by unenriched ones. Every `active` became
 * `undefined` → Default tab filtered to [] → "No active sessions".
 *
 * These tests render the REAL GridPage and drive it with the two payload
 * shapes. The `session_list without active` case is the pre-fix hub and is what
 * reproduced the empty grid; the enriched case is what the fixed hub
 * (hub/src/sessions/enrich.ts) now sends on BOTH the REST and WS paths.
 *
 * RUN PER FILE (`bun test web/test/grid-default-tab-active.test.tsx`). Bun's
 * `mock.module` is process-global, so a sibling file that mocks `lib/api` wins
 * whichever registers last and this file's REST stub stops applying — the same
 * pollution that makes the whole-`web/test` run red today, and exactly why
 * `tools/check-baseline.ts` spawns one process per test file.
 */
import { describe, test, expect, beforeEach, afterEach, afterAll, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

if (!(globalThis as any).document) GlobalRegistrator.register()
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// A session as the hub's REST route returns it (enriched: `active` present).
const REST_SESSION = {
  id: 'sess-1',
  name: 'remo-code',
  project_dir: 'C:/repo',
  status: 'online',
  active: true,
  last_activity: null,
  created_at: '2026-07-16T00:00:00Z',
  repo_key: 'github://o/remo-code',
  local_paths: [],
}

// The SAME row as the pre-fix WS `session_list` sent it: raw DAL output, so the
// derived `active` field simply does not exist.
const { active: _dropped, local_paths: _dropped2, ...WS_SESSION_UNENRICHED } = REST_SESSION

let wsHandlers: Array<(msg: any) => void> = []
const deliver = (msg: any) => { for (const h of [...wsHandlers]) h(msg) }

mock.module('../src/hooks/useWebSocket.ts', () => ({
  useWebSocketContext: () => ({
    connected: true,
    connectionId: 1,
    send: () => {},
    subscribe: (h: (msg: any) => void) => {
      wsHandlers.push(h)
      return () => { wsHandlers = wsHandlers.filter((x) => x !== h) }
    },
  }),
}))

// GridPage fetches /api/sessions (useSessions) and /api/client-config.
let restSessions: any[] = []
mock.module('../src/lib/api.ts', () => ({
  hubFetch: async (_t: any, path: string) => {
    if (path === '/api/sessions') return restSessions
    if (path === '/api/client-config') return { pty_interactive: false }
    return {}
  },
}))

// No user tabs — the Default tab is the surface under test.
mock.module('../src/lib/chat-tabs-api.ts', () => ({
  MAX_CELLS_PER_TAB: 12,
  DEFAULT_TAB_ID: '__default__',
  listTabs: async () => [],
  createTab: async () => ({}),
  patchTab: async () => ({}),
  deleteTab: async () => {},
  reorderTabs: async () => {},
  addSessionToTab: async () => ({}),
  removeSessionFromTab: async () => {},
  batchMessages: async () => ({}),
  getGridState: async () => ({ active_tab_id: null, active_session_id: null }),
  patchGridState: async () => ({}),
}))

// The cell surfaces own xterm / streaming and are not under test — stub them to
// a marker so we can count rendered cells.
mock.module('../src/components/ChatSurface.tsx', () => ({
  ChatSurface: ({ sessionId }: any) => <div data-testid="cell" data-session={sessionId} />,
}))
mock.module('../src/components/TerminalSurface.tsx', () => ({
  TerminalSurface: ({ sessionId }: any) => <div data-testid="cell" data-session={sessionId} />,
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { GridPage } = await import('../src/components/GridPage')

let container: HTMLDivElement
let root: any

async function renderGrid() {
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(<GridPage token="tok" />)
  })
  // Let the tab / grid-state fetches settle.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

const cellCount = () => container.querySelectorAll('[data-testid="cell"]').length
const gridLabel = () =>
  container.querySelector('[role="grid"]')?.getAttribute('aria-label') ?? null
const bodyText = () => container.textContent ?? ''

beforeEach(() => {
  wsHandlers = []
  restSessions = [REST_SESSION]
  window.location.hash = ''
})

afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
})

// Don't leak this file's module mocks into whatever runs next in-process.
afterAll(() => { mock.restore() })

describe('grid Default tab membership', () => {
  test('renders a cell for an active session from the REST payload', async () => {
    await renderGrid()
    expect(cellCount()).toBe(1)
    expect(gridLabel()).toBe('Session grid (1 of 1)')
  })

  test('REGRESSION: an unenriched session_list frame empties the grid', async () => {
    await renderGrid()
    expect(cellCount()).toBe(1) // populated from REST first…

    // …then the hub pushes its session_list (it does this immediately on client
    // WS auth). Pre-fix this frame carried raw DAL rows with no `active`.
    await act(async () => {
      deliver({ type: 'session_list', sessions: [WS_SESSION_UNENRICHED] })
    })

    // This is the exact reported bug: the session is still online and still in
    // the list, but the Default tab can no longer see it.
    expect(cellCount()).toBe(0)
    expect(bodyText()).toContain('No active sessions')
  })

  test('an ENRICHED session_list frame keeps the grid populated', async () => {
    await renderGrid()
    expect(cellCount()).toBe(1)

    // What the fixed hub sends on every session_list broadcast — same shape as
    // GET /api/sessions (hub/src/sessions/enrich.ts).
    await act(async () => {
      deliver({ type: 'session_list', sessions: [REST_SESSION] })
    })

    expect(cellCount()).toBe(1)
    expect(gridLabel()).toBe('Session grid (1 of 1)')
    expect(bodyText()).not.toContain('No active sessions')
  })

  test('active=false is respected — an offline session is not a Default-tab cell', async () => {
    await renderGrid()
    await act(async () => {
      deliver({
        type: 'session_list',
        sessions: [{ ...REST_SESSION, status: 'offline', active: false }],
      })
    })
    expect(cellCount()).toBe(0)
    expect(bodyText()).toContain('No active sessions')
  })
})

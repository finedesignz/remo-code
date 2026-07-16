/**
 * fix/ui-session-nav — `#/?session=<id>` must WIN over the orchestrator
 * auto-select.
 *
 * ChatLayout auto-selects the orchestrator (else the first connected session) on
 * initial load. The Play button navigates to `#/?session=<id>` for the session it
 * just started, which is usually NOT the orchestrator — so if auto-select won,
 * the user would land on the wrong session and the Play button would look broken.
 *
 * The param is read as the INITIAL state value (not in an effect) precisely so
 * it is already set before the auto-select effect first runs.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://localhost/' })

// React 19 requires this opt-in before act() will flush effects synchronously.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SESSIONS = [
  { id: 'orch-1', name: 'Orchestrator', status: 'online', is_orchestrator: true, project_dir: '/repo' },
  { id: 'sess-2', name: 'remo-code', status: 'online', is_orchestrator: false, project_dir: '/repo2' },
]

// Everything below is chrome ChatLayout renders; the unit under test is its
// session-selection logic, observed through the activeSessionId it hands down.
mock.module('../src/hooks/useWebSocket', () => ({
  useWebSocketContext: () => ({
    connected: true,
    connectionId: 'c1',
    send: () => {},
    subscribe: () => () => {},
    online: true,
  }),
}))
// Keep the module's other exports (githubOwnerRepo & co) real — sibling
// components import them; only the hook itself is stubbed.
const realUseSessions = await import('../src/hooks/useSessions')
mock.module('../src/hooks/useSessions', () => ({
  ...realUseSessions,
  useSessions: () => ({
    sessions: SESSIONS,
    updateSessionStatus: () => {},
    setSessions: () => {},
    deleteSession: () => {},
    disconnectSession: () => {},
    refetch: () => {},
    cloneHere: () => {},
    setSessionAutoNudge: () => {},
    setSessionSkipPermissions: () => {},
  }),
}))
// Stub only hubFetch (ChatLayout's /api/profile call — irrelevant here, and it
// spews ECONNREFUSED against happy-dom); the rest of the module stays real.
const realApi = await import('../src/lib/api')
mock.module('../src/lib/api', () => ({ ...realApi, hubFetch: async () => ({}) }))
mock.module('../src/hooks/useChat', () => ({
  useChat: () => ({ messages: [], loading: false, sendMessage: () => {}, unreadCounts: {} }),
}))
mock.module('../src/hooks/useActivity', () => ({ useActivity: () => ({}) }))
mock.module('../src/hooks/useClientConfig', () => ({ useClientConfig: () => ({ pty_interactive: false }) }))
mock.module('../src/components/Sidebar', () => ({
  Sidebar: ({ activeSessionId }: { activeSessionId: string | null }) => (
    <div data-testid="active-session">{activeSessionId ?? 'none'}</div>
  ),
}))
mock.module('../src/components/ChatPanel', () => ({ ChatPanel: () => <div /> }))
mock.module('../src/components/TerminalSurface', () => ({ TerminalSurface: () => <div /> }))
mock.module('../src/components/MobileSessionControls', () => ({ MobileSessionControls: () => <div /> }))

const { ChatLayout } = await import('../src/components/ChatLayout')
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

async function render() {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <ChatLayout
        token="t"
        user={{ id: 'u1', email: 'a@b.c' } as never}
        signOut={() => {}}
        onNavigate={() => {}}
      />,
    )
  })
}

const activeSession = () => container.querySelector('[data-testid="active-session"]')?.textContent

beforeEach(() => { window.location.hash = '' })
afterEach(async () => {
  await act(async () => { root?.unmount() })
  container?.remove()
})

describe('ChatLayout session hash param', () => {
  test('selects the session from the hash instead of the orchestrator', async () => {
    window.location.hash = '#/?session=sess-2'
    await render()
    expect(activeSession()).toBe('sess-2')
  })

  test('strips the param from the hash once consumed', async () => {
    window.location.hash = '#/?session=sess-2'
    await render()
    expect(window.location.hash).not.toContain('session=')
  })

  test('falls back to the orchestrator auto-select when no param is present', async () => {
    await render()
    expect(activeSession()).toBe('orch-1')
  })

  test('honors a later navigation to #/?session=<id> while mounted', async () => {
    await render()
    expect(activeSession()).toBe('orch-1')
    await act(async () => {
      window.location.hash = '#/?session=sess-2'
      window.dispatchEvent(new Event('hashchange'))
    })
    expect(activeSession()).toBe('sess-2')
  })
})

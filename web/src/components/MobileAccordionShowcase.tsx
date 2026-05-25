import { useWebSocket } from '../hooks/useWebSocket'
import { useSessions } from '../hooks/useSessions'
import { MobileAccordion } from './MobileAccordion'
import { connectedSessions } from './SessionDropdown'

/**
 * Dev-only visual harness for <MobileAccordion>.
 *
 * Gated behind hash route `#/dev/mobile-accordion` AND `import.meta.env.DEV`
 * so it does not appear in production navigation. (The route still exists
 * in prod builds for quick smoke testing, but is not advertised.)
 *
 * Pulls the user's first 5 connected sessions and renders them in the
 * accordion at a phone-ish width to verify expand/collapse behavior.
 */
export function MobileAccordionShowcase({ token }: { token: string }) {
  const { connected, connectionId, send, subscribe } = useWebSocket(token)
  const { sessions } = useSessions(token)
  const visible = connectedSessions(sessions).slice(0, 5)

  return (
    <div className="h-screen w-screen bg-[var(--bg-primary)] flex flex-col items-center overflow-hidden">
      <div className="w-full max-w-[420px] flex flex-col h-full border-x border-[var(--border-color)]">
        <div className="px-3 py-2 border-b border-[var(--border-color)] flex items-center justify-between shrink-0">
          <div>
            <div className="text-sm font-semibold text-[var(--text-primary)]">
              MobileAccordion (dev)
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">
              Connected: {connected ? 'yes' : 'no'} · {visible.length} sessions
            </div>
          </div>
          <a
            href="#/"
            className="text-xs text-indigo-300 hover:text-indigo-200"
          >
            ← back
          </a>
        </div>
        <div className="flex-1 min-h-0">
          <MobileAccordion
            sessions={visible}
            subscribe={subscribe}
            send={send}
            connectionId={connectionId}
            token={token}
            wsConnected={connected}
          />
        </div>
      </div>
    </div>
  )
}

import { useWebSocket } from '../hooks/useWebSocket'
import { ChatSurface } from './ChatSurface'

/**
 * Dev-only visual harness for the three <ChatSurface> density variants.
 *
 * Gated behind hash route `#/dev/chat-surface`. Not exported as a feature;
 * exists purely to eyeball density variants side-by-side during development.
 *
 * Production note: the showcase is reachable in production builds via the
 * hash route, but it requires a valid auth token and a hard-coded sessionId
 * that won't resolve to anything for a normal user. Removal can happen in
 * a later cleanup pass.
 */
export function ChatSurfaceShowcase({ token }: { token: string }) {
  const { connected, connectionId, send, subscribe } = useWebSocket(token)
  // Hard-coded fake sessionId — real session won't exist, surface will show
  // "No messages yet" but density styling is fully visible.
  const fakeId = 'showcase-fake-session-id'

  return (
    <div className="h-full overflow-auto bg-[var(--bg-primary)] p-6">
      <h1 className="text-lg font-semibold text-[var(--text-primary)] mb-4">
        ChatSurface density showcase
      </h1>
      <p className="text-xs text-[var(--text-muted)] mb-6">
        Dev-only visual harness. Real session data will not load.
        Connected: {connected ? 'yes' : 'no'}
      </p>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 h-[800px]">
        <div className="flex flex-col min-h-0">
          <div className="text-xs text-[var(--text-muted)] mb-1">density=&quot;full&quot;</div>
          <div className="flex-1 min-h-0 rounded-xl bg-[var(--bg-secondary)]/60 overflow-hidden flex flex-col">
            <ChatSurface
              density="full"
              sessionId={fakeId}
              subscribe={subscribe}
              send={send}
              connectionId={connectionId}
              token={token}
              wsConnected={connected}
            />
          </div>
        </div>

        <div className="flex flex-col min-h-0">
          <div className="text-xs text-[var(--text-muted)] mb-1">density=&quot;cell&quot;</div>
          <div className="flex-1 min-h-0">
            <ChatSurface
              density="cell"
              sessionId={fakeId}
              subscribe={subscribe}
              send={send}
              connectionId={connectionId}
              token={token}
              wsConnected={connected}
            />
          </div>
        </div>

        <div className="flex flex-col min-h-0">
          <div className="text-xs text-[var(--text-muted)] mb-1">density=&quot;mobile-expanded&quot;</div>
          <div className="flex-1 min-h-0">
            <ChatSurface
              density="mobile-expanded"
              sessionId={fakeId}
              subscribe={subscribe}
              send={send}
              connectionId={connectionId}
              token={token}
              wsConnected={connected}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

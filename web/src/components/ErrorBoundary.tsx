/**
 * Minimal React error boundary that reports thrown errors to the hub via
 * `reportError`. NOTE: this app already has the richer `AppErrorBoundary`
 * mounted at the root (`web/src/main.tsx`) — that boundary owns the visual
 * fallback. This component exists as a lightweight, reporter-only sibling
 * suitable for wrapping subtrees that want a plain fallback + auto-report.
 *
 * Per Bundle B3 scope: wrap App in a boundary that reports + renders a
 * friendly fallback with a Reload button. We achieve that by also calling
 * `reportError` from `AppErrorBoundary.componentDidCatch` — see main.tsx.
 * This component is here for any subtree that wants the simpler behavior.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'
import { reportError } from '../lib/error-reporter'

interface Props { children: ReactNode }
interface State { error: Error | null }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    void reportError({
      message: error.message || String(error),
      stack: (error.stack ?? '') + (info?.componentStack ? `\nComponent stack:${info.componentStack}` : ''),
    })
  }

  private handleReload = () => { try { window.location.reload() } catch {} }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-primary)] px-4 py-8">
        <div className="w-full max-w-md bg-[var(--bg-secondary)]/60 rounded-xl p-6 space-y-4">
          <h1 className="text-base font-semibold">Something went wrong.</h1>
          <p className="text-xs text-[var(--text-muted)]">We've been notified.</p>
          <button
            type="button"
            onClick={this.handleReload}
            className="px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-[var(--text-on-accent)] text-sm font-medium"
          >
            Reload
          </button>
        </div>
      </div>
    )
  }
}

export default ErrorBoundary

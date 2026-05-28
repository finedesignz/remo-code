/**
 * Top-level error boundary. Catches anything thrown during render or in
 * lifecycle methods of the App tree (useAuth bootstrap, useProfile fetch,
 * WebSocketProvider, NotificationsBridge, every route component).
 *
 * Without this boundary a throw above the per-route ErrorBoundary (PR #117)
 * produces a fully blank page with nothing in the console UI — visible only
 * in DevTools. This wrapper renders a styled panel with the error, a stack
 * trace, and three recovery actions so the user is never stranded on white.
 *
 * Plain React class component — no `react-error-boundary` dep, no new deps.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react'

const HUB_URL = import.meta.env.VITE_HUB_URL || ''
const IS_DEV = !!(import.meta as any).env?.DEV

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  errorInfo: ErrorInfo | null
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Greppable prefix for log scraping.
    // eslint-disable-next-line no-console
    console.error('[remo-error-boundary]', error, errorInfo?.componentStack)
    this.setState({ errorInfo })
  }

  private handleReload = () => {
    try { window.location.reload() } catch {}
  }

  private handleSignOutAndReload = async () => {
    // Best-effort server-side logout. Endpoint is /api/auth/logout (POST) per
    // hub/src/api/auth.ts — fall through to cookie purge + reload on any failure.
    try {
      await fetch(`${HUB_URL}/api/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      })
    } catch { /* ignore */ }
    // Defensive: nuke non-HttpOnly cookies + localStorage auth fallback so a
    // bad cached state on the next load can't reproduce the same throw.
    try {
      for (const part of (document.cookie || '').split(';')) {
        const name = part.split('=')[0]?.trim()
        if (name) {
          document.cookie = `${name}=; Max-Age=0; path=/`
          document.cookie = `${name}=; Max-Age=0; path=/; domain=${location.hostname}`
        }
      }
    } catch {}
    try {
      localStorage.removeItem('remo_token')
      localStorage.removeItem('remo_user')
    } catch {}
    try { window.location.hash = '#/login' } catch {}
    try { window.location.reload() } catch {}
  }

  private handleCopyDiagnostic = () => {
    const { error, errorInfo } = this.state
    const payload = [
      `Remo Code error diagnostic`,
      `URL: ${typeof location !== 'undefined' ? location.href : '(no location)'}`,
      `UA: ${typeof navigator !== 'undefined' ? navigator.userAgent : '(no navigator)'}`,
      `Time: ${new Date().toISOString()}`,
      ``,
      `Message: ${error?.message ?? '(no message)'}`,
      ``,
      `Stack:`,
      error?.stack ?? '(no stack)',
      ``,
      `Component stack:`,
      errorInfo?.componentStack ?? '(no component stack)',
    ].join('\n')
    try {
      void navigator.clipboard?.writeText(payload)
    } catch { /* ignore */ }
  }

  render() {
    const { error, errorInfo } = this.state
    if (!error) return this.props.children

    return (
      <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)] text-[var(--text-primary)] px-4 py-8">
        <div className="w-full max-w-xl bg-[var(--bg-secondary)]/60 rounded-xl p-6 space-y-4">
          <div>
            <h1 className="text-base font-semibold">Something broke loading the app</h1>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              Remo Code hit an unrecoverable error in the UI shell. Your work is safe —
              this is purely a client-side render problem. Try reloading first; if that
              doesn't help, sign out and back in.
            </p>
          </div>

          <div className="rounded-lg bg-[var(--bg-tertiary)]/60 px-3 py-2 text-xs font-mono break-words text-red-300">
            {error.message || String(error)}
          </div>

          <details className="text-xs text-[var(--text-muted)]" open={IS_DEV}>
            <summary className="cursor-pointer hover:text-[var(--text-secondary)] select-none">
              Stack trace
            </summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-[var(--bg-tertiary)]/40 p-3 text-[11px] font-mono">
{error.stack || '(no stack available)'}
{errorInfo?.componentStack ? `\n\nComponent stack:${errorInfo.componentStack}` : ''}
            </pre>
          </details>

          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={this.handleReload}
              className="px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-[var(--text-on-accent)] text-sm font-medium transition-colors"
            >
              Reload
            </button>
            <button
              type="button"
              onClick={this.handleSignOutAndReload}
              className="px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)]/70 text-[var(--text-primary)] text-sm font-medium transition-colors"
            >
              Sign out + reload
            </button>
            <button
              type="button"
              onClick={this.handleCopyDiagnostic}
              className="px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--bg-tertiary)]/70 text-[var(--text-primary)] text-sm font-medium transition-colors"
            >
              Copy diagnostic
            </button>
          </div>
        </div>
      </div>
    )
  }
}

export default AppErrorBoundary

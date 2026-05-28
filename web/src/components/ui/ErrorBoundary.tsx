import { Component, type ErrorInfo, type ReactNode } from "react";
import { EmptyState } from "./EmptyState";

export interface ErrorBoundaryProps {
  children: ReactNode;
  tabKey?: string;
  onError?: (err: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * ErrorBoundary — catches render/lifecycle errors in its subtree and renders a
 * fallback EmptyState instead of blanking the entire page. Each Settings/Tasks/
 * Home tab gets its own boundary so one tab's crash does not bring down the
 * rest. Logs to console.error with the tabKey for diagnostic capture.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Diagnostic surface — Playwright + manual repros capture this.
    // eslint-disable-next-line no-console
    console.error("[ErrorBoundary]", this.props.tabKey ?? "(unknown)", error, info);
    this.props.onError?.(error, info);
  }

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      const msg = this.state.error.message || String(this.state.error);
      return (
        <EmptyState
          title="Couldn't load tab"
          description={
            <span>
              {this.props.tabKey ? (
                <>
                  <span className="font-mono text-[var(--text-secondary)]">{this.props.tabKey}</span>:{" "}
                </>
              ) : null}
              {msg}
            </span>
          }
          action={{ label: "Reload", onClick: this.handleReload }}
        />
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;

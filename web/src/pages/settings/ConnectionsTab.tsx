/**
 * Settings → Connections tab.
 *
 * Composes:
 *   1. SupervisorPage embedded — supervisor selection, repo list (with the
 *      pinned orchestrator row; expand that row for its per-session Auto-Dev
 *      timeline). Root-folder setup moved to the supervisor first-run wizard
 *      (Phase 09); roots are no longer edited in the web UI.
 *   2. A collapsible hub-wide "Auto-Dev Activity" feed (all sessions) — the
 *      orchestrator run-log surface lives here, NOT as a separate Settings tab
 *      (the four-tab invariant is enforced).
 */
import { useState } from "react";
import { SupervisorPage } from "../../components/SupervisorPage";
import { AutoDevActivityPanel } from "../../components/AutoDevActivityPanel";

interface Props {
  token: string;
}

export function ConnectionsTab({ token }: Props) {
  const [showFeed, setShowFeed] = useState(false);

  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto space-y-5">
      <SupervisorPage token={token} embedded />

      <section>
        <button
          type="button"
          className="flex items-center gap-2 text-sm font-medium text-[var(--text-secondary)] hover:text-blue-400"
          aria-expanded={showFeed}
          onClick={() => setShowFeed((x) => !x)}
        >
          <span className="text-[var(--text-muted)]">{showFeed ? "▾" : "▸"}</span>
          Auto-Dev Activity
          <span className="text-[11px] text-[var(--text-muted)]">all sessions</span>
        </button>

        {showFeed && (
          <div className="mt-3">
            <AutoDevActivityPanel token={token} />
          </div>
        )}
      </section>
    </div>
  );
}

export default ConnectionsTab;

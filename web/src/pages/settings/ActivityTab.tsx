/**
 * web/src/pages/settings/ActivityTab.tsx
 * OBSRV-02 / RUNLOG-04 — Hub-wide orchestrator run feed (Settings > Activity tab).
 *
 * Renders the AutoDevActivityPanel in hub-wide mode (no sessionId) so the user
 * sees runs across ALL their sessions, each row labeled with its repo.
 *
 * Accent = blue only; orange is CTA-only. No purple-adjacent hues.
 */
import { AutoDevActivityPanel } from '../../components/AutoDevActivityPanel';

interface ActivityTabProps {
  token: string | null;
}

export function ActivityTab({ token }: ActivityTabProps) {
  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Auto-Dev Activity
        </h2>
        <p className="mt-1 text-sm text-[var(--text-muted)]">
          Orchestrator run history across all your sessions. Each row shows the
          repo, command issued, and outcome — expand for full rationale and
          deploy-verify detail.
        </p>
      </div>

      <AutoDevActivityPanel token={token} />
    </div>
  );
}

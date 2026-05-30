/**
 * Settings → Connections tab.
 *
 * Composes:
 *   1. SupervisorPage embedded — supervisor selection, repo list (with the
 *      pinned orchestrator row), scan. Root-folder setup moved to the supervisor
 *      first-run wizard (Phase 09); roots are no longer edited in the web UI.
 *   2. RevanoteLink — surface the Revanote section under Connections (audit fold).
 */
import { Card, InfoTip } from "../../components/ui";
import { SupervisorPage } from "../../components/SupervisorPage";

interface Props {
  token: string;
}

export function ConnectionsTab({ token }: Props) {
  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto space-y-5">
      <SupervisorPage token={token} embedded />
      <RevanoteLink />
    </div>
  );
}

/* ─────────────────────────── Revanote link ─────────────────────────── */

function RevanoteLink() {
  return (
    <Card>
      <div className="flex items-center gap-1.5">
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">Revanote</h3>
        <InfoTip content="Visual annotations route into the Claude session bound to each page's repo via the Revanote webhook. Rotate the webhook secret and manage app mappings from the hub API — no separate page to open." />
      </div>
    </Card>
  );
}

export default ConnectionsTab;

/**
 * Settings → Connections tab.
 *
 * Composes:
 *   1. SupervisorPage embedded — supervisor selection, repo list (with the
 *      pinned orchestrator row), scan. Root-folder setup moved to the supervisor
 *      first-run wizard (Phase 09); roots are no longer edited in the web UI.
 */
import { SupervisorPage } from "../../components/SupervisorPage";

interface Props {
  token: string;
}

export function ConnectionsTab({ token }: Props) {
  return (
    <div className="px-4 md:px-6 lg:px-8 py-5 w-full max-w-7xl mx-auto space-y-5">
      <SupervisorPage token={token} embedded />
    </div>
  );
}

export default ConnectionsTab;

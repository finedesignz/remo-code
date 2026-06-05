/**
 * Parked Activity route (`#/activity`).
 *
 * The Tasks page collapsed to a single page and dropped its sub-tabs. Activity
 * is NOT deleted — it is parked here standalone (the `GET /api/tasks/activity`
 * endpoint + `ActivityTab` component are unchanged). This is the seed for a
 * future GLOBAL activity log (all activity, not just scheduled-task runs); the
 * data source will widen later. Do not delete.
 *
 * `#/tasks?tab=activity` redirects here for back-compat (see TasksPage).
 */
import type { AuthUser } from "../lib/auth";
import { AppShell } from "../components/ui/AppShell";
import { Brand } from "../components/ui/Brand";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { HeaderRight } from "../components/ui/HeaderRight";
import { useWebSocketContext } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav } from "../lib/ui/nav";
import { ActivityTab } from "./tasks/ActivityTab";

interface Props {
  token: string;
  user: AuthUser;
  signOut: () => void;
  onNavigate: (hash: string) => void;
}

export function ActivityPage({ token, user, signOut, onNavigate }: Props) {
  const { subscribe } = useWebSocketContext();
  // Not a top-level nav target yet — Activity is parked pending the global
  // activity-log repurpose. Nav highlights none of Home/Tasks/Settings.
  const nav = buildTopNav(activeTopRoute());

  return (
    <AppShell
      brand={<Brand />}
      nav={nav}
      headerRight={<HeaderRight token={token} user={user} signOut={signOut} onNavigate={onNavigate} subscribe={subscribe} />}
    >
      <div className="px-4 md:px-6 py-6 space-y-4">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Activity</h1>
          <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-600/20 text-blue-300 ring-1 ring-blue-500/30">
            Moving soon — becoming a global activity log
          </span>
          <a href="#/tasks" className="text-xs text-blue-400 hover:text-blue-300 underline ml-auto">
            ← Back to Tasks
          </a>
        </div>
        <ErrorBoundary tabKey="activity">
          <ActivityTab token={token} />
        </ErrorBoundary>
      </div>
    </AppShell>
  );
}

export default ActivityPage;

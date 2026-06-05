/**
 * Tasks page — SINGLE page (no sub-tabs).
 *
 * The old Upcoming | Activity | Schedule sub-tab structure is collapsed:
 *   - The page body is the grouped task CRUD list (formerly the Schedule tab).
 *   - "Upcoming" folds into a "Next run" sort + an "Upcoming" filter on the
 *     toolbar (the backend `GET /api/tasks/upcoming` endpoint is preserved).
 *   - "Activity" is NOT deleted — it is parked at the standalone `#/activity`
 *     route (seed for a future global activity log). `#/tasks?tab=activity`
 *     redirects there; a small "moving soon" note sits where the sub-tab was.
 *
 * Because Tasks no longer has sub-tabs, `buildTopNav` is called WITHOUT a
 * `subTabs` config, so the PR #252 mobile top-bar dropdown collapses to a
 * single nav target.
 */
import { useEffect } from "react";
import type { AuthUser } from "../lib/auth";
import { AppShell } from "../components/ui/AppShell";
import { Brand } from "../components/ui/Brand";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { HeaderRight } from "../components/ui/HeaderRight";
import { useWebSocketContext } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav, readTabParam } from "../lib/ui/nav";
import { ScheduleTab } from "./tasks/ScheduleTab";

interface Props {
  token: string;
  user: AuthUser;
  signOut: () => void;
  onNavigate: (hash: string) => void;
}

export function TasksPage({ token, user, signOut, onNavigate }: Props) {
  // REVIEW BL-01: shared WS from context.
  const { subscribe } = useWebSocketContext();

  // Back-compat for legacy `?tab=` deep links. `activity` is the only one with
  // its own home (the parked route); the rest just strip the param.
  useEffect(() => {
    const reconcile = () => {
      const t = readTabParam();
      if (!t) return;
      if (t === "activity") {
        window.location.hash = "#/activity";
        return;
      }
      // upcoming | schedule | anything else → canonical single Tasks page.
      const hash = window.location.hash || "#/tasks";
      const path = hash.split("?")[0];
      window.history.replaceState(
        null,
        "",
        window.location.pathname + window.location.search + path,
      );
    };
    reconcile();
    window.addEventListener("hashchange", reconcile);
    return () => window.removeEventListener("hashchange", reconcile);
  }, []);

  const nav = buildTopNav(activeTopRoute());

  return (
    <AppShell
      brand={<Brand />}
      nav={nav}
      headerRight={<HeaderRight token={token} user={user} signOut={signOut} onNavigate={onNavigate} subscribe={subscribe} />}
    >
      <div className="px-4 md:px-6 py-6">
        <ErrorBoundary tabKey="tasks:list">
          <ScheduleTab token={token} subscribe={subscribe} />
        </ErrorBoundary>
      </div>
    </AppShell>
  );
}

export default TasksPage;

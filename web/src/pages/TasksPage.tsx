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
import { useEffect, useState } from "react";
import type { AuthUser } from "../lib/auth";
import { AppShell } from "../components/ui/AppShell";
import { Brand } from "../components/ui/Brand";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { HeaderRight } from "../components/ui/HeaderRight";
import { useWebSocketContext } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav, readTabParam } from "../lib/ui/nav";
import { ScheduleTab } from "./tasks/ScheduleTab";
import { OrchestratorTab } from "./tasks/OrchestratorTab";

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

  // In-page view switch (keeps the single top-nav target — no sub-tabs). The
  // orchestrator editor (Phase 31) is a per-session config surface that lives
  // alongside the scheduled-task list.
  const [view, setView] = useState<"schedules" | "orchestrator">("schedules");

  return (
    <AppShell
      brand={<Brand />}
      nav={nav}
      headerRight={<HeaderRight token={token} user={user} signOut={signOut} onNavigate={onNavigate} subscribe={subscribe} />}
    >
      <div className="px-4 md:px-6 py-6 space-y-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setView("schedules")}
            className={
              view === "schedules"
                ? "px-3 py-1.5 rounded-lg text-sm bg-blue-600/20 text-blue-300"
                : "px-3 py-1.5 rounded-lg text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }
          >
            Scheduled tasks
          </button>
          <button
            type="button"
            onClick={() => setView("orchestrator")}
            className={
              view === "orchestrator"
                ? "px-3 py-1.5 rounded-lg text-sm bg-blue-600/20 text-blue-300"
                : "px-3 py-1.5 rounded-lg text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }
          >
            Orchestrator
          </button>
        </div>
        {view === "schedules" ? (
          <ErrorBoundary tabKey="tasks:list">
            <ScheduleTab token={token} subscribe={subscribe} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary tabKey="tasks:orchestrator">
            <OrchestratorTab token={token} />
          </ErrorBoundary>
        )}
      </div>
    </AppShell>
  );
}

export default TasksPage;

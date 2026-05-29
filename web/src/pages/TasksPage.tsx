/**
 * Phase 12 W3 — Tasks page shell.
 *
 * Three tabs: Upcoming (default) | Activity | Schedule. Each tab fetches its
 * Wave-2 endpoint lazily on view. Rendering is minimal (count + empty state)
 * — full list UIs land in Wave 4.
 */
import { useEffect, useState } from "react";
import type { AuthUser } from "../lib/auth";
import { AppShell } from "../components/ui/AppShell";
import { Brand } from "../components/ui/Brand";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { HeaderRight } from "../components/ui/HeaderRight";
import { useWebSocketContext } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav, readTabParam, writeTabParam } from "../lib/ui/nav";
import { UpcomingTab } from "./tasks/UpcomingTab";
import { ActivityTab } from "./tasks/ActivityTab";
import { ScheduleTab } from "./tasks/ScheduleTab";

type TasksTab = "upcoming" | "activity" | "schedule";

function readTasksTab(): TasksTab {
  const raw = readTabParam();
  if (raw === "activity" || raw === "schedule") return raw;
  return "upcoming";
}

interface Props {
  token: string;
  user: AuthUser;
  signOut: () => void;
  onNavigate: (hash: string) => void;
}

export function TasksPage({ token, user, signOut, onNavigate }: Props) {
  const [tab, setTab] = useState<TasksTab>(readTasksTab);
  // REVIEW BL-01: shared WS from context.
  const { subscribe } = useWebSocketContext();

  useEffect(() => {
    const onHash = () => setTab(readTasksTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const handleTabChange = (next: string) => {
    const t = (next === "activity" || next === "schedule" ? next : "upcoming") as TasksTab;
    setTab(t);
    writeTabParam(t);
  };

  const nav = buildTopNav(activeTopRoute(), {
    route: "tasks",
    subTabs: [
      { key: "upcoming", label: "Upcoming" },
      { key: "activity", label: "Activity" },
      { key: "schedule", label: "Schedule" },
    ],
    activeSubTab: tab,
    onSubTabChange: handleTabChange,
  });

  return (
    <AppShell
      brand={<Brand />}
      nav={nav}
      headerRight={<HeaderRight token={token} user={user} signOut={signOut} onNavigate={onNavigate} subscribe={subscribe} />}
    >
      <div className="px-4 md:px-6 py-6">
        {tab === "upcoming" && (
          <ErrorBoundary tabKey="tasks:upcoming">
            <UpcomingTab token={token} subscribe={subscribe} />
          </ErrorBoundary>
        )}
        {tab === "activity" && (
          <ErrorBoundary tabKey="tasks:activity">
            <ActivityTab token={token} />
          </ErrorBoundary>
        )}
        {tab === "schedule" && (
          <ErrorBoundary tabKey="tasks:schedule">
            <ScheduleTab token={token} subscribe={subscribe} />
          </ErrorBoundary>
        )}
      </div>
    </AppShell>
  );
}

export default TasksPage;

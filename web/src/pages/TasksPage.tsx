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
import { Tabs } from "../components/ui/Tabs";
import { HeaderRight } from "../components/ui/HeaderRight";
import { useWebSocket } from "../hooks/useWebSocket";
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
  const { subscribe } = useWebSocket(token);

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

  const nav = buildTopNav(activeTopRoute());
  const brand = (
    <a href="#/" className="text-sm font-semibold text-[var(--text-primary)] hover:text-indigo-300 transition-colors">
      Remo Code
    </a>
  );

  return (
    <AppShell
      brand={brand}
      nav={nav}
      headerRight={<HeaderRight token={token} user={user} signOut={signOut} onNavigate={onNavigate} subscribe={subscribe} />}
    >
      <div className="px-4 md:px-6 pt-3">
        <Tabs
          tabs={[
            { key: "upcoming", label: "Upcoming" },
            { key: "activity", label: "Activity" },
            { key: "schedule", label: "Schedule" },
          ]}
          activeKey={tab}
          onChange={handleTabChange}
          renderContent={false}
        />
      </div>
      <div className="px-4 md:px-6 py-6">
        {tab === "upcoming" && <UpcomingTab token={token} subscribe={subscribe} />}
        {tab === "activity" && <ActivityTab token={token} />}
        {tab === "schedule" && <ScheduleTab token={token} subscribe={subscribe} />}
      </div>
    </AppShell>
  );
}

export default TasksPage;

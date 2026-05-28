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
import { EmptyState } from "../components/ui/EmptyState";
import { LoadingState } from "../components/ui/LoadingState";
import { useWebSocket } from "../hooks/useWebSocket";
import { hubFetch } from "../lib/api";
import { activeTopRoute, buildTopNav, readTabParam, writeTabParam } from "../lib/ui/nav";

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
        {tab === "upcoming" && <UpcomingPlaceholder token={token} />}
        {tab === "activity" && <ActivityPlaceholder token={token} />}
        {tab === "schedule" && <SchedulePlaceholder token={token} />}
      </div>
    </AppShell>
  );
}

function UpcomingPlaceholder({ token }: { token: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    hubFetch<{ items?: unknown[] }>(token, "/api/tasks/upcoming")
      .then((r) => { if (!cancelled) setCount(Array.isArray(r?.items) ? r.items.length : 0); })
      .catch((e) => { if (!cancelled) setErr(e?.message ?? "Failed to load"); });
    return () => { cancelled = true; };
  }, [token]);
  if (err) return <EmptyState title="Couldn't load upcoming tasks" description={err} />;
  if (count === null) return <LoadingState label="Loading upcoming tasks…" />;
  if (count === 0) return <EmptyState title="No upcoming runs in the next 24 hours" description="Scheduled tasks with a next-fire-at inside the next day will appear here." />;
  return <div className="text-sm text-[var(--text-secondary)]">{count} upcoming run{count === 1 ? "" : "s"}. (List UI lands in Wave 4.)</div>;
}

function ActivityPlaceholder({ token }: { token: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    hubFetch<{ items?: unknown[] }>(token, "/api/tasks/activity")
      .then((r) => { if (!cancelled) setCount(Array.isArray(r?.items) ? r.items.length : 0); })
      .catch((e) => { if (!cancelled) setErr(e?.message ?? "Failed to load"); });
    return () => { cancelled = true; };
  }, [token]);
  if (err) return <EmptyState title="Couldn't load activity feed" description={err} />;
  if (count === null) return <LoadingState label="Loading activity…" />;
  if (count === 0) return <EmptyState title="No activity yet" description="Recent scheduled-task and error-capture runs across all your tasks will show up here." />;
  return <div className="text-sm text-[var(--text-secondary)]">{count} recent run{count === 1 ? "" : "s"}. (Feed UI lands in Wave 4.)</div>;
}

function SchedulePlaceholder({ token }: { token: string }) {
  const [count, setCount] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    hubFetch<{ groups?: unknown[] }>(token, "/api/tasks/schedule?group_by=repo")
      .then((r) => { if (!cancelled) setCount(Array.isArray(r?.groups) ? r.groups.length : 0); })
      .catch((e) => { if (!cancelled) setErr(e?.message ?? "Failed to load"); });
    return () => { cancelled = true; };
  }, [token]);
  if (err) return <EmptyState title="Couldn't load schedule" description={err} />;
  if (count === null) return <LoadingState label="Loading schedule…" />;
  if (count === 0) return <EmptyState title="No scheduled tasks" description="Create your first scheduled task from any chat session — it will be grouped here by repo." />;
  return <div className="text-sm text-[var(--text-secondary)]">{count} repo group{count === 1 ? "" : "s"}. (Grouped list UI lands in Wave 4.)</div>;
}

export default TasksPage;

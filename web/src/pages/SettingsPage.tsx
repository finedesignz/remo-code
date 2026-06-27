/**
 * Phase 12 W4b — Settings page shell wired to dedicated tab modules.
 *
 * Wave 3 mounted this shell with `<SettingsPageLegacy initialTab=...>` as a
 * placeholder for each of the five tabs. Wave 4b replaces those placeholders
 * with first-class tab modules under ./settings/*.
 *
 * SettingsPageLegacy stays on disk (unimported here) until Wave 5 deletes it
 * — keep that detail surgical so other in-flight branches that still import
 * it don't break.
 */
import { useEffect, useState } from "react";
import type { AuthUser } from "../lib/auth";
import type { Profile } from "../hooks/useProfile";
import { AppShell } from "../components/ui/AppShell";
import { Brand } from "../components/ui/Brand";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { HeaderRight } from "../components/ui/HeaderRight";
import { useWebSocketContext } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav, readTabParam, writeTabParam } from "../lib/ui/nav";

import { ConnectionsTab } from "./settings/ConnectionsTab";
import { CredentialsTab } from "./settings/CredentialsTab";
import { UsageTab } from "./settings/UsageTab";
import { ProfileTab } from "./settings/ProfileTab";

type SettingsTab = "connections" | "credentials" | "usage" | "profile";

function readSettingsTab(): SettingsTab {
  const raw = readTabParam();
  if (
    raw === "connections" || raw === "credentials" ||
    raw === "usage" || raw === "profile"
  ) {
    return raw;
  }
  // Legacy `?tab=orchestrator` (Phase 09) and `?tab=prompts` (Phase 10 — Prompts
  // tab removed; auto-nudge moved to per-session row toggles, instruction files
  // handled locally) and any unknown tab → Connections.
  return "connections";
}

interface Props {
  token: string;
  user: AuthUser;
  profile: Profile;
  signOut: () => void;
  onNavigate: (hash: string) => void;
  onUpdateProfile: (data: {
    display_name?: string;
    avatar_url?: string | null;
    system_prompt?: string | null;
    daily_cost_cap_usd?: number;
    web_push_enabled?: boolean;
    timezone?: string;
  }) => Promise<any>;
}

export function SettingsPage({ token, user, profile, signOut, onNavigate, onUpdateProfile }: Props) {
  const [tab, setTab] = useState<SettingsTab>(readSettingsTab);
  // REVIEW BL-01: shared WS from context.
  const { subscribe } = useWebSocketContext();

  useEffect(() => {
    const onHash = () => setTab(readSettingsTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const handleTabChange = (next: string) => {
    const t = (["connections", "credentials", "usage", "profile"].includes(next)
      ? next
      : "connections") as SettingsTab;
    setTab(t);
    writeTabParam(t);
  };

  const nav = buildTopNav(activeTopRoute(), {
    route: "settings",
    subTabs: [
      { key: "connections", label: "Connections" },
      { key: "credentials", label: "Credentials" },
      { key: "usage", label: "Usage" },
      { key: "profile", label: "Profile" },
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
      <div className="flex-1 min-h-0 overflow-y-auto">
        {tab === "connections" && (
          <ErrorBoundary tabKey="settings:connections">
            <ConnectionsTab token={token} />
          </ErrorBoundary>
        )}
        {tab === "credentials" && (
          <ErrorBoundary tabKey="settings:credentials">
            <CredentialsTab token={token} />
          </ErrorBoundary>
        )}
        {tab === "usage" && (
          <ErrorBoundary tabKey="settings:usage">
            <UsageTab token={token} profile={profile} onUpdateProfile={onUpdateProfile} subscribe={subscribe} />
          </ErrorBoundary>
        )}
        {tab === "profile" && (
          <ErrorBoundary tabKey="settings:profile">
            <ProfileTab token={token} profile={profile} onUpdateProfile={onUpdateProfile} />
          </ErrorBoundary>
        )}
      </div>
    </AppShell>
  );
}

export default SettingsPage;

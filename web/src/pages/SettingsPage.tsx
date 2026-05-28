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
import { Tabs } from "../components/ui/Tabs";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { HeaderRight } from "../components/ui/HeaderRight";
import { useWebSocketContext } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav, readTabParam, writeTabParam } from "../lib/ui/nav";

import { ConnectionsTab } from "./settings/ConnectionsTab";
import { CredentialsTab } from "./settings/CredentialsTab";
import { PromptsTab } from "./settings/PromptsTab";
import { UsageTab } from "./settings/UsageTab";
import { ProfileTab } from "./settings/ProfileTab";

type SettingsTab = "connections" | "credentials" | "prompts" | "usage" | "profile";

function readSettingsTab(): SettingsTab {
  const raw = readTabParam();
  if (raw === "connections" || raw === "credentials" || raw === "prompts" || raw === "usage" || raw === "profile") {
    return raw;
  }
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
    const t = (["connections", "credentials", "prompts", "usage", "profile"].includes(next)
      ? next
      : "connections") as SettingsTab;
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
            { key: "connections", label: "Connections" },
            { key: "credentials", label: "Credentials" },
            { key: "prompts", label: "Prompts" },
            { key: "usage", label: "Usage" },
            { key: "profile", label: "Profile" },
          ]}
          activeKey={tab}
          onChange={handleTabChange}
          renderContent={false}
        />
      </div>
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
        {tab === "prompts" && (
          <ErrorBoundary tabKey="settings:prompts">
            <PromptsTab token={token} />
          </ErrorBoundary>
        )}
        {tab === "usage" && (
          <ErrorBoundary tabKey="settings:usage">
            <UsageTab token={token} profile={profile} onUpdateProfile={onUpdateProfile} />
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

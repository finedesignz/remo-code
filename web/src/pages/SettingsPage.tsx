/**
 * Phase 12 W3 — Settings page shell.
 *
 * Replaces the 1242-LOC SettingsPage god-component as the routed surface, but
 * each new tab still renders the legacy SettingsPage internally (with the
 * corresponding legacy tab pre-selected) so users see their existing settings
 * content unchanged. Wave 4/5 fragments each tab into its own module.
 *
 * Tab → legacy tab mapping (best-effort; Wave 4 refines):
 *   connections → supervisor
 *   credentials → apikey
 *   prompts     → instructions
 *   usage       → profile (no dedicated legacy tab yet)
 *   profile     → profile
 */
import { useEffect, useState } from "react";
import type { AuthUser } from "../lib/auth";
import type { Profile } from "../hooks/useProfile";
import { AppShell } from "../components/ui/AppShell";
import { Tabs } from "../components/ui/Tabs";
import { HeaderRight } from "../components/ui/HeaderRight";
import { SettingsPageLegacy } from "./SettingsPageLegacy";
import { useWebSocket } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav, readTabParam, writeTabParam } from "../lib/ui/nav";

type SettingsTab = "connections" | "credentials" | "prompts" | "usage" | "profile";

const LEGACY_TAB_FOR: Record<SettingsTab, string> = {
  connections: "supervisor",
  credentials: "apikey",
  prompts: "instructions",
  usage: "profile",
  profile: "profile",
};

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
  const { subscribe } = useWebSocket(token);

  useEffect(() => {
    const onHash = () => setTab(readSettingsTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // Whenever the new tab changes, sync the legacy tab into the hash so the
  // SettingsPageLegacy `readTabFromHash` picks it up. We re-encode the hash
  // with BOTH the new `tab` and the legacy mapping under a separate query
  // param `legacy_tab` so we don't clobber the canonical `tab=` value.
  useEffect(() => {
    // The legacy component reads `tab=` directly. To avoid a hash war while
    // the legacy view is still mounted, we briefly swap the hash to the
    // legacy tab name on mount — but only when the user opens a tab that
    // maps to a different legacy name. SettingsPageLegacy parses this on
    // its own hashchange listener.
    //
    // Implementation: stash the canonical new tab in `legacy_tab`, then
    // write `tab=<legacy>` for the legacy renderer to consume.
    const legacy = LEGACY_TAB_FOR[tab];
    const hash = window.location.hash || "#/settings";
    const [path, query] = hash.split("?");
    const params = new URLSearchParams(query || "");
    // Only rewrite when needed (prevents an infinite hashchange loop).
    if (params.get("tab") !== legacy || params.get("ui_tab") !== tab) {
      params.set("tab", legacy);
      params.set("ui_tab", tab);
      const next = `${path}?${params.toString()}`;
      window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
    }
  }, [tab]);

  const handleTabChange = (next: string) => {
    const t = (["connections", "credentials", "prompts", "usage", "profile"].includes(next) ? next : "connections") as SettingsTab;
    setTab(t);
    writeTabParam(t, "ui_tab");
    // Also flip the legacy `tab=` so SettingsPageLegacy re-renders the right body.
    writeTabParam(LEGACY_TAB_FOR[t], "tab");
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
        {/*
          Render the legacy component verbatim. It reads `tab=` from the hash
          itself, so the effect above is what swaps which legacy panel is
          visible. Wave 4 replaces each block with the new tab module.
        */}
        <SettingsPageLegacy
          token={token}
          profile={profile}
          onUpdateProfile={onUpdateProfile}
          onBack={() => onNavigate("#/")}
        />
      </div>
    </AppShell>
  );
}

export default SettingsPage;

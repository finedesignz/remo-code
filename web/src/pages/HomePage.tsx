/**
 * Phase 12 W3 — Home page shell.
 *
 * Wraps the existing chat experience (Layout) and grid experience (GridPage)
 * under a single `<AppShell>` + `<Tabs>` ("List View" / "Grid View"). No
 * content rewrites — Wave 4/5 will extract a Layout-free `<ChatLayout>` and a
 * header-free `<GridView>`. For Wave 3 we render the existing components
 * verbatim inside the new shell.
 */
import { useEffect, useState } from "react";
import type { AuthUser } from "../lib/auth";
import { AppShell } from "../components/ui/AppShell";
import { Tabs } from "../components/ui/Tabs";
import { ErrorBoundary } from "../components/ui/ErrorBoundary";
import { HeaderRight } from "../components/ui/HeaderRight";
import { ChatLayout } from "../components/ChatLayout";
import { GridPage } from "../components/GridPage";
import { useWebSocketContext } from "../hooks/useWebSocket";
import { activeTopRoute, buildTopNav, readTabParam, writeTabParam } from "../lib/ui/nav";

type HomeTab = "list" | "grid";

function readHomeTab(): HomeTab {
  const raw = readTabParam();
  return raw === "grid" ? "grid" : "list";
}

interface Props {
  token: string;
  user: AuthUser;
  signOut: () => void;
  onNavigate: (hash: string) => void;
  /** When the URL is `#/grid/:tabId` (legacy), this is the tab id. */
  gridTabId?: string;
}

export function HomePage({ token, user, signOut, onNavigate, gridTabId }: Props) {
  const [tab, setTab] = useState<HomeTab>(readHomeTab);
  // REVIEW BL-01: shared WS from context (avoids per-render fresh socket).
  const { subscribe } = useWebSocketContext();

  // Re-read on hashchange (other components may update tab=)
  useEffect(() => {
    const onHash = () => setTab(readHomeTab());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const handleTabChange = (next: string) => {
    const t = next === "grid" ? "grid" : "list";
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
            { key: "list", label: "List View" },
            { key: "grid", label: "Grid View" },
          ]}
          activeKey={tab}
          onChange={handleTabChange}
          renderContent={false}
        />
      </div>
      <div className="flex-1 min-h-0">
        {tab === "list" ? (
          <ErrorBoundary tabKey="home:list">
            <ChatLayout token={token} user={user} signOut={signOut} onNavigate={onNavigate} />
          </ErrorBoundary>
        ) : (
          <ErrorBoundary tabKey="home:grid">
            <GridPage token={token} tabId={gridTabId} />
          </ErrorBoundary>
        )}
      </div>
    </AppShell>
  );
}

export default HomePage;

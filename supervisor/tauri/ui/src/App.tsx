import { useCallback, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import ConnectionsPage from "./pages/ConnectionsPage";
import SecurityPage from "./pages/SecurityPage";
import OnboardingPage from "./pages/OnboardingPage";
import UpdateNotifier from "./UpdateNotifier";
import { startAutoUpdateWatcher } from "./lib/autoUpdater";

interface RuntimeStatus {
  api_key_set: boolean;
}
interface RootsConfig {
  roots: string[];
}

const TABS = [
  { to: "/", label: "Connections" },
  { to: "/security", label: "Security" },
] as const;

export default function App() {
  // null = still resolving first-run state; true/false once known.
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

  const checkFirstRun = useCallback(async () => {
    try {
      const s = await invoke<RuntimeStatus>("get_runtime_status");
      const c = await invoke<RootsConfig>("get_config");
      // First-run requires BOTH an API key and ≥1 root (orchestrator can't
      // launch with zero roots).
      setNeedsOnboarding(!s.api_key_set || (c.roots || []).length === 0);
    } catch {
      // If status can't be read, treat as first-run so the user can configure.
      setNeedsOnboarding(true);
    }
  }, []);

  useEffect(() => {
    const stop = startAutoUpdateWatcher();
    void checkFirstRun();
    return () => stop();
  }, [checkFirstRun]);

  if (needsOnboarding === null) {
    return <div className="h-full bg-[var(--bg-primary)]" />;
  }

  if (needsOnboarding) {
    return <OnboardingPage onDone={() => setNeedsOnboarding(false)} />;
  }

  return (
    <div className="h-full flex flex-col bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <UpdateNotifier />
      <TabBar />
      <main className="flex-1 overflow-y-auto px-4 md:px-6 py-5">
        <Routes>
          <Route path="/" element={<ConnectionsPage />} />
          <Route path="/security" element={<SecurityPage />} />
          {/* Retired routes redirect to Connections. */}
          <Route path="/roots" element={<Navigate to="/" replace />} />
          <Route path="/repos" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function TabBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const active = TABS.find((t) => t.to === location.pathname)?.to ?? "/";

  return (
    <header className="shrink-0 border-b border-[var(--border-color)]/40 px-4 md:px-6">
      {/* Mobile: dropdown switcher */}
      <div className="md:hidden py-2">
        <select
          value={active}
          onChange={(e) => navigate(e.target.value)}
          className="w-full text-sm px-3 py-2 rounded-lg bg-[var(--bg-tertiary)] text-[var(--text-primary)] outline-none focus:ring-2 focus:ring-blue-500"
        >
          {TABS.map((t) => (
            <option key={t.to} value={t.to}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      {/* Desktop: horizontal tab bar */}
      <nav className="hidden md:flex items-center gap-1">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end
            className={({ isActive }) =>
              [
                "px-3 py-2 my-1 rounded-lg text-sm transition-colors motion-reduce:transition-none",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500",
                isActive
                  ? "bg-blue-600/20 text-blue-300 ring-1 ring-blue-500/30"
                  : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40",
              ].join(" ")
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>
    </header>
  );
}

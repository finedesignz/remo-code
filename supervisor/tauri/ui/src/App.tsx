import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import GeneralPage from "./pages/GeneralPage";
import RootsPanel from "./components/RootsPanel";
import FoldersPage from "./pages/FoldersPage";
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
    <div className="h-full flex bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <UpdateNotifier />
      <aside className="w-48 shrink-0 p-4 space-y-1 bg-[var(--bg-secondary)]/40">
        <div className="px-3 pb-3 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Supervisor
        </div>
        <NavItem to="/" label="General" />
        <NavItem to="/roots" label="Roots" />
        <NavItem to="/repos" label="Repos" />
        <NavItem to="/security" label="Security" />
      </aside>
      <main className="flex-1 p-6 overflow-y-auto">
        <Routes>
          <Route path="/" element={<GeneralPage />} />
          <Route path="/roots" element={<RootsPanel />} />
          <Route path="/repos" element={<FoldersPage />} />
          <Route path="/security" element={<SecurityPage />} />
        </Routes>
      </main>
    </div>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end
      className={({ isActive }) =>
        [
          "block px-3 py-2 rounded-lg text-sm transition-colors",
          isActive
            ? "bg-blue-600/20 text-blue-300 ring-1 ring-blue-500/30"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40",
        ].join(" ")
      }
    >
      {label}
    </NavLink>
  );
}

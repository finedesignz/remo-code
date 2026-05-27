import { NavLink, Route, Routes } from "react-router-dom";
import GeneralPage from "./pages/GeneralPage";
import RootsPanel from "./components/RootsPanel";
import SecurityPage from "./pages/SecurityPage";
import UpdateNotifier from "./UpdateNotifier";

export default function App() {
  return (
    <div className="h-full flex bg-[var(--bg-primary)] text-[var(--text-primary)]">
      <UpdateNotifier />
      <aside className="w-48 shrink-0 p-4 space-y-1 bg-[var(--bg-secondary)]/40">
        <div className="px-3 pb-3 text-xs uppercase tracking-wide text-[var(--text-muted)]">
          Supervisor
        </div>
        <NavItem to="/" label="General" />
        <NavItem to="/folders" label="Roots" />
        <NavItem to="/security" label="Security" />
      </aside>
      <main className="flex-1 p-6 overflow-y-auto">
        <Routes>
          <Route path="/" element={<GeneralPage />} />
          <Route path="/folders" element={<RootsPanel />} />
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
            ? "bg-indigo-600/20 text-indigo-300 ring-1 ring-indigo-500/30"
            : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40",
        ].join(" ")
      }
    >
      {label}
    </NavLink>
  );
}

/**
 * MobileTopBar — the mobile (`< md`) primary navigation.
 *
 * Replaces the AppShell hamburger + left flyout on phones with a row of large
 * icon buttons across the top:
 *
 *   Home (logo) · List · Grid · Tasks ▾ · Settings ▾
 *
 * - Home routes to `#/` (the chat/list surface).
 * - List / Grid drive the Home page's `list`/`grid` sub-tabs (they live on the
 *   `home` nav item's `subTabs`), navigating to `#/?tab=list|grid`.
 * - Tasks / Settings route to their page AND, when active, expose their sub-tabs
 *   (Schedule/Activity, Connections/Credentials/…) as a top-anchored dropdown.
 *
 * Desktop (`>= md`) never renders this — AppShell gates it behind `md:hidden`.
 * The icon set is inline SVG to match the existing codebase convention (no icon
 * dependency). Active view = blue accent + underline.
 */
import { useEffect, useRef, useState } from "react";
import { cn } from "../../lib/ui/cn";
import type { AppShellNavItem, AppShellSubTab } from "./AppShell";

const ICON_PROPS = {
  width: 22,
  height: 22,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function ListIcon() {
  return (
    <svg {...ICON_PROPS}>
      <line x1="8" y1="6" x2="20" y2="6" />
      <line x1="8" y1="12" x2="20" y2="12" />
      <line x1="8" y1="18" x2="20" y2="18" />
      <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function GridIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1" />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1" />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1" />
    </svg>
  );
}

function TasksIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 6l2 2 3-3" />
      <line x1="12" y1="6" x2="20" y2="6" />
      <path d="M4 14l2 2 3-3" />
      <line x1="12" y1="15" x2="20" y2="15" />
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10" height="10" viewBox="0 0 12 12" fill="none"
      stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"
      className={cn("transition-transform", open && "rotate-180")}
      aria-hidden="true"
    >
      <path d="M3 4.5L6 7.5L9 4.5" />
    </svg>
  );
}

/** Shared classes for a top-level icon button (≥44px hit area). */
function iconButtonClass(active: boolean): string {
  return cn(
    "relative flex flex-col items-center justify-center min-w-[44px] h-11 px-3 rounded-lg transition-colors",
    "after:absolute after:bottom-0 after:left-2 after:right-2 after:h-0.5 after:rounded-full after:transition-colors",
    active
      ? "text-blue-300 after:bg-blue-400"
      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40 after:bg-transparent"
  );
}

/** A nav item that owns a dropdown of sub-tabs (Tasks / Settings). */
function DropdownNavButton({
  item,
  label,
  icon,
}: {
  item: AppShellNavItem;
  label: string;
  icon: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hasMenu = item.active && !!item.subTabs && item.subTabs.length > 0;

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Inactive page → tapping navigates. Active page → tapping toggles its
  // sub-tab dropdown.
  if (!hasMenu) {
    return (
      <a href={item.href} className={iconButtonClass(item.active ?? false)} aria-label={label}>
        {icon}
      </a>
    );
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(iconButtonClass(true), "flex-row gap-1")}
        aria-label={`${label} menu`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        {icon}
        <Chevron open={open} />
      </button>
      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 min-w-[11rem] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl ring-1 ring-white/5 z-50 overflow-hidden py-1 shadow-md">
          {item.subTabs!.map((t) => {
            const selected = t.key === item.activeSubTab;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  item.onSubTabChange?.(t.key);
                  setOpen(false);
                }}
                className={cn(
                  "w-full text-left px-3 py-2.5 text-sm transition-colors",
                  selected
                    ? "bg-blue-600/20 text-blue-300"
                    : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/50 hover:text-[var(--text-primary)]"
                )}
              >
                {t.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface MobileTopBarProps {
  nav: AppShellNavItem[];
  /** Right-side cluster (theme/reload/profile). Reused from AppShell headerRight. */
  right?: React.ReactNode;
}

/**
 * The mobile top nav bar. Consumes the SAME `nav` array AppShell gets, mapping
 * each top-level route to a large icon. Home's `list`/`grid` sub-tabs are
 * promoted to their own dedicated icons (List, Grid) per the mobile spec.
 */
export function MobileTopBar({ nav, right }: MobileTopBarProps) {
  const home = nav.find((n) => n.key === "home");
  const tasks = nav.find((n) => n.key === "tasks");
  const settings = nav.find((n) => n.key === "settings");

  const homeActive = home?.active ?? false;
  // Home sub-tabs (List / Grid) are only attached to the nav item while Home is
  // the active route; otherwise fall back to navigation hrefs.
  const homeSubTabs: AppShellSubTab[] = home?.subTabs ?? [];
  const activeSub = home?.activeSubTab;
  const hasList = homeSubTabs.some((t) => t.key === "list");
  const hasGrid = homeSubTabs.some((t) => t.key === "grid");

  const goHomeTab = (tabKey: "list" | "grid") => {
    if (homeActive && home?.onSubTabChange) {
      home.onSubTabChange(tabKey);
    } else {
      window.location.hash = `#/?tab=${tabKey}`;
    }
  };

  return (
    <nav
      className="md:hidden flex items-center gap-0.5 px-1"
      aria-label="Primary"
    >
      {/* Home — the Remo Code logo. */}
      {home && (
        <a
          href={home.href}
          className={cn(
            "relative flex items-center justify-center min-w-[44px] h-11 px-2 rounded-lg transition-colors",
            "after:absolute after:bottom-0 after:left-2 after:right-2 after:h-0.5 after:rounded-full",
            homeActive && activeSub == null ? "after:bg-blue-400" : "after:bg-transparent",
            "hover:bg-[var(--bg-tertiary)]/40"
          )}
          aria-label="Home"
        >
          <img src="/logo.png" alt="Remo Code — home" className="h-7 w-auto" />
        </a>
      )}

      {/* List view. */}
      {(hasList || !homeActive) && (
        <button
          type="button"
          onClick={() => goHomeTab("list")}
          className={iconButtonClass(homeActive && activeSub === "list")}
          aria-label="List view"
        >
          <ListIcon />
        </button>
      )}

      {/* Grid view. */}
      {(hasGrid || !homeActive) && (
        <button
          type="button"
          onClick={() => goHomeTab("grid")}
          className={iconButtonClass(homeActive && activeSub === "grid")}
          aria-label="Grid view"
        >
          <GridIcon />
        </button>
      )}

      {tasks && <DropdownNavButton item={tasks} label="Tasks" icon={<TasksIcon />} />}
      {settings && <DropdownNavButton item={settings} label="Settings" icon={<SettingsIcon />} />}

      {right && <div className="ml-auto flex items-center gap-1">{right}</div>}
    </nav>
  );
}

export default MobileTopBar;

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export interface AppShellSubTab {
  key: string;
  label: string;
}

export interface AppShellNavItem {
  key: string;
  label: string;
  href: string;
  /** Provide active state — caller computes from route. */
  active?: boolean;
  /**
   * Optional sub-tabs for the page this nav item routes to. When present AND
   * the item is `active`, the nav item renders as a dropdown trigger whose menu
   * lists the sub-tabs (replacing the old full-width <Tabs> strip).
   */
  subTabs?: AppShellSubTab[];
  /** Currently-selected sub-tab key (only meaningful with `subTabs`). */
  activeSubTab?: string;
  /** Called with the chosen sub-tab key. */
  onSubTabChange?: (key: string) => void;
}

export interface AppShellProps {
  children: ReactNode;
  /** Brand block (logo + name) rendered on the left of the header. */
  brand?: ReactNode;
  /** Primary nav links (e.g. Home, Tasks, Settings). */
  nav?: AppShellNavItem[];
  /** Right-side header slot — theme toggle, quota, profile menu, etc. */
  headerRight?: ReactNode;
  /** Footer node — desktop only. Mobile hides it per existing pattern. */
  footer?: ReactNode;
  className?: string;
  /**
   * When true (default), `<main>` scrolls its own content (document-flow pages
   * like Tasks/Settings). When false, `<main>` is a non-scrolling flex column
   * so full-height interactive children (chat / grid) can own their own scroll
   * via `h-full` + internal `overflow`. Setting this false is REQUIRED for the
   * Home page — otherwise `overflow-y-auto` collapses `h-full` grid cells to 0.
   */
  scrollMain?: boolean;
}

/**
 * Desktop nav item that opens a dropdown of sub-tabs when active. Mirrors the
 * outside-click + Escape pattern from SessionDropdown. When the item has no
 * sub-tabs (or isn't active) it renders as a plain nav link.
 */
function DesktopNavItem({ item }: { item: AppShellNavItem }) {
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

  const linkClass = cn(
    "px-3 py-1.5 rounded-lg text-sm transition-colors",
    item.active
      ? "bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300"
      : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40"
  );

  if (!hasMenu) {
    return (
      <a href={item.href} className={linkClass}>
        {item.label}
      </a>
    );
  }

  const activeSubLabel = item.subTabs!.find((t) => t.key === item.activeSubTab)?.label;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(linkClass, "inline-flex items-center gap-1.5")}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <span>{item.label}</span>
        {activeSubLabel && (
          <span className="text-[var(--text-secondary)]/70">· {activeSubLabel}</span>
        )}
        <svg
          width="12" height="12" viewBox="0 0 12 12" fill="none"
          stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
          className={cn("transition-transform", open && "rotate-180")}
          aria-hidden="true"
        >
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>
      {open && (
        // Plain disclosure (not an ARIA menu) — the menu-button pattern would
        // require roving-tabindex + arrow-key nav + focus return, which is more
        // than this simple sub-tab switcher warrants. aria-expanded +
        // aria-haspopup on the trigger + native button focus order is correct.
        <div
          className="absolute top-full left-0 mt-1 min-w-[12rem] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl ring-1 ring-white/5 z-50 overflow-hidden py-1"
          style={{ backgroundColor: "var(--bg-secondary)" }}
        >
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
                  "w-full text-left px-3 py-2 text-sm transition-colors",
                  selected
                    ? "bg-indigo-600/20 text-indigo-300"
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

/**
 * AppShell — header + main + (desktop-only) footer scaffold for the 3 new top-level pages.
 *
 * Header items: nav links highlight when `item.active` is true. The "Settings" nav link
 * IS the gear/settings entrypoint (no separate icon — relocated from PR #88).
 *
 * Mobile (`< md`): the Home / Tasks / Settings nav collapses behind a hamburger
 * button that opens a left slide-over flyout. Desktop keeps the inline nav.
 */
export function AppShell({
  children,
  brand,
  nav,
  headerRight,
  footer,
  className,
  scrollMain = true,
}: AppShellProps) {
  const [navOpen, setNavOpen] = useState(false);
  const hasNav = !!nav && nav.length > 0;

  // Close the flyout on Escape, and lock it shut when crossing to desktop.
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    const onResize = () => {
      if (window.innerWidth >= 768) setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [navOpen]);

  return (
    <div
      className={cn(
        "flex flex-col h-[100dvh] min-h-0 bg-[var(--bg-primary)] text-[var(--text-primary)]",
        className
      )}
    >
      <header className="shrink-0 flex items-center gap-3 px-3 md:px-6 h-14 border-b border-[var(--border-color)]/40 bg-[var(--bg-primary)] safe-top safe-x">
        {/* Mobile hamburger — opens the Home/Tasks/Settings flyout. */}
        {hasNav && (
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            className="md:hidden p-1.5 -ml-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors"
            aria-label="Open navigation"
            aria-expanded={navOpen}
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <line x1="3" y1="5" x2="17" y2="5" />
              <line x1="3" y1="10" x2="17" y2="10" />
              <line x1="3" y1="15" x2="17" y2="15" />
            </svg>
          </button>
        )}

        {brand && <div className="flex items-center gap-2 shrink-0">{brand}</div>}

        {/* Desktop inline nav. The active page's sub-tabs hang off its nav
            item as a dropdown (replacing the old full-width <Tabs> strip). */}
        {hasNav && (
          <nav className="hidden md:flex items-center gap-1">
            {nav!.map((item) => (
              <DesktopNavItem key={item.key} item={item} />
            ))}
          </nav>
        )}

        <div className="ml-auto flex items-center gap-2">{headerRight}</div>
      </header>

      {/* Mobile nav flyout (slide-over from the left). */}
      {hasNav && navOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setNavOpen(false)}
            aria-hidden="true"
          />
          <nav
            className="absolute inset-y-0 left-0 w-64 max-w-[80vw] bg-[var(--bg-secondary)] ring-1 ring-white/5 flex flex-col safe-top safe-x"
            aria-label="Primary"
          >
            <div className="flex items-center justify-between px-4 h-14 border-b border-[var(--border-color)]/40">
              <span className="text-sm font-semibold text-[var(--text-primary)]">Menu</span>
              <button
                type="button"
                onClick={() => setNavOpen(false)}
                className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors"
                aria-label="Close navigation"
              >
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                  <line x1="4" y1="4" x2="14" y2="14" />
                  <line x1="14" y1="4" x2="4" y2="14" />
                </svg>
              </button>
            </div>
            <div className="p-2 space-y-1">
              {nav!.map((item) => {
                const showSubTabs =
                  item.active && !!item.subTabs && item.subTabs.length > 0;
                return (
                  <div key={item.key}>
                    <a
                      href={item.href}
                      onClick={() => setNavOpen(false)}
                      className={cn(
                        "block px-3 py-2.5 rounded-lg text-sm transition-colors",
                        item.active
                          ? "bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300"
                          : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40"
                      )}
                    >
                      {item.label}
                    </a>
                    {/* Active page's sub-tabs, indented under its nav item. */}
                    {showSubTabs && (
                      <div className="mt-1 ml-3 pl-2 border-l border-[var(--border-color)]/40 space-y-0.5">
                        {item.subTabs!.map((t) => {
                          const selected = t.key === item.activeSubTab;
                          return (
                            <button
                              key={t.key}
                              type="button"
                              onClick={() => {
                                item.onSubTabChange?.(t.key);
                                setNavOpen(false);
                              }}
                              className={cn(
                                "block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors",
                                selected
                                  ? "bg-indigo-600/20 text-indigo-300"
                                  : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40"
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
              })}
            </div>
          </nav>
        </div>
      )}

      <main
        className={cn(
          "flex-1 min-h-0 flex flex-col",
          scrollMain && "overflow-y-auto"
        )}
      >
        {children}
      </main>

      {footer && (
        <footer className="shrink-0 hidden md:flex items-center px-6 h-10 border-t border-[var(--border-color)]/40 text-xs text-[var(--text-muted)]">
          {footer}
        </footer>
      )}
    </div>
  );
}

export default AppShell;

import type { ReactNode } from "react";
import { cn } from "../../lib/ui/cn";

export interface AppShellNavItem {
  key: string;
  label: string;
  href: string;
  /** Provide active state — caller computes from route. */
  active?: boolean;
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
}

/**
 * AppShell — header + main + (desktop-only) footer scaffold for the 3 new top-level pages.
 *
 * Header items: nav links highlight when `item.active` is true. The "Settings" nav link
 * IS the gear/settings entrypoint (no separate icon — relocated from PR #88).
 */
export function AppShell({
  children,
  brand,
  nav,
  headerRight,
  footer,
  className,
}: AppShellProps) {
  return (
    <div
      className={cn(
        "flex flex-col h-[100dvh] bg-[var(--bg-primary)] text-[var(--text-primary)]",
        className
      )}
    >
      <header className="flex items-center gap-4 px-4 md:px-6 h-14 border-b border-[var(--border-color)]/40 bg-[var(--bg-primary)]">
        {brand && <div className="flex items-center gap-2">{brand}</div>}
        {nav && nav.length > 0 && (
          <nav className="flex items-center gap-1">
            {nav.map((item) => (
              <a
                key={item.key}
                href={item.href}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm transition-colors",
                  item.active
                    ? "bg-indigo-600/20 ring-1 ring-indigo-500/30 text-indigo-300"
                    : "text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/40"
                )}
              >
                {item.label}
              </a>
            ))}
          </nav>
        )}
        <div className="ml-auto flex items-center gap-2">{headerRight}</div>
      </header>

      <main className="flex-1 overflow-y-auto">{children}</main>

      {footer && (
        <footer className="hidden md:flex items-center px-6 h-10 border-t border-[var(--border-color)]/40 text-xs text-[var(--text-muted)]">
          {footer}
        </footer>
      )}
    </div>
  );
}

export default AppShell;

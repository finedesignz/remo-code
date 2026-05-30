/**
 * Phase 12 — shared header-right cluster for the top-level pages.
 *
 * Single source of truth for: theme toggle + usage strip + profile menu.
 * Mounted by <AppShell> on Home/Tasks/Settings.
 */
import { useState, useEffect, useRef } from "react";
import type { AuthUser } from "../../lib/auth";
import { useTheme } from "../../hooks/useTheme";
import { UsageStrip } from "../UsageStrip";
import { useLicense, type LicenseStatus } from "../../hooks/useLicense";
import { titaniumPortalUrl } from "../../lib/auth";
import { hubFetch } from "../../lib/api";

type Subscribe = (handler: (msg: any) => void) => () => void;

function licenseDotClass(s: LicenseStatus): string {
  switch (s) {
    case "active": return "bg-emerald-400";
    case "expired": return "bg-amber-400";
    case "suspended":
    case "banned": return "bg-red-400";
    case "none": return "bg-[var(--text-muted)]";
    default: return "bg-transparent";
  }
}

function licenseTextClass(s: LicenseStatus): string {
  switch (s) {
    case "active": return "text-emerald-400";
    case "expired": return "text-amber-400";
    case "suspended":
    case "banned": return "text-red-400";
    default: return "text-[var(--text-muted)]";
  }
}

export interface HeaderRightProps {
  token: string;
  user: AuthUser;
  signOut: () => void;
  onNavigate: (hash: string) => void;
  subscribe: Subscribe;
}

export function HeaderRight({ token, user, signOut, onNavigate, subscribe }: HeaderRightProps) {
  const { theme, toggleTheme } = useTheme();
  return (
    <>
      <button
        onClick={toggleTheme}
        className="p-1.5 text-[var(--text-muted)] hover:text-[var(--text-primary)] rounded-lg hover:bg-[var(--bg-tertiary)]/40 transition-colors"
        title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        aria-label="Toggle theme"
      >
        {theme === "dark" ? (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="8" cy="8" r="3" />
            <path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13.5 8.5a5.5 5.5 0 1 1-7-7 4.5 4.5 0 0 0 7 7z" />
          </svg>
        )}
      </button>
      <UsageStrip subscribe={subscribe} />
      <ProfileMenu user={user} onNavigate={onNavigate} signOut={signOut} token={token} />
    </>
  );
}

function ProfileMenu({ user, onNavigate, signOut, token }: { user: AuthUser; onNavigate: (h: string) => void; signOut: () => void; token: string }) {
  const [open, setOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const { license } = useLicense(token);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    hubFetch<{ avatar_url?: string | null }>(token, "/api/profile")
      .then((p) => { if (!cancelled && p) setAvatarUrl(p.avatar_url ?? null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (hash: string) => { setOpen(false); onNavigate(hash); };
  const initial = (user.email || "?")[0].toUpperCase();
  const firstName = (() => {
    const dn = (user as any).display_name as string | undefined;
    if (dn && dn.trim()) return dn.trim().split(/\s+/)[0];
    const local = (user.email || "").split("@")[0];
    if (!local) return "";
    const seg = local.split(/[._-]/)[0];
    return seg ? seg.charAt(0).toUpperCase() + seg.slice(1) : "";
  })();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-[var(--bg-tertiary)]/40 transition-colors"
        title={user.email || "Profile"}
        aria-label="Open profile menu"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span className="relative w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-[var(--text-on-accent)] text-xs font-medium shrink-0 overflow-hidden">
          {avatarUrl ? <img src={avatarUrl} alt="" className="w-full h-full object-cover" /> : initial}
          {license && license.status !== "unknown" && (
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[var(--bg-primary)] ${licenseDotClass(license.status)}`}
              title={`License: ${license.status}`}
            />
          )}
        </span>
        {firstName && (
          <span className="text-sm text-[var(--text-secondary)] font-medium hidden sm:inline">{firstName}</span>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" className="text-[var(--text-muted)]">
          <path d="M2.5 4l2.5 2.5L7.5 4" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 w-56 bg-[var(--bg-secondary)] ring-1 ring-[var(--border-color)] rounded-lg shadow-xl z-50 py-1"
        >
          <div className="px-3 py-2 border-b border-[var(--border-color)]">
            <div className="text-xs text-[var(--text-muted)]">Signed in as</div>
            <div className="text-sm text-[var(--text-primary)] truncate">{user.email}</div>
            {license && license.status !== "unknown" && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${licenseDotClass(license.status)}`} />
                <span className={`text-[11px] ${licenseTextClass(license.status)}`}>License: {license.status}</span>
              </div>
            )}
          </div>
          <button role="menuitem" onClick={() => go("#/settings?tab=profile")} className="w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 hover:text-[var(--text-primary)] transition-colors">Profile</button>
          <a
            role="menuitem"
            href={`${titaniumPortalUrl()}/account`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-left px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]/40 hover:text-[var(--text-primary)] transition-colors"
            onClick={() => setOpen(false)}
          >Manage account in Titanium ↗</a>
          <button
            role="menuitem"
            onClick={() => { setOpen(false); signOut(); }}
            className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
          >Logout</button>
        </div>
      )}
    </div>
  );
}

export default HeaderRight;

/**
 * Phase 12 W3 — shared nav helpers for the top-level pages.
 *
 * The 3 pages (Home / Tasks / Settings) each render `<AppShell>` with the same
 * nav items. Active-state is derived from `window.location.hash`.
 */
import type { AppShellNavItem } from "../../components/ui/AppShell";

export type TopRoute = "home" | "tasks" | "settings";

/**
 * Parse the current hash and return which top-level route is active.
 * Falls back to "home" for unknown / unauthenticated routes.
 */
export function activeTopRoute(hash: string = window.location.hash): TopRoute {
  if (hash.startsWith("#/tasks")) return "tasks";
  if (hash.startsWith("#/settings")) return "settings";
  // Legacy redirects all resolve to one of the three above before they reach
  // this helper, so anything else maps to home.
  return "home";
}

/**
 * Build the 3 nav items with `active` flipped based on the current hash.
 */
export function buildTopNav(active: TopRoute): AppShellNavItem[] {
  return [
    { key: "home", label: "Home", href: "#/", active: active === "home" },
    { key: "tasks", label: "Tasks", href: "#/tasks", active: active === "tasks" },
    { key: "settings", label: "Settings", href: "#/settings", active: active === "settings" },
  ];
}

/**
 * Read a tab query param out of the hash. Hashes look like
 *   `#/tasks?tab=activity&grid_tab=abc`
 * — we only care about whatever is between `?` and `#`/end.
 */
export function readTabParam(hash: string = window.location.hash, key = "tab"): string | null {
  const q = hash.split("?")[1];
  if (!q) return null;
  for (const part of q.split("&")) {
    const [k, v] = part.split("=");
    if (k === key) return v ? decodeURIComponent(v) : null;
  }
  return null;
}

/**
 * Write the tab query param into the hash via `replaceState` (no history entry).
 * Preserves the path portion (`#/tasks`) and any other query params.
 */
export function writeTabParam(tab: string, key = "tab"): void {
  const hash = window.location.hash || "#/";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query || "");
  params.set(key, tab);
  const next = `${path}?${params.toString()}`;
  if (next !== hash) {
    window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
  }
}

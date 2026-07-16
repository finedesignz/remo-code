/**
 * Phase 12 W3 — shared nav helpers for the top-level pages.
 *
 * The 3 pages (Home / Tasks / Settings) each render `<AppShell>` with the same
 * nav items. Active-state is derived from `window.location.hash`.
 */
import type { AppShellNavItem, AppShellSubTab } from "../../components/ui/AppShell";

export type TopRoute = "home" | "tasks" | "settings";

/**
 * Optional sub-tab wiring for the active page — attached to the matching nav
 * item so its tabs render as a dropdown hanging off the header nav.
 */
export interface SubTabConfig {
  route: TopRoute;
  subTabs: AppShellSubTab[];
  activeSubTab: string;
  onSubTabChange: (key: string) => void;
}

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
 *
 * When `subTabs` is provided, its sub-tab config is attached to the matching
 * nav item so AppShell renders them as a dropdown off that item (replacing the
 * old full-width <Tabs> strip).
 */
export function buildTopNav(active: TopRoute, subTabs?: SubTabConfig): AppShellNavItem[] {
  const items: AppShellNavItem[] = [
    { key: "home", label: "Home", href: "#/", active: active === "home" },
    { key: "tasks", label: "Tasks", href: "#/tasks", active: active === "tasks" },
    { key: "settings", label: "Settings", href: "#/settings", active: active === "settings" },
  ];
  if (subTabs) {
    const target = items.find((i) => i.key === subTabs.route);
    if (target) {
      target.subTabs = subTabs.subTabs;
      target.activeSubTab = subTabs.activeSubTab;
      target.onSubTabChange = subTabs.onSubTabChange;
    }
  }
  return items;
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
 * Read the `session` param out of the hash (`#/?session=<id>`). Set by
 * `navigateToSession` after a supervisor start binds a session id; ChatLayout
 * consumes it to select that session, then clears it.
 */
export function readSessionParam(hash: string = window.location.hash): string | null {
  return readTabParam(hash, "session");
}

/**
 * Drop the `session` param from the hash via `replaceState`, so a later manual
 * session selection isn't clobbered by a re-read of a stale hash.
 */
export function clearSessionParam(): void {
  const hash = window.location.hash || "#/";
  const [path, query] = hash.split("?");
  const params = new URLSearchParams(query || "");
  if (!params.has("session")) return;
  params.delete("session");
  const rest = params.toString();
  const next = rest ? `${path}?${rest}` : path;
  window.history.replaceState(null, "", window.location.pathname + window.location.search + next);
}

/**
 * Navigate to Home with `sessionId` selected. Used by the Connections table's
 * Play button once the started run has bound a real session id.
 */
export function navigateToSession(sessionId: string): void {
  window.location.hash = `#/?session=${encodeURIComponent(sessionId)}`;
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

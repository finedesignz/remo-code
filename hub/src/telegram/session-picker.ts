/**
 * Phase 12 follow-up — Telegram inline-keyboard session picker.
 *
 * Pure: render the inline-keyboard payload + label/callback_data helpers used
 * by `/list` and by the `callback_query` re-render path. DB I/O lives in the
 * webhook layer; this module is unit-testable without mocks.
 *
 * Callback-data encoding (≤64 bytes per Telegram limit):
 *   "s:<session_id>"   — set default session
 *   "p:<offset>"       — paginate to offset (0-indexed, page_size=20)
 *
 * Layout:
 *   - 20 sessions per page, 2 per row (10 rows of session buttons).
 *   - Nav row appended ONLY when total > page_size, with "« Prev" / "Next »"
 *     buttons (omit the unreachable side at first/last page).
 *   - Currently-default session is marked with a leading "✓ ".
 */

import type { InlineKeyboard, InlineKeyboardButton } from "./client.ts";

export const PAGE_SIZE = 20;
export const BUTTONS_PER_ROW = 2;
const MAX_LABEL_LEN = 28;

export interface PickerSessionRow {
  id: string;
  name: string | null;
  project_dir: string | null;
  status?: string | null;
  repo_key?: string | null;
  is_orchestrator?: boolean;
  github_owner?: string | null;
  github_repo?: string | null;
  /** ms epoch; used for repo_key dedupe survivor pick. */
  last_activity_ms?: number | null;
}

/**
 * Normalize a string for canonical-repo-name matching (Bug A): lowercase,
 * strip leading dots, normalize hyphens. We compare a session's project_dir
 * basename against `github_repo` to decide which row is the canonical clone
 * vs a worktree clone like `<repo>-feat-X`.
 */
function normRepoName(s: string): string {
  return s.toLowerCase().replace(/^\.+/, "").replace(/_/g, "-");
}

function projectBasename(dir: string | null | undefined): string | null {
  if (!dir) return null;
  const parts = dir.split(/[\\/]/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? null;
}

/**
 * Bug A — collapse worktree rows by (github_owner, github_repo).
 *
 * Multiple worktree directories of the same GitHub repo (e.g.
 * `remo-code`, `remo-code-feat-X`, `remo-code-fix-Y`) appear as distinct
 * session rows. We collapse them to the canonical clone (project_dir
 * basename matches github_repo case-/separator-insensitively). Ties or
 * "no canonical present" → most-recently-active wins.
 *
 * Rows with null github_owner OR null github_repo are passed through
 * untouched.
 */
function collapseWorktreesByRepo(rows: PickerSessionRow[]): PickerSessionRow[] {
  const groups = new Map<string, PickerSessionRow[]>();
  const passthrough: PickerSessionRow[] = [];
  for (const s of rows) {
    if (!s.github_owner || !s.github_repo) {
      passthrough.push(s);
      continue;
    }
    const key = `${s.github_owner.toLowerCase()}/${s.github_repo.toLowerCase()}`;
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  const survivors = new Set<PickerSessionRow>();
  for (const arr of groups.values()) {
    if (arr.length === 1) { survivors.add(arr[0]!); continue; }
    // Prefer canonical: basename equals normalized github_repo.
    const canonical = arr.filter((s) => {
      const base = projectBasename(s.project_dir);
      if (!base || !s.github_repo) return false;
      return normRepoName(base) === normRepoName(s.github_repo);
    });
    const pool = canonical.length > 0 ? canonical : arr;
    let best = pool[0]!;
    for (const s of pool.slice(1)) {
      if ((s.last_activity_ms ?? 0) > (best.last_activity_ms ?? 0)) best = s;
    }
    survivors.add(best);
  }
  // Preserve original order.
  const out: PickerSessionRow[] = [];
  for (const s of rows) {
    if (!s.github_owner || !s.github_repo) { out.push(s); continue; }
    if (survivors.has(s)) out.push(s);
  }
  void passthrough;
  return out;
}

/**
 * Match the web Sidebar's filtering (Sidebar.tsx lines 157–178, 437–446):
 *
 *  1. Drop rows that are simultaneously offline AND have no repo_key —
 *     "legacy local offline" entries with no actionable surface.
 *  2. Dedupe by repo_key, keeping the most-recently-active row. Rows with
 *     null repo_key pass through keyed by id.
 *  3. Pin the orchestrator row (is_orchestrator=true) to position 0.
 *
 * Returns a NEW array; input is not mutated.
 */
export function applySidebarParityFilter(rows: PickerSessionRow[]): PickerSessionRow[] {
  // Step 1 — drop offline + no repo_key, EXCEPT the orchestrator. The root
  // orchestrator is a repo-less session (no repo_key) and is frequently offline
  // (it launches lazily on first message). It MUST always be visible and pinned
  // so the user can tap-to-select it — mirrors the web Sidebar position-0 pin,
  // which never hides the orchestrator on offline/no-repo grounds.
  const isOnline = (s: PickerSessionRow): boolean => s.status === "online" || s.status === "thinking";
  const filtered = rows.filter((s) => s.is_orchestrator || isOnline(s) || !!s.repo_key);

  // Step 1b (Bug A) — collapse worktrees by (github_owner, github_repo).
  const kept = collapseWorktreesByRepo(filtered);

  // Step 2 — dedupe by repo_key, keep most-recently-active.
  const byKey = new Map<string, PickerSessionRow>();
  const passthrough: PickerSessionRow[] = [];
  for (const s of kept) {
    if (!s.repo_key) {
      passthrough.push(s);
      continue;
    }
    const prev = byKey.get(s.repo_key);
    if (!prev) {
      byKey.set(s.repo_key, s);
      continue;
    }
    const a = prev.last_activity_ms ?? 0;
    const b = s.last_activity_ms ?? 0;
    if (b > a) byKey.set(s.repo_key, s);
  }
  // Preserve the original order: walk `kept` and emit each row only once.
  const seen = new Set<PickerSessionRow>();
  const dedupedOrdered: PickerSessionRow[] = [];
  for (const s of kept) {
    if (!s.repo_key) {
      if (!seen.has(s)) { dedupedOrdered.push(s); seen.add(s); }
      continue;
    }
    const survivor = byKey.get(s.repo_key)!;
    if (!seen.has(survivor)) { dedupedOrdered.push(survivor); seen.add(survivor); }
  }
  // (passthrough already covered via the seen-set above)
  void passthrough;

  // Step 3 — pin orchestrator first.
  const orchIdx = dedupedOrdered.findIndex((s) => s.is_orchestrator);
  if (orchIdx > 0) {
    const [orch] = dedupedOrdered.splice(orchIdx, 1);
    dedupedOrdered.unshift(orch!);
  }
  return dedupedOrdered;
}

/**
 * Derive a short, human-friendly label from project_dir (second-to-last
 * segment when it looks like a path; basename otherwise), falling back to the
 * stored `name`, then to the short id. Truncated to MAX_LABEL_LEN.
 */
export function deriveLabel(row: PickerSessionRow): string {
  const raw =
    repoNameFromProjectDir(row.project_dir) ??
    row.name ??
    row.project_dir?.split(/[\\/]/).filter(Boolean).pop() ??
    row.id.slice(0, 8);
  return truncate(raw, MAX_LABEL_LEN);
}

function repoNameFromProjectDir(dir: string | null): string | null {
  if (!dir) return null;
  // Split on both slash flavors, drop empties, take the last non-empty segment.
  const parts = dir.split(/[\\/]/).filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  // Prefer last segment (the repo dir itself, e.g. `vidgenatar`).
  return parts[parts.length - 1] ?? null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)) + "…";
}

/**
 * Build the inline-keyboard payload for a page of sessions.
 *
 *   rows         — full sorted session list (newest first).
 *   offset       — page start, multiple of PAGE_SIZE.
 *   defaultId    — currently selected session, gets a leading ✓.
 */
export function buildSessionKeyboard(opts: {
  rows: PickerSessionRow[];
  offset: number;
  defaultId: string | null;
}): InlineKeyboard {
  const { rows, offset, defaultId } = opts;
  const page = rows.slice(offset, offset + PAGE_SIZE);
  const keyboard: InlineKeyboard = [];

  for (let i = 0; i < page.length; i += BUTTONS_PER_ROW) {
    const row: InlineKeyboardButton[] = [];
    for (let j = 0; j < BUTTONS_PER_ROW && i + j < page.length; j++) {
      const s = page[i + j]!;
      const isOnline = s.status === "online" || s.status === "thinking";
      const checkMark = defaultId && s.id === defaultId ? "✓ " : "";
      const statusDot = isOnline ? "🟢 " : "";
      // The orchestrator gets a fixed, self-describing label so the user can
      // recognize + tap it even when it has no repo name. Non-orchestrator rows
      // derive their label from project_dir/name.
      const text = s.is_orchestrator
        ? truncate(checkMark + "🧭 Orchestrator (root)", MAX_LABEL_LEN)
        : truncate(checkMark + statusDot + deriveLabel(s), MAX_LABEL_LEN);
      row.push({ text, callback_data: `s:${s.id}` });
    }
    keyboard.push(row);
  }

  // Nav row
  const total = rows.length;
  const hasPrev = offset > 0;
  const hasNext = offset + PAGE_SIZE < total;
  if (hasPrev || hasNext) {
    const navRow: InlineKeyboardButton[] = [];
    if (hasPrev) {
      navRow.push({ text: "« Prev", callback_data: `p:${Math.max(0, offset - PAGE_SIZE)}` });
    }
    if (hasNext) {
      navRow.push({ text: "Next »", callback_data: `p:${offset + PAGE_SIZE}` });
    }
    keyboard.push(navRow);
  }

  return keyboard;
}

/** Render the body text that accompanies a picker keyboard. */
export function renderPickerText(opts: {
  total: number;
  offset: number;
  defaultId: string | null;
  /** Optional — when present, legend includes ⭐ only if the visible page has the orchestrator row. */
  rows?: PickerSessionRow[];
}): string {
  const { total, offset, defaultId, rows } = opts;
  if (total === 0) {
    return "No sessions found. Start one from the remo-code web UI first.";
  }
  const lastIdx = Math.min(offset + PAGE_SIZE, total);
  const lines = [
    `Your sessions (${offset + 1}–${lastIdx} of ${total}):`,
    "Tap a button to set it as your default.",
  ];
  const legend: string[] = [];
  legend.push("🟢 = launched");
  if (defaultId) legend.push("✓ = current default");
  let anyOrchestrator = false;
  if (rows) {
    const page = rows.slice(offset, offset + PAGE_SIZE);
    if (page.some((s) => s.is_orchestrator)) {
      legend.push("🧭 = orchestrator (root folder)");
      anyOrchestrator = true;
    }
    if (!anyOrchestrator) {
      // Bug C — only check the full list once we've established the page has none.
      if (!rows.some((s) => s.is_orchestrator)) {
        lines.push("");
        lines.push(legend.join("    "));
        lines.push("");
        lines.push("💡 Pin a root orchestrator from Settings → Connections for cross-repo coordination.");
        return lines.join("\n");
      }
    }
  }
  lines.push("");
  lines.push(legend.join("    "));
  return lines.join("\n");
}

/**
 * Parse callback_data. Returns null on unknown prefix or malformed payload.
 * Validation is strict — we accept ONLY the two prefixes we emit.
 */
export type CallbackAction =
  | { kind: "set_session"; sessionId: string }
  | { kind: "paginate"; offset: number };

/**
 * Snap an arbitrary offset to the nearest PAGE_SIZE boundary, clamped to a
 * valid page within [0, total). Lets the webhook safely consume a `p:<n>`
 * callback emitted by a keyboard rendered before page_size changed.
 */
export function snapOffsetToPage(offset: number, total: number): number {
  if (total <= 0) return 0;
  const max = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
  const snapped = Math.max(0, Math.floor(offset / PAGE_SIZE) * PAGE_SIZE);
  return Math.min(snapped, max);
}

export function parseCallbackData(data: string | undefined | null): CallbackAction | null {
  if (!data) return null;
  if (data.length > 64) return null; // Telegram hard limit; defensive.
  if (data.startsWith("s:")) {
    const sid = data.slice(2);
    if (sid.length === 0 || sid.length > 60) return null;
    return { kind: "set_session", sessionId: sid };
  }
  if (data.startsWith("p:")) {
    const n = Number(data.slice(2));
    if (!Number.isInteger(n) || n < 0 || n > 10_000) return null;
    return { kind: "paginate", offset: n };
  }
  return null;
}

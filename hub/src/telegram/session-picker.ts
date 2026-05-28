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
      const label = deriveLabel(s);
      const prefix = defaultId && s.id === defaultId ? "✓ " : "";
      const text = truncate(prefix + label, MAX_LABEL_LEN);
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
}): string {
  const { total, offset, defaultId } = opts;
  if (total === 0) {
    return "No sessions found. Start one from the remo-code web UI first.";
  }
  const lastIdx = Math.min(offset + PAGE_SIZE, total);
  const lines = [
    `Your sessions (${offset + 1}–${lastIdx} of ${total}):`,
    "Tap a button to set it as your default.",
  ];
  if (defaultId) {
    lines.push("");
    lines.push(`Current default marked with ✓.`);
  }
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

/**
 * Phase 12 — Telegram command parser + handlers.
 *
 * Pure-ish: each handler returns a reply string (sent by the webhook caller).
 * No direct Telegram API calls inside this module — keeps it unit-testable
 * without stubbing `fetch`. The webhook handler glues this to `client.ts`
 * `sendMessage` and to `dispatch.ts`.
 *
 * Commands:
 *   /start <code>   — bind chat_id (unlinked-chat path).
 *   /session <arg>  — pick default session (linked, exact session id only in v1).
 *   /list           — list user sessions.
 *   /help           — command reference.
 */
import { sql } from "../db/postgres.ts";
import {
  findUserByLinkCode,
  setTelegramChatId,
  setTelegramDefaultSession,
  type TelegramUserRow,
} from "../db/dal.ts";
import { launchSessionForUser } from "./launch.ts";
import {
  buildSessionKeyboard,
  renderPickerText,
  applySidebarParityFilter,
  PAGE_SIZE,
  type PickerSessionRow,
} from "./session-picker.ts";
import type { InlineKeyboard } from "./client.ts";

export type ParsedCommand =
  | { kind: "start"; arg: string }
  | { kind: "session"; arg: string | null }
  | { kind: "list" }
  | { kind: "help" }
  | { kind: "doctor" }
  | { kind: "status" }
  | { kind: "unknown"; raw: string }
  | { kind: "none" };

const CMD_RE = /^\s*\/([a-zA-Z][a-zA-Z0-9_]*)(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string | undefined | null): ParsedCommand {
  if (!text) return { kind: "none" };
  const m = CMD_RE.exec(text);
  if (!m) return { kind: "none" };
  const name = m[1]!.toLowerCase();
  const arg = (m[2] ?? "").trim();
  switch (name) {
    case "start":
      return { kind: "start", arg };
    case "session":
      return { kind: "session", arg: arg || null };
    case "list":
      return { kind: "list" };
    case "help":
      return { kind: "help" };
    case "doctor":
      return { kind: "doctor" };
    case "status":
      return { kind: "status" };
    default:
      return { kind: "unknown", raw: name };
  }
}

/**
 * Canonical bot command list — the SINGLE source of truth for both the `/help`
 * text and Telegram's `setMyCommands` slash-menu popup. Order is the menu order.
 * `command` has NO leading slash (Telegram adds it). Keep in lockstep with the
 * commands `parseCommand` recognizes + the webhook's LINKED command switch.
 */
export const BOT_COMMANDS: ReadonlyArray<{ command: string; description: string }> = [
  { command: "list", description: "Pick your default session (tap-to-select buttons)" },
  { command: "session", description: "Set default session by id-prefix" },
  { command: "status", description: "Show link, default session, supervisor & daily cost" },
  { command: "doctor", description: "Diagnose & auto-fix an offline supervisor/session" },
  { command: "help", description: "Show the command reference" },
];

export const HELP_TEXT = [
  "Remo Code Telegram bridge — commands:",
  "",
  "/list — tap-to-pick session list (inline buttons). 🧭 Orchestrator (root folder) is pinned at the top — tap it to coordinate across all repos.",
  "/session <id> — set default by typed id-prefix (power users; /list is easier)",
  "/status — link, default session, supervisor, channel, daily cost",
  "/doctor — diagnose and auto-fix supervisor/session offline issues",
  "/help — this message",
  "",
  "Send any plain text to forward it to your default session.",
  "Send a photo to attach it to the next message.",
].join("\n");

/**
 * `/start <code>` — only sensible from an UNLINKED chat. Validates and
 * consumes the link code, binds `chat_id` to the user.
 */
export async function handleStart(opts: {
  code: string;
  chatId: number | bigint | string;
}): Promise<{ reply: string; linkedUserId: string | null }> {
  const code = opts.code.trim();
  if (!code) {
    return {
      reply: "Send /start <code> with the link code from Settings → Telegram on remo-code.",
      linkedUserId: null,
    };
  }
  const found = await findUserByLinkCode(code);
  if (!found) {
    return {
      reply: "Link code invalid or expired. Generate a fresh one from Settings → Telegram.",
      linkedUserId: null,
    };
  }
  if (!found.expiresAt || found.expiresAt.getTime() < Date.now()) {
    return {
      reply: "Link code expired. Generate a fresh one from Settings → Telegram.",
      linkedUserId: null,
    };
  }
  // Bind. setTelegramChatId also clears the code row.
  await setTelegramChatId(found.id, opts.chatId as any);
  // Best-effort email lookup for the confirmation reply.
  let email = "";
  try {
    const rows = await sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${found.id}`;
    email = rows[0]?.email ?? "";
  } catch {
    /* swallow — confirmation copy is non-essential */
  }
  return {
    reply: email
      ? `Linked to ${email}. Send /help for commands.`
      : "Linked. Send /help for commands.",
    linkedUserId: found.id,
  };
}

/**
 * Post-link pre-warm. Best-effort: pick the user's most-recently-used session
 * (online-first, then last_activity DESC — same ordering as the picker), set
 * it as the Telegram default, and fire `session.start` so it's live by the
 * time the user sends their first chat message.
 *
 * Returns the chosen session label for the welcome reply, or null when the
 * user has zero sessions OR a default was already set (rare on a fresh link).
 *
 * Failures are swallowed — the link itself is committed by the caller and
 * `/doctor` will repair anything broken on the first real message.
 *
 * `launchImpl` is injectable for tests.
 */
export async function prewarmAfterLink(opts: {
  userId: string;
  existingDefault: string | null;
  launchImpl?: typeof launchSessionForUser;
}): Promise<{ kind: "skipped"; reason: "already_set" | "no_sessions" } | { kind: "prewarmed"; sessionId: string; label: string }> {
  if (opts.existingDefault) {
    return { kind: "skipped", reason: "already_set" };
  }

  // orchestrator-autolaunch: when the orchestrator is enabled, leave the default
  // UNSET so inbound dispatch falls back to (and lazy-pins) the orchestrator —
  // "the first agent you talk to is the root orchestrator". We do NOT pin a
  // project session here, which would block that fallback. The orchestrator is
  // launched on supervisor.hello (or inbound autoheal), so no prewarm needed.
  try {
    const { getOrchestratorState } = await import("../db/orchestrator-dal.ts");
    const prefs = await getOrchestratorState(opts.userId);
    if (prefs.orchestrator_enabled && !prefs.orchestrator_disabled_explicitly) {
      return { kind: "skipped", reason: "no_sessions" };
    }
  } catch {
    /* fall through to legacy prewarm */
  }

  const launch = opts.launchImpl ?? launchSessionForUser;
  let candidate: { id: string; name: string | null; project_dir: string | null } | undefined;
  try {
    const rows = await sql<{ id: string; name: string | null; project_dir: string | null }[]>`
      SELECT id, name, project_dir
        FROM sessions
       WHERE user_id = ${opts.userId} AND deleted_at IS NULL
       ORDER BY (status IN ('online','thinking')) DESC, last_activity DESC NULLS LAST
       LIMIT 1
    `;
    candidate = rows[0];
  } catch {
    return { kind: "skipped", reason: "no_sessions" };
  }
  if (!candidate || typeof candidate.id !== "string" || !candidate.id) {
    return { kind: "skipped", reason: "no_sessions" };
  }
  try {
    // Prewarm auto-pin → NON-explicit, so a later inbound can still prefer the
    // orchestrator and an explicit /session pick always wins.
    await setTelegramDefaultSession(opts.userId, candidate.id, false);
  } catch {
    /* swallow — link is still atomic */
  }
  // Fire-and-forget: do NOT await the deferred socket round-trip for the
  // welcome reply, but DO await `launchImpl` itself so any synchronous setup
  // (reserveSessionSlot, createRun) completes before we return. The webhook
  // handler doesn't care about the result — `/doctor` is the fallback.
  try {
    void launch({ userId: opts.userId, sessionId: candidate.id });
  } catch {
    /* swallow */
  }
  const label = candidate.name || candidate.project_dir?.split(/[\\/]/).pop() || candidate.id.slice(0, 8);
  return { kind: "prewarmed", sessionId: candidate.id, label };
}

/** Internal session-row shape used by /list and /session. */
export interface TgSessionRow {
  id: string;
  name: string | null;
  project_dir: string | null;
  last_activity: Date | null;
}

async function listUserSessions(userId: string): Promise<TgSessionRow[]> {
  return await sql<TgSessionRow[]>`
    SELECT id, name, project_dir, last_activity
      FROM sessions
     WHERE user_id = ${userId} AND deleted_at IS NULL
     ORDER BY last_activity DESC NULLS LAST
     LIMIT 25
  `;
}

/**
 * Sentinel session id for the synthetic orchestrator row. Used ONLY when the
 * orchestrator is enabled but no orchestrator `sessions` row exists yet (e.g.
 * a brand-new user, supervisor never connected). Tapping `s:__orchestrator__`
 * triggers a launch (which creates the real row) instead of a set-default.
 */
export const ORCHESTRATOR_SENTINEL_ID = "__orchestrator__";

/**
 * Full session list for the inline-keyboard picker (no LIMIT 25 trim — the
 * picker paginates client-side via callback_data). Capped at 200 to keep the
 * single response bounded.
 *
 * Orchestrator visibility (orchestrator-as-default, 2026-05-29): the root
 * orchestrator is ALWAYS surfaced at the top so the user can tap-to-select it,
 * mirroring the web Sidebar position-0 pin:
 *   - A real (possibly offline / repo-less) orchestrator row is kept by
 *     `applySidebarParityFilter` (which exempts is_orchestrator from the
 *     offline+no-repo drop) and pinned to position 0.
 *   - When the orchestrator is enabled but NO orchestrator row exists yet, a
 *     synthetic placeholder row (id=ORCHESTRATOR_SENTINEL_ID) is prepended so
 *     even a repo-less / zero-session user can start in their root folder.
 */
export async function listUserSessionsForPicker(userId: string): Promise<PickerSessionRow[]> {
  const rows = await sql<{
    id: string;
    name: string | null;
    project_dir: string | null;
    status: string;
    repo_key: string | null;
    is_orchestrator: boolean | null;
    github_owner: string | null;
    github_repo: string | null;
    last_activity: Date | string | null;
  }[]>`
    SELECT id, name, project_dir, status, repo_key, is_orchestrator,
           github_owner, github_repo, last_activity
      FROM sessions
     WHERE user_id = ${userId} AND deleted_at IS NULL
     ORDER BY (status IN ('online','thinking')) DESC, last_activity DESC NULLS LAST
     LIMIT 200
  `;
  const mapped: PickerSessionRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    project_dir: r.project_dir,
    status: r.status,
    repo_key: r.repo_key,
    is_orchestrator: !!r.is_orchestrator,
    github_owner: r.github_owner,
    github_repo: r.github_repo,
    last_activity_ms: r.last_activity ? new Date(r.last_activity as any).getTime() : null,
  }));
  const filtered = applySidebarParityFilter(mapped);

  // If a real orchestrator row already survived the filter, we're done.
  if (filtered.some((s) => s.is_orchestrator)) return filtered;

  // No orchestrator row present — inject a synthetic placeholder when the
  // feature is enabled so the user can always reach their root folder.
  try {
    const { getOrchestratorState } = await import("../db/orchestrator-dal.ts");
    const prefs = await getOrchestratorState(userId);
    if (prefs.orchestrator_enabled && !prefs.orchestrator_disabled_explicitly) {
      const synthetic: PickerSessionRow = {
        id: ORCHESTRATOR_SENTINEL_ID,
        name: prefs.orchestrator_name || "Orchestrator",
        project_dir: null,
        status: "offline",
        repo_key: null,
        is_orchestrator: true,
        github_owner: null,
        github_repo: null,
        last_activity_ms: null,
      };
      // The synthetic row counts AGAINST the 200-row cap (not on top of it):
      // prepend then slice(0, 200) so a user already at the cap never gets 201
      // rows and the picker's "(X of N)" count stays consistent with the cap.
      return [synthetic, ...filtered].slice(0, 200);
    }
  } catch {
    /* swallow — fall back to the unmodified list */
  }
  return filtered;
}

/**
 * Build the `/list` reply as a (text, keyboard) pair. The webhook handler
 * sends this via `sendMessageWithKeyboard`. Returns `null` keyboard when the
 * user has zero sessions (plain text reply).
 */
export async function handleListPicker(opts: {
  user: TelegramUserRow;
  offset?: number;
}): Promise<{ text: string; keyboard: InlineKeyboard | null }> {
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const rows = await listUserSessionsForPicker(opts.user.id);
  if (rows.length === 0) {
    return {
      text: "No sessions found. Start one from the remo-code web UI first.",
      keyboard: null,
    };
  }
  const defaultId = opts.user.telegram_default_session_id;
  const text = renderPickerText({ total: rows.length, offset, defaultId, rows });
  const keyboard = buildSessionKeyboard({ rows, offset, defaultId });
  return { text, keyboard };
}

/** Re-export the page size so the webhook can validate paginate offsets. */
export { PAGE_SIZE };

function renderRelative(d: Date | null): string {
  if (!d) return "never";
  const ms = Date.now() - new Date(d).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function sessionLabel(s: TgSessionRow): string {
  const short = s.id.slice(0, 8);
  const name = s.name || s.project_dir?.split(/[\\/]/).pop() || "(unnamed)";
  return `${short}  ${name}  (${renderRelative(s.last_activity)})`;
}

export async function handleList(opts: { user: TelegramUserRow }): Promise<{ reply: string }> {
  const rows = await listUserSessions(opts.user.id);
  if (rows.length === 0) {
    return { reply: "No sessions found. Start one from the remo-code web UI first." };
  }
  const lines = ["Your sessions (newest first):", ""];
  for (const r of rows) lines.push(sessionLabel(r));
  if (opts.user.telegram_default_session_id) {
    lines.push("");
    lines.push(`Default: ${opts.user.telegram_default_session_id.slice(0, 8)}`);
  } else {
    lines.push("");
    lines.push("No default set — /session <id> to pick one.");
  }
  return { reply: lines.join("\n") };
}

export async function handleSession(opts: {
  user: TelegramUserRow;
  arg: string | null;
}): Promise<{ reply: string }> {
  if (!opts.arg) {
    const rows = await listUserSessions(opts.user.id);
    const lines = [
      "Usage: /session <id-prefix>. Tip: /list shows tap-to-pick buttons.",
      "",
      "Recent sessions:",
      "",
    ];
    for (const r of rows.slice(0, 10)) lines.push(sessionLabel(r));
    return { reply: lines.join("\n") };
  }
  const arg = opts.arg.trim();
  const rows = await listUserSessions(opts.user.id);
  // Match by id-prefix (>=4 chars to be unambiguous-ish) or exact id, or project_dir basename.
  const matches = rows.filter((r) => {
    if (r.id === arg) return true;
    if (arg.length >= 4 && r.id.startsWith(arg)) return true;
    const base = r.project_dir?.split(/[\\/]/).pop();
    if (base && base.toLowerCase() === arg.toLowerCase()) return true;
    return false;
  });
  if (matches.length === 0) {
    return { reply: `No session matched "${arg}". Use /list to see your sessions.` };
  }
  if (matches.length > 1) {
    const lines = [`Ambiguous: ${matches.length} sessions matched "${arg}":`, ""];
    for (const m of matches) lines.push(sessionLabel(m));
    lines.push("");
    lines.push("Use the full id (first 8+ chars).");
    return { reply: lines.join("\n") };
  }
  const pick = matches[0]!;
  // Explicit user choice — sticks until they switch, and is never overridden by
  // orchestrator-as-default resolution.
  await setTelegramDefaultSession(opts.user.id, pick.id, true);
  return { reply: `Default session set to ${pick.id.slice(0, 8)} (${pick.name || pick.project_dir || "unnamed"}).` };
}

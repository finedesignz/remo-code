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

export type ParsedCommand =
  | { kind: "start"; arg: string }
  | { kind: "session"; arg: string | null }
  | { kind: "list" }
  | { kind: "help" }
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
    default:
      return { kind: "unknown", raw: name };
  }
}

export const HELP_TEXT = [
  "Remo Code Telegram bridge — commands:",
  "",
  "/list — list your Claude Code sessions",
  "/session <id> — set your default session (use the short id from /list)",
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
    const lines = ["Usage: /session <id-prefix>. Your sessions:", ""];
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
  await setTelegramDefaultSession(opts.user.id, pick.id);
  return { reply: `Default session set to ${pick.id.slice(0, 8)} (${pick.name || pick.project_dir || "unnamed"}).` };
}

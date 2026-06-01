/**
 * Phase 20 plan 03 — fail-closed permission surfacing.
 *
 * Attaches a consumer to a session's transcript source (via the manager) that
 * runs the fail-closed permission detector on each entry and, for a clean
 * pending, surfaces it via the EXISTING inline approvals UX — one button per
 * enumerated option, keyed by `(sessionId, requestId)` with per-user
 * authorization (the multi-user-clobber fix is reused verbatim).
 *
 * The pending is recorded with its keystroke-injection context (cliKind + shape
 * + options) so the webhook callback can compute the literal PTY bytes for the
 * chosen option (R-TG-08). A scrape-mode source never emits a permission_request,
 * so this consumer simply never surfaces a prompt for a scrape-mode session
 * (fail-closed at the source — T-20-03).
 */

import { getUsersWithTelegramDefaultSession, getTranscriptOpenContext } from "../db/dal.ts";
import { subscribeToSessionTranscript } from "./transcript/manager.ts";
import { detectPending, type DetectedPending } from "./transcript/permission-detector.ts";
import type { CliKind } from "./transcript/types.ts";
import {
  rememberPendingPrompt,
  permissionCallbackData,
  optionCallbackData,
} from "./approvals.ts";
import { sendMessageWithKeyboard, escapeMarkdownV2 } from "./client.ts";

const unsubs = new Map<string, () => void>();
// Per-session cliKind cache so the consumer can stamp the pending's injection
// context without re-querying the DB on every entry.
const cliKindBySession = new Map<string, CliKind>();

let resolveCtx: typeof getTranscriptOpenContext = getTranscriptOpenContext;

/** Test-only — inject a context resolver (cliKind source). */
export function _setSurfacingContextResolverForTests(fn: typeof getTranscriptOpenContext | null): void {
  resolveCtx = fn ?? getTranscriptOpenContext;
}

/** Best-effort one-line preview of a tool input for the approval prompt. */
function previewToolInput(input: unknown): string {
  if (input == null) return "";
  try {
    const obj = input as Record<string, unknown>;
    const cmd = obj.command ?? obj.file_path ?? obj.path ?? obj.url;
    if (typeof cmd === "string") return cmd.length > 200 ? cmd.slice(0, 199) + "…" : cmd;
    const json = JSON.stringify(input);
    return json.length > 200 ? json.slice(0, 199) + "…" : json;
  } catch {
    return "";
  }
}

/**
 * Build the inline keyboard for a detected pending. A boolean permission (the
 * canonical approve/deny option ids) renders Approve/Deny; an enumerated set
 * renders one button per option carrying `po:<idx>:<requestId>`.
 */
function keyboardFor(pending: DetectedPending) {
  const isBoolean =
    pending.options.length === 2 &&
    pending.options.some((o) => o.id === "approve") &&
    pending.options.some((o) => o.id === "deny");
  if (isBoolean) {
    return [
      [
        { text: "✅ Approve", callback_data: permissionCallbackData(pending.requestId, "approve") },
        { text: "🚫 Deny", callback_data: permissionCallbackData(pending.requestId, "deny") },
      ],
    ];
  }
  // Enumerated options — one button per option (index-keyed callback_data).
  return pending.options.map((o, i) => [
    { text: o.label.length > 60 ? o.label.slice(0, 59) + "…" : o.label, callback_data: optionCallbackData(pending.requestId, i) },
  ]);
}

/** Surface one detected pending to every authorized telegram-default user. */
async function surfacePending(pending: DetectedPending, cliKind: CliKind): Promise<void> {
  let users: Array<{ id: string; telegram_chat_id: string | number }>;
  try {
    users = await getUsersWithTelegramDefaultSession(pending.sessionId);
  } catch (err: any) {
    console.warn(`[permission-surfacing] DAL lookup failed session=${pending.sessionId}: ${err?.message ?? err}`);
    return;
  }
  if (users.length === 0) return;

  const preview = pending.shape === "permission" ? previewToolInput(pending.toolInput) : "";
  const head =
    pending.shape === "permission"
      ? `🔐 Approval needed — *${escapeMarkdownV2(pending.toolName)}*`
      : `❓ *${escapeMarkdownV2(pending.toolName)}*`;
  const text = head + (preview ? "\n\n```\n" + escapeMarkdownV2(preview) + "\n```" : "");
  const keyboard = keyboardFor(pending);

  for (const u of users) {
    const chatId = u.telegram_chat_id;
    if (chatId === null || chatId === undefined) continue;
    let sent: { message_id: number } | void;
    try {
      try {
        sent = await sendMessageWithKeyboard(chatId as number | string, text, keyboard, { parse_mode: "MarkdownV2" });
      } catch (mdErr: any) {
        if (mdErr?.status === 400) {
          sent = await sendMessageWithKeyboard(chatId as number | string, text, keyboard);
        } else {
          throw mdErr;
        }
      }
      rememberPendingPrompt(pending.sessionId, pending.requestId, {
        sessionId: pending.sessionId,
        userId: u.id,
        chatId,
        messageId: sent?.message_id ?? 0,
        toolName: pending.toolName,
        createdAtMs: Date.now(),
        injection: { cliKind, shape: pending.shape, options: pending.options.map((o) => ({ id: o.id, label: o.label })) },
      });
    } catch (err: any) {
      console.warn(
        `[permission-surfacing] prompt send failed session=${pending.sessionId} req=${pending.requestId}: ${err?.message ?? err}`,
      );
    }
  }
}

/**
 * Begin surfacing permissions for a session: resolve its cliKind, attach a
 * detector consumer to the shared transcript source. Idempotent per session.
 */
export async function startPermissionSurfacing(sessionId: string): Promise<void> {
  if (unsubs.has(sessionId)) return;
  let cliKind: CliKind = "claude";
  try {
    const ctx = await resolveCtx(sessionId);
    if (ctx) cliKind = ctx.cliKind;
  } catch {
    /* default claude */
  }
  cliKindBySession.set(sessionId, cliKind);

  const unsub = await subscribeToSessionTranscript(sessionId, (entry) => {
    const pending = detectPending(entry);
    if (!pending) return; // fail-closed: nothing surfaced for ambiguous/non-prompt
    void surfacePending(pending, cliKindBySession.get(sessionId) ?? "claude");
  });
  if (!unsub) {
    cliKindBySession.delete(sessionId);
    return;
  }
  if (unsubs.has(sessionId)) {
    unsub();
    return;
  }
  unsubs.set(sessionId, unsub);
}

/** Stop surfacing permissions for a session. */
export function stopPermissionSurfacing(sessionId: string): void {
  const unsub = unsubs.get(sessionId);
  if (unsub) {
    unsub();
    unsubs.delete(sessionId);
  }
  cliKindBySession.delete(sessionId);
}

/** Test-only — clear all surfacing subscriptions. */
export function _resetPermissionSurfacingForTests(): void {
  for (const unsub of unsubs.values()) {
    try {
      unsub();
    } catch {
      /* ignore */
    }
  }
  unsubs.clear();
  cliKindBySession.clear();
}

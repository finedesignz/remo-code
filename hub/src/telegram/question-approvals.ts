/**
 * Telegram inline-question registry + callback_data codec.
 *
 * When a runner raises a `user_question` (AskUserQuestion / elicitation), the
 * Telegram bridge sends an inline keyboard with ONE BUTTON PER OPTION and records
 * the prompt context here. The webhook's callback_query handler looks the entry
 * up when the user taps a button, then forwards a `question_response` (with the
 * chosen option LABEL as the answer) onto the session's agent socket.
 *
 * Why a SHORT-TOKEN map instead of `qa:<sessionId>:<requestId>:<optionIndex>`:
 * Telegram caps callback_data at 64 bytes. A session UUID + request UUID +
 * option index easily blows past that. So each rendered button gets a short
 * opaque token (`qa:<token>`); the token resolves to
 * {sessionId, requestId, label, authorized userIds + their chat/message}. This
 * mirrors `approvals.ts` (which keys by requestId because permission has only
 * two fixed buttons; questions have N option buttons so we mint a token per
 * (prompt,user,option) to keep the wire tiny and carry the chosen label).
 *
 * Multi-select (v1): each tap is treated as a single selected answer. The
 * runner gets exactly one `question_response` with that option's label. A
 * richer "tap several then Done" UX is deferred; the web client already
 * supports true multi-select.
 *
 * Authorization: the entry records which userId may resolve which token, so a
 * foreign chat tapping a guessed/stale token finds nothing (or one bound to
 * another user). Entries expire on a TTL and are removed once resolved.
 */

export interface QuestionPromptContext {
  sessionId: string;
  requestId: string;
  /** userId authorized to resolve this token. */
  userId: string;
  chatId: number | string;
  /** Telegram message_id of the prompt, so we can edit it after a decision. */
  messageId: number;
  /** The option label this token answers with. */
  label: string;
  question: string;
  createdAtMs: number;
}

/** Question prompts expire after 10 minutes (matches permission prompt TTL). */
export const QUESTION_PROMPT_TTL_MS = 10 * 60 * 1000;

const byToken = new Map<string, QuestionPromptContext>();

/**
 * Track every token minted for one (sessionId, requestId) so that resolving ANY
 * token (one option tap) invalidates the WHOLE prompt — a second tap (different
 * option, or another authorized user) finds nothing. Keyed `${sessionId} ${requestId}`.
 */
const tokensByPrompt = new Map<string, Set<string>>();

function promptKey(sessionId: string, requestId: string): string {
  return `${sessionId} ${requestId}`;
}

let tokenSeq = 0;

/** Mint a short, collision-free token (≤ a few chars + counter). */
function mintToken(): string {
  // base36 counter + 3 random base36 chars → short and unique within a process.
  tokenSeq = (tokenSeq + 1) % 0xffffffff;
  const rand = Math.floor(Math.random() * 46656).toString(36); // up to 3 chars
  return tokenSeq.toString(36) + rand;
}

function prune(now: number): void {
  for (const [tok, ctx] of byToken) {
    if (now - ctx.createdAtMs > QUESTION_PROMPT_TTL_MS) {
      byToken.delete(tok);
      const pk = promptKey(ctx.sessionId, ctx.requestId);
      tokensByPrompt.get(pk)?.delete(tok);
      if (tokensByPrompt.get(pk)?.size === 0) tokensByPrompt.delete(pk);
    }
  }
}

/**
 * Register a single option button for a prompt. Returns the token to embed in
 * callback_data (`qa:<token>`). Prunes stale entries first.
 */
export function rememberQuestionOption(ctx: Omit<QuestionPromptContext, "createdAtMs"> & { createdAtMs?: number }): string {
  prune(Date.now());
  const token = mintToken();
  const full: QuestionPromptContext = { ...ctx, createdAtMs: ctx.createdAtMs ?? Date.now() };
  byToken.set(token, full);
  const pk = promptKey(full.sessionId, full.requestId);
  let set = tokensByPrompt.get(pk);
  if (!set) {
    set = new Set();
    tokensByPrompt.set(pk, set);
  }
  set.add(token);
  return token;
}

/**
 * Look up + RESOLVE a question option by token for a tapping `userId`. Returns
 * the chosen context, or null if the token is unknown / stale / not owned by
 * this user. Resolving invalidates EVERY token for the same (sessionId,
 * requestId) so the prompt is answered exactly once regardless of which option
 * or which authorized user taps.
 */
export function takeQuestionOption(token: string, userId: string): QuestionPromptContext | null {
  const now = Date.now();
  const ctx = byToken.get(token);
  if (!ctx) return null;
  if (ctx.userId !== userId) return null; // not authorized for this token
  // Invalidate the whole prompt (all its option tokens).
  const pk = promptKey(ctx.sessionId, ctx.requestId);
  const tokens = tokensByPrompt.get(pk);
  if (tokens) {
    for (const t of tokens) byToken.delete(t);
    tokensByPrompt.delete(pk);
  } else {
    byToken.delete(token);
  }
  if (now - ctx.createdAtMs > QUESTION_PROMPT_TTL_MS) return null;
  return ctx;
}

/** Test-only — clear the registry. */
export function _resetQuestionPromptsForTests(): void {
  byToken.clear();
  tokensByPrompt.clear();
  tokenSeq = 0;
}

// ── callback_data encoding (≤64 bytes) ──────────────────────────────────────
// "qa:<token>" — answer with the option bound to <token>.

const QUESTION_PREFIX = "qa:";

export function questionCallbackData(token: string): string {
  return QUESTION_PREFIX + token;
}

export type QuestionCallback = { token: string };

/** Parse a question callback_data string, or null if it isn't one. */
export function parseQuestionCallback(data: string | undefined | null): QuestionCallback | null {
  if (!data) return null;
  if (data.length > 64) return null; // Telegram hard limit; defensive.
  if (!data.startsWith(QUESTION_PREFIX)) return null;
  const token = data.slice(QUESTION_PREFIX.length);
  if (token.length === 0 || token.length > 60) return null;
  return { token };
}
